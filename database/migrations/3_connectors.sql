-- ============================================================================
-- MIGRATION 3 — ACCOUNTING CONNECTORS
-- ----------------------------------------------------------------------------
-- Somewhere to record which finance system a customer uses, hold the
-- credentials safely, and remember what has already been posted.
--
-- That last part matters more than it sounds. Posting the same payroll journal
-- into someone's accounts twice doubles their wage cost for the month and is
-- painful to unpick, so the record of what was sent is a unique constraint
-- rather than a convention.
--
-- Idempotent: safe to re-run.
-- ============================================================================

SET search_path = payroll, public;

DO $$ BEGIN
    CREATE TYPE connection_status AS ENUM
        ('not_connected','pending_authorisation','connected','expired','revoked','error');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE post_status AS ENUM ('queued','sent','confirmed','failed','superseded');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------- accounts --
-- The customer's own chart of accounts. Defaults are Sage-style codes, but a
-- council's ledger looks nothing like a small company's, so every code is
-- overridable. Posting to the wrong nominal code is worse than not posting.
CREATE TABLE IF NOT EXISTS account_mappings (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    purpose      text NOT NULL UNIQUE,     -- grossPay, employerNI, payeControl, ...
    code         text NOT NULL,
    name         text NOT NULL,
    account_type text NOT NULL,            -- expense | liability
    updated_at   timestamptz NOT NULL DEFAULT now(),
    updated_by   text,
    CONSTRAINT account_type_valid CHECK (account_type IN ('expense','liability'))
);

-- ------------------------------------------------------------- connections --
CREATE TABLE IF NOT EXISTS connections (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    provider         text NOT NULL UNIQUE,          -- xero | sage50 | manual | ...
    status           connection_status NOT NULL DEFAULT 'not_connected',

    -- Tokens are encrypted with the tenant's own key. The key itself lives in
    -- KMS; only the reference is stored here.
    credentials_enc  bytea,
    encryption_key_id text,

    external_org_id  text,                          -- the tenant id at the provider
    external_org_name text,
    scopes           text[],

    connected_at     timestamptz,
    connected_by     text,
    expires_at       timestamptz,
    last_used_at     timestamptz,
    last_error       text,

    -- Off by default. A connector that starts posting the moment it is
    -- authorised is a surprise nobody wants in their ledger.
    auto_post        boolean NOT NULL DEFAULT false,

    created_at       timestamptz NOT NULL DEFAULT now()
);

-- OAuth state, short-lived. Guards against a forged callback being accepted.
CREATE TABLE IF NOT EXISTS connection_authorisations (
    state         text PRIMARY KEY,
    provider      text NOT NULL,
    started_by    text NOT NULL,
    redirect_uri  text NOT NULL,
    code_verifier text,
    created_at    timestamptz NOT NULL DEFAULT now(),
    expires_at    timestamptz NOT NULL DEFAULT now() + interval '15 minutes',
    consumed_at   timestamptz
);

CREATE INDEX IF NOT EXISTS connection_auth_expiry_idx
    ON connection_authorisations(expires_at) WHERE consumed_at IS NULL;

-- --------------------------------------------------------------- postings --
-- What has been sent where. The unique index below is the double-post guard.
CREATE TABLE IF NOT EXISTS journal_postings (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    pay_run_id     uuid NOT NULL REFERENCES pay_runs(id) ON DELETE RESTRICT,
    provider       text NOT NULL,
    reference      text NOT NULL,                 -- PAY-2026-27-P05
    status         post_status NOT NULL DEFAULT 'queued',

    total_debit    numeric(14,2) NOT NULL,
    total_credit   numeric(14,2) NOT NULL,
    line_count     integer NOT NULL,
    payload_hash   text NOT NULL,                 -- detects a changed journal

    external_id    text,                          -- the id at the provider
    external_url   text,
    attempts       integer NOT NULL DEFAULT 0,
    last_error     text,
    posted_at      timestamptz,
    posted_by      text,
    created_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT posting_balances CHECK (total_debit = total_credit),
    CONSTRAINT posting_has_lines CHECK (line_count > 0)
);

-- One live posting per run per provider. A superseded posting is kept for the
-- audit trail but no longer blocks a corrected one.
CREATE UNIQUE INDEX IF NOT EXISTS journal_postings_one_live
    ON journal_postings(pay_run_id, provider)
    WHERE status IN ('queued','sent','confirmed');

CREATE INDEX IF NOT EXISTS journal_postings_run_idx ON journal_postings(pay_run_id);

-- A journal that does not balance must never reach an accounting system, and
-- must not even be recorded as an intention to send one.
CREATE OR REPLACE FUNCTION reject_unbalanced_posting() RETURNS trigger AS $$
BEGIN
    IF NEW.total_debit <> NEW.total_credit THEN
        RAISE EXCEPTION 'refusing to record a posting that does not balance: % against %',
            NEW.total_debit, NEW.total_credit USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS journal_postings_must_balance ON journal_postings;
CREATE TRIGGER journal_postings_must_balance
    BEFORE INSERT OR UPDATE ON journal_postings
    FOR EACH ROW EXECUTE FUNCTION reject_unbalanced_posting();

-- Credentials are readable only by the service that posts, in the same way
-- bank details are readable only by the service that pays.
DO $$ BEGIN
    REVOKE ALL ON connections FROM hrp_readonly;
    GRANT SELECT (id, provider, status, external_org_name, connected_at, auto_post, last_error)
        ON connections TO hrp_readonly;
EXCEPTION WHEN undefined_object THEN NULL; END $$;

INSERT INTO schema_migrations(version, description)
VALUES (3, 'accounting connectors')
ON CONFLICT (version) DO NOTHING;
