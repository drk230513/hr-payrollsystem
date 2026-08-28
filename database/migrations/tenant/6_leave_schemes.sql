-- ============================================================================
-- MIGRATION 6 — NAMED LEAVE SCHEMES
-- ----------------------------------------------------------------------------
-- Previously one entitlement sat on the employee record. A large employer runs
-- dozens of schemes: annual leave per contract type, TOIL, volunteering days,
-- study leave, jury service, unpaid leave, and a long tail of local
-- arrangements. Forty-six is not unusual.
--
-- Everything is held in HOURS. A day is not a day: someone on 43.75 hours over
-- five days and someone on 35 hours over five days both take "a day" and it
-- costs them different amounts. Holding days and converting at the end is how
-- part-time staff end up short-changed.
--
-- Safe to re-run.
-- ============================================================================

SET search_path = payroll, public;

DO $$ BEGIN
    CREATE TYPE leave_accrual AS ENUM ('upfront','monthly','irregular_hours');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS leave_schemes (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code          text NOT NULL UNIQUE,
    name          text NOT NULL,
    kind          text NOT NULL DEFAULT 'annual',

    -- Weeks are preferred: they convert correctly for any working pattern.
    -- Days are allowed for schemes genuinely expressed that way.
    entitlement_weeks numeric(5,2),
    entitlement_days  numeric(6,2),

    accrual       leave_accrual NOT NULL DEFAULT 'upfront',

    bank_holidays_included boolean NOT NULL DEFAULT true,
    bank_holiday_days      numeric(4,1) NOT NULL DEFAULT 8,

    paid                   boolean NOT NULL DEFAULT true,
    -- Whether this scheme helps satisfy the 5.6 week statutory minimum. A
    -- volunteering scheme offering two days does not, and must not be judged
    -- against it.
    counts_toward_statutory boolean NOT NULL DEFAULT true,

    carry_over_max_days           numeric(5,2) NOT NULL DEFAULT 0,
    carry_over_expires_after_months integer NOT NULL DEFAULT 3,

    pro_rata_for_part_year boolean NOT NULL DEFAULT true,
    requires_approval      boolean NOT NULL DEFAULT true,
    minimum_notice_days    integer NOT NULL DEFAULT 0,
    max_consecutive_days   integer,
    allow_negative_balance boolean NOT NULL DEFAULT false,

    active        boolean NOT NULL DEFAULT true,
    created_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT entitlement_expressed_once CHECK (
        accrual = 'irregular_hours'
        OR entitlement_weeks IS NOT NULL
        OR entitlement_days IS NOT NULL),
    CONSTRAINT entitlement_not_negative CHECK (
        coalesce(entitlement_weeks,0) >= 0 AND coalesce(entitlement_days,0) >= 0),
    CONSTRAINT carry_over_sane CHECK (carry_over_max_days >= 0 AND carry_over_max_days <= 60),
    CONSTRAINT notice_sane CHECK (minimum_notice_days BETWEEN 0 AND 365)
);

-- Long service increments, held separately so a scheme can have several.
CREATE TABLE IF NOT EXISTS leave_scheme_increments (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    scheme_id    uuid NOT NULL REFERENCES leave_schemes(id) ON DELETE CASCADE,
    after_months integer NOT NULL,
    extra_days   numeric(5,2) NOT NULL,
    UNIQUE (scheme_id, after_months),
    CONSTRAINT increment_sane CHECK (after_months >= 0 AND extra_days >= 0)
);

CREATE TABLE IF NOT EXISTS employee_leave_schemes (
    employee_id  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    scheme_id    uuid NOT NULL REFERENCES leave_schemes(id) ON DELETE RESTRICT,
    from_date    date NOT NULL DEFAULT CURRENT_DATE,
    to_date      date,
    PRIMARY KEY (employee_id, scheme_id, from_date),
    CONSTRAINT membership_dates_sane CHECK (to_date IS NULL OR to_date > from_date)
);

-- Carry-over, recorded per employee per scheme per year rather than
-- recalculated. A historic figure must not change because a scheme was edited.
CREATE TABLE IF NOT EXISTS leave_carry_over (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id   uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    scheme_id     uuid NOT NULL REFERENCES leave_schemes(id) ON DELETE RESTRICT,
    leave_year_id uuid NOT NULL REFERENCES leave_years(id) ON DELETE CASCADE,
    hours         numeric(8,2) NOT NULL DEFAULT 0,
    forfeited_hours numeric(8,2) NOT NULL DEFAULT 0,
    expires_on    date,
    created_at    timestamptz NOT NULL DEFAULT now(),
    UNIQUE (employee_id, scheme_id, leave_year_id),
    CONSTRAINT carry_hours_not_negative CHECK (hours >= 0 AND forfeited_hours >= 0)
);

-- Existing requests gain a scheme. Without it, a request cannot be attributed
-- to a balance once there is more than one scheme.
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS scheme_id uuid REFERENCES leave_schemes(id);
ALTER TABLE leave_requests ADD COLUMN IF NOT EXISTS uses_carry_over_hours numeric(8,2) NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS leave_requests_scheme_idx ON leave_requests(scheme_id);

-- Hours worked, needed for the 12.07% accrual that irregular-hours workers get
-- under Harpur Trust v Brazel and the 2024 reforms.
CREATE TABLE IF NOT EXISTS leave_accrual_hours (
    employee_id   uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    leave_year_id uuid NOT NULL REFERENCES leave_years(id) ON DELETE CASCADE,
    hours_worked  numeric(10,2) NOT NULL DEFAULT 0,
    updated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (employee_id, leave_year_id),
    CONSTRAINT hours_worked_not_negative CHECK (hours_worked >= 0)
);

-- A scheme still in use cannot be deleted. Deleting one would orphan the
-- requests recorded against it and lose the history.
CREATE OR REPLACE FUNCTION refuse_to_delete_used_leave_scheme() RETURNS trigger AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM leave_requests WHERE scheme_id = OLD.id) THEN
        RAISE EXCEPTION 'leave scheme % has requests recorded against it; deactivate it instead',
            OLD.code USING ERRCODE = 'foreign_key_violation';
    END IF;
    RETURN OLD;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS leave_schemes_not_deleted_when_used ON leave_schemes;
CREATE TRIGGER leave_schemes_not_deleted_when_used
    BEFORE DELETE ON leave_schemes
    FOR EACH ROW EXECUTE FUNCTION refuse_to_delete_used_leave_scheme();

INSERT INTO schema_migrations(version, description)
VALUES (6, 'named leave schemes')
ON CONFLICT (version) DO NOTHING;
