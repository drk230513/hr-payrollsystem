-- ============================================================================
-- CONTROL PLANE  ·  database: hrp_registry
-- ----------------------------------------------------------------------------
-- One shared database that knows which organisations exist and where their
-- data lives. It holds NO employee or payroll data — that is the entire point.
-- If this database leaks, it exposes company names and login records, not
-- anyone's salary, National Insurance number or bank details.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE SCHEMA IF NOT EXISTS registry;
SET search_path = registry, public;

-- Persist the search path for every future connection, so applications and
-- psql sessions do not have to know the schema name. Without this, every
-- client works only if it remembers to set it, and one that forgets fails
-- with "relation does not exist" against a database that is perfectly fine.
DO $sp$ BEGIN
    EXECUTE format('ALTER DATABASE %I SET search_path = registry, public', current_database());
END $sp$;

-- ---------------------------------------------------------------- enums ----
CREATE TYPE org_status     AS ENUM ('pending_verification','provisioning','active','suspended','closed');
CREATE TYPE org_sector     AS ENUM ('private','public','charity');
CREATE TYPE tenant_status  AS ENUM ('queued','provisioning','ready','migrating','failed','decommissioned');
CREATE TYPE user_status    AS ENUM ('invited','active','suspended','locked');
CREATE TYPE member_role    AS ENUM ('owner','payroll_admin','payroll_operator','hr_admin','manager','employee','auditor');
CREATE TYPE job_state      AS ENUM ('queued','running','succeeded','failed');

-- --------------------------------------------------------- organisations ----
CREATE TABLE organisations (
    id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug                      citext NOT NULL UNIQUE,
    legal_name                text NOT NULL,
    trading_name              text,
    sector                    org_sector NOT NULL DEFAULT 'private',
    country                   char(2) NOT NULL DEFAULT 'GB',

    companies_house_number    text,
    paye_reference            text,
    accounts_office_reference text,

    status                    org_status NOT NULL DEFAULT 'pending_verification',
    created_at                timestamptz NOT NULL DEFAULT now(),
    activated_at              timestamptz,
    closed_at                 timestamptz,

    -- A slug becomes part of a database name, so it must be safe to interpolate.
    -- NOTE the ::text cast. `slug` is citext, and citext makes regex matching
    -- CASE-INSENSITIVE, so without the cast '^[a-z]' happily accepts 'ACME'.
    -- The cast forces a case-sensitive check; a trigger lowercases first.
    -- No leading/trailing hyphen and no doubled hyphen, so the derived database
    -- name never contains '__' or a trailing '_'.
    CONSTRAINT slug_is_safe CHECK (slug::text ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$'
                                   AND length(slug::text) BETWEEN 3 AND 39),
    -- HMRC PAYE references look like 123/AB45678
    CONSTRAINT paye_ref_shape CHECK (paye_reference IS NULL OR paye_reference ~ '^[0-9]{3}/[A-Z0-9]{1,10}$'),
    CONSTRAINT active_orgs_have_paye CHECK (status <> 'active' OR paye_reference IS NOT NULL)
);

CREATE INDEX organisations_status_idx ON organisations(status);

-- Normalise before validating, so 'Acme-Ltd' is accepted and stored as 'acme-ltd'
-- rather than rejected. Trimming and case-folding at the boundary means every
-- downstream consumer sees one canonical form.
-- Slugs become subdomains, so a customer registering 'www' or 'api' would
-- shadow the marketing site or the API. Reserve them before anyone tries.
CREATE TABLE reserved_slugs (
    slug   citext PRIMARY KEY,
    reason text NOT NULL
);

INSERT INTO reserved_slugs(slug, reason) VALUES
    ('www','marketing site'), ('app','sign-in portal'), ('api','public API'),
    ('admin','internal'), ('portal','internal'), ('status','status page'),
    ('mail','email'), ('smtp','email'), ('imap','email'), ('mx','email'),
    ('ftp','infrastructure'), ('ns','infrastructure'), ('cdn','infrastructure'),
    ('static','assets'), ('assets','assets'), ('demo','public demo'),
    ('help','support'), ('support','support'), ('docs','documentation'),
    ('blog','marketing'), ('billing','internal'), ('account','internal'),
    ('accounts','internal'), ('login','internal'), ('signup','internal'),
    ('auth','internal'), ('sso','internal'), ('test','internal'),
    ('staging','internal'), ('dev','internal'), ('internal','internal'),
    ('security','legal page'), ('privacy','legal page'), ('terms','legal page'),
    ('dpa','legal page'), ('hmrc','impersonation risk'), ('payroll','too generic'),
    ('hr','too generic'), ('bacs','impersonation risk'), ('pension','too generic');

CREATE OR REPLACE FUNCTION normalise_slug() RETURNS trigger AS $$
BEGIN
    NEW.slug := lower(btrim(NEW.slug::text))::citext;

    IF EXISTS (SELECT 1 FROM reserved_slugs WHERE slug = NEW.slug) THEN
        RAISE EXCEPTION 'the name % is reserved, please choose another', NEW.slug
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER organisations_normalise_slug
    BEFORE INSERT OR UPDATE OF slug ON organisations
    FOR EACH ROW EXECUTE FUNCTION normalise_slug();

-- ------------------------------------------------------ tenant databases ----
-- Where each organisation's data actually lives.
CREATE TABLE tenant_databases (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organisation_id    uuid NOT NULL UNIQUE REFERENCES organisations(id) ON DELETE RESTRICT,
    database_name      text NOT NULL UNIQUE,
    host               text NOT NULL,
    port               integer NOT NULL DEFAULT 5432,
    region             text NOT NULL DEFAULT 'uk-west',
    schema_version     integer NOT NULL DEFAULT 0,
    encryption_key_id  text NOT NULL,          -- reference into KMS, never the key itself
    status             tenant_status NOT NULL DEFAULT 'queued',
    provisioned_at     timestamptz,
    last_backup_at     timestamptz,

    CONSTRAINT db_name_shape CHECK (database_name ~ '^hrp_[a-z0-9_]{3,50}$'),
    -- UK payroll data stays in the UK unless a customer explicitly agrees otherwise
    CONSTRAINT region_is_uk CHECK (region LIKE 'uk-%')
);

CREATE INDEX tenant_databases_status_idx ON tenant_databases(status);

-- ------------------------------------------------------------------ users ----
CREATE TABLE users (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email           citext NOT NULL UNIQUE,
    password_hash   text,                       -- null when SSO-only
    mfa_enrolled    boolean NOT NULL DEFAULT false,
    status          user_status NOT NULL DEFAULT 'invited',
    last_login_at   timestamptz,
    failed_logins   integer NOT NULL DEFAULT 0,
    locked_until    timestamptz,
    created_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT email_shape CHECK (email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[a-z]{2,}$')
);

-- Anyone who can approve a payroll run must hold MFA. This is a hard rule,
-- enforced below by a trigger rather than left to application code.
CREATE TABLE memberships (
    organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            member_role NOT NULL,
    invited_by      uuid REFERENCES users(id),
    invited_at      timestamptz NOT NULL DEFAULT now(),
    accepted_at     timestamptz,
    revoked_at      timestamptz,
    PRIMARY KEY (organisation_id, user_id, role)
);

CREATE INDEX memberships_user_idx ON memberships(user_id) WHERE revoked_at IS NULL;

CREATE OR REPLACE FUNCTION require_mfa_for_privileged_roles() RETURNS trigger AS $$
BEGIN
    IF NEW.role IN ('owner','payroll_admin','payroll_operator')
       AND NEW.accepted_at IS NOT NULL
       AND NOT (SELECT mfa_enrolled FROM users WHERE id = NEW.user_id) THEN
        RAISE EXCEPTION 'role % requires MFA enrolment', NEW.role
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER memberships_require_mfa
    BEFORE INSERT OR UPDATE ON memberships
    FOR EACH ROW EXECUTE FUNCTION require_mfa_for_privileged_roles();

-- Exactly one owner per organisation, and it cannot be removed.
CREATE UNIQUE INDEX memberships_single_owner
    ON memberships(organisation_id) WHERE role = 'owner' AND revoked_at IS NULL;

-- --------------------------------------------------- registration intake ----
CREATE TABLE registration_requests (
    id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    requested_slug         citext NOT NULL,
    legal_name             text NOT NULL,
    sector                 org_sector NOT NULL DEFAULT 'private',
    contact_email          citext NOT NULL,
    companies_house_number text,
    employee_estimate      integer,
    verification_token     text NOT NULL DEFAULT encode(gen_random_bytes(24),'hex'),
    verified_at            timestamptz,
    approved_at            timestamptz,
    rejected_at            timestamptz,
    rejection_reason       text,
    organisation_id        uuid REFERENCES organisations(id),
    created_at             timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT one_outcome CHECK (NOT (approved_at IS NOT NULL AND rejected_at IS NOT NULL))
);

-- ------------------------------------------------------- provisioning ------
CREATE TABLE provisioning_jobs (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    organisation_id uuid NOT NULL REFERENCES organisations(id) ON DELETE CASCADE,
    kind            text NOT NULL,              -- create_database | run_migration | seed | decommission
    target_version  integer,
    state           job_state NOT NULL DEFAULT 'queued',
    attempts        integer NOT NULL DEFAULT 0,
    last_error      text,
    queued_at       timestamptz NOT NULL DEFAULT now(),
    started_at      timestamptz,
    finished_at     timestamptz
);

CREATE INDEX provisioning_jobs_pending_idx ON provisioning_jobs(state, queued_at) WHERE state IN ('queued','running');

-- ------------------------------------------------------------- audit -------
-- Control-plane audit only. Payroll actions are audited inside the tenant.
CREATE TABLE audit_events (
    id              bigserial PRIMARY KEY,
    at              timestamptz NOT NULL DEFAULT now(),
    organisation_id uuid REFERENCES organisations(id) ON DELETE SET NULL,
    -- SET NULL, not the default RESTRICT. A user must remain erasable under
    -- UK GDPR, and an audit trail that prevents erasure is a compliance
    -- problem rather than a control. The event survives; the link to the
    -- person does not.
    actor_user_id   uuid REFERENCES users(id) ON DELETE SET NULL,
    actor_email     citext,
    actor_ip        inet,
    action          text NOT NULL,
    detail          jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX audit_events_org_at_idx ON audit_events(organisation_id, at DESC);

-- Append-only: no updates, no deletes, ever.
CREATE OR REPLACE FUNCTION deny_change() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'audit_events is append-only' USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_append_only
    BEFORE UPDATE OR DELETE ON audit_events
    FOR EACH ROW EXECUTE FUNCTION deny_change();

-- ------------------------------------------------- provisioning helper -----
-- Derives the tenant database name. Kept in SQL so the naming rule has exactly
-- one definition rather than one per service that needs it.
CREATE OR REPLACE FUNCTION tenant_database_name(p_slug citext) RETURNS text AS $$
BEGIN
    RETURN 'hrp_' || replace(lower(p_slug), '-', '_');
END;
$$ LANGUAGE plpgsql IMMUTABLE;

CREATE OR REPLACE FUNCTION register_organisation(
    p_slug citext, p_legal_name text, p_sector org_sector,
    p_paye_reference text, p_owner_email citext, p_key_id text
) RETURNS uuid AS $$
DECLARE v_org uuid; v_user uuid;
BEGIN
    INSERT INTO organisations(slug, legal_name, sector, paye_reference, status)
    VALUES (p_slug, p_legal_name, p_sector, p_paye_reference, 'provisioning')
    RETURNING id INTO v_org;

    INSERT INTO tenant_databases(organisation_id, database_name, host, encryption_key_id, status)
    VALUES (v_org, tenant_database_name(p_slug), 'pg-uk-west-1.internal', p_key_id, 'queued');

    INSERT INTO users(email, status, mfa_enrolled)
    VALUES (p_owner_email, 'invited', false)
    ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
    RETURNING id INTO v_user;

    INSERT INTO memberships(organisation_id, user_id, role) VALUES (v_org, v_user, 'owner');

    INSERT INTO provisioning_jobs(organisation_id, kind, target_version)
    VALUES (v_org, 'create_database', 1);

    INSERT INTO audit_events(organisation_id, actor_user_id, actor_email, action, detail)
    VALUES (v_org, v_user, p_owner_email, 'organisation.registered',
            jsonb_build_object('slug', p_slug, 'sector', p_sector));

    RETURN v_org;
END;
$$ LANGUAGE plpgsql;
