-- ============================================================================
-- MIGRATION 4 — the audit trail must not block erasure
-- ----------------------------------------------------------------------------
-- audit_events referenced users with the default RESTRICT, so any user with
-- audit history could never be deleted. Under UK GDPR a person can require
-- erasure, and an audit table that prevents it is a compliance problem rather
-- than a control.
--
-- The event survives. The link to the person does not. An email captured at
-- the time keeps the trail readable afterwards.
--
-- Applies to the REGISTRY database.
-- ============================================================================

ALTER TABLE registry.audit_events
    ADD COLUMN IF NOT EXISTS actor_email citext;

-- ---------------------------------------------------------------------------
-- Append-only, with one precise exception.
--
-- ON DELETE SET NULL performs an UPDATE, so a blanket append-only trigger and
-- an erasable user are in direct conflict: the trigger blocks the very action
-- that makes erasure possible.
--
-- The exception is deliberately narrow. An update is permitted ONLY when it
-- severs the link to a deleted person and changes nothing else. Any attempt to
-- alter what happened, when, or by whom is still refused.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION registry.deny_audit_change() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'audit_events is append-only' USING ERRCODE = 'insufficient_privilege';
    END IF;

    IF NEW.id             IS DISTINCT FROM OLD.id
    OR NEW.at             IS DISTINCT FROM OLD.at
    OR NEW.action         IS DISTINCT FROM OLD.action
    OR NEW.detail         IS DISTINCT FROM OLD.detail
    OR NEW.actor_ip       IS DISTINCT FROM OLD.actor_ip
    OR NEW.actor_email    IS DISTINCT FROM OLD.actor_email
    OR (NEW.actor_user_id   IS NOT NULL AND NEW.actor_user_id   IS DISTINCT FROM OLD.actor_user_id)
    OR (NEW.organisation_id IS NOT NULL AND NEW.organisation_id IS DISTINCT FROM OLD.organisation_id)
    THEN
        RAISE EXCEPTION 'audit_events is append-only; only the link to an erased subject may be cleared'
            USING ERRCODE = 'insufficient_privilege';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_events_append_only ON registry.audit_events;
CREATE TRIGGER audit_events_append_only
    BEFORE UPDATE OR DELETE ON registry.audit_events
    FOR EACH ROW EXECUTE FUNCTION registry.deny_audit_change();

DO $$
BEGIN
    ALTER TABLE registry.audit_events DROP CONSTRAINT IF EXISTS audit_events_actor_user_id_fkey;
    ALTER TABLE registry.audit_events
        ADD CONSTRAINT audit_events_actor_user_id_fkey
        FOREIGN KEY (actor_user_id) REFERENCES registry.users(id) ON DELETE SET NULL;

    ALTER TABLE registry.audit_events DROP CONSTRAINT IF EXISTS audit_events_organisation_id_fkey;
    ALTER TABLE registry.audit_events
        ADD CONSTRAINT audit_events_organisation_id_fkey
        FOREIGN KEY (organisation_id) REFERENCES registry.organisations(id) ON DELETE SET NULL;
END $$;

-- Backfill the email where the user still exists, so historic events stay
-- readable once those users are eventually erased.
--
-- The append-only trigger blocks this, correctly — it exists to stop anyone
-- rewriting history. A schema migration is the one legitimate exception, so
-- it is disabled for the statement and restored immediately, inside a
-- transaction so it cannot be left off.
BEGIN;
ALTER TABLE registry.audit_events DISABLE TRIGGER audit_events_append_only;

UPDATE registry.audit_events a
   SET actor_email = u.email
  FROM registry.users u
 WHERE a.actor_user_id = u.id AND a.actor_email IS NULL;

ALTER TABLE registry.audit_events ENABLE TRIGGER audit_events_append_only;
COMMIT;

-- Confirm it is back on. A migration that silently leaves the audit table
-- writable would be worse than one that fails.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_trigger
         WHERE tgname = 'audit_events_append_only' AND tgenabled <> 'D')
    THEN
        RAISE EXCEPTION 'the append-only trigger was left disabled';
    END IF;
END $$;
