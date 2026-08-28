-- ============================================================================
-- MIGRATION 5 — GROUP STRUCTURE AND OCCUPATIONAL ABSENCE
-- ----------------------------------------------------------------------------
-- Two changes, both driven by what a real group actually looks like.
--
-- 1. MANY EMPLOYERS IN ONE TENANT.
--    A housing group with nine subsidiaries has nine PAYE references and files
--    nine sets of RTI, but one HR function, one set of policies and one place
--    people log in. Modelling that as nine separate tenants would mean nine
--    logins and no consolidated reporting.
--
--    So the tenant stays the group, and employers sit inside it. Every
--    employment belongs to exactly one employer, and RTI is filed per employer.
--
-- 2. MANY PAY SCHEDULES.
--    Fifteen payrolls across three frequencies is ordinary in a group. Periods
--    already hang off a schedule; what was missing was a schedule belonging to
--    an employer, and a run belonging to a schedule rather than to the tenant.
--
-- Safe to re-run.
-- ============================================================================

SET search_path = payroll, public;

-- ---------------------------------------------------------------- employers --
CREATE TABLE IF NOT EXISTS employers (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code              text NOT NULL UNIQUE,
    legal_name        text NOT NULL,
    trading_name      text,

    -- Split as HMRC wants it: 120/AB12345 is two fields, never one.
    paye_office_no    text NOT NULL,
    paye_reference    text NOT NULL,
    accounts_office_ref text NOT NULL,
    corporation_tax_ref text,
    companies_house_no  text,

    -- Each employer claims its own allowance, and only one per group of
    -- connected companies may claim it. Recording the intent here means the
    -- system can flag a second claim rather than silently allowing it.
    claims_employment_allowance boolean NOT NULL DEFAULT false,
    apprenticeship_levy_allowance numeric(12,2),

    registered_address jsonb,
    active_from       date NOT NULL DEFAULT CURRENT_DATE,
    active_to         date,
    created_at        timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT paye_office_no_valid CHECK (paye_office_no ~ '^[0-9]{3}$'),
    CONSTRAINT paye_reference_valid CHECK (paye_reference ~ '^[A-Z0-9]{1,10}$'),
    CONSTRAINT aoref_valid CHECK (accounts_office_ref ~ '^[0-9]{3}P[A-Z][0-9]{7}[0-9X]$'),
    CONSTRAINT employer_dates_sane CHECK (active_to IS NULL OR active_to > active_from)
);

-- Two employers cannot share a PAYE reference; RTI would be filed against the
-- wrong scheme and the figures would be irreconcilable.
CREATE UNIQUE INDEX IF NOT EXISTS employers_paye_unique
    ON employers(paye_office_no, paye_reference);

-- Only one employer in the group may claim the Employment Allowance.
CREATE UNIQUE INDEX IF NOT EXISTS employers_one_ea_claim
    ON employers((claims_employment_allowance)) WHERE claims_employment_allowance;

-- --------------------------------------------------------------- schedules --
ALTER TABLE pay_schedules ADD COLUMN IF NOT EXISTS employer_id uuid REFERENCES employers(id);
ALTER TABLE pay_schedules ADD COLUMN IF NOT EXISTS code text;
ALTER TABLE pay_schedules ADD COLUMN IF NOT EXISTS week_starts_on smallint NOT NULL DEFAULT 1;
COMMENT ON COLUMN pay_schedules.week_starts_on IS
  '1 = Monday. Timesheets and variable hours are collated on this boundary.';

DO $$ BEGIN
    ALTER TABLE pay_schedules ADD CONSTRAINT week_start_valid
        CHECK (week_starts_on BETWEEN 0 AND 6);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- --------------------------------------------------------- working patterns --
-- Named, assignable patterns rather than a number typed per person. Hours per
-- day, not start and finish times — which is how most organisations actually
-- describe them.
CREATE TABLE IF NOT EXISTS working_patterns (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code          text NOT NULL UNIQUE,
    name          text NOT NULL,
    weekly_hours  numeric(6,2) NOT NULL,
    days_per_week numeric(4,2) NOT NULL,

    -- Seven entries, Sunday first, hours per day. A four-day week or a
    -- half-day Friday is expressible; start and finish times are not needed.
    hours_by_day  numeric(5,2)[] NOT NULL DEFAULT ARRAY[0,0,0,0,0,0,0]::numeric(5,2)[],

    is_default    boolean NOT NULL DEFAULT false,
    created_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT weekly_hours_positive CHECK (weekly_hours > 0 AND weekly_hours <= 80),
    CONSTRAINT days_per_week_sane CHECK (days_per_week > 0 AND days_per_week <= 7),
    CONSTRAINT hours_by_day_is_a_week CHECK (array_length(hours_by_day, 1) = 7)
);

CREATE UNIQUE INDEX IF NOT EXISTS working_patterns_one_default
    ON working_patterns((is_default)) WHERE is_default;

ALTER TABLE employments ADD COLUMN IF NOT EXISTS employer_id uuid REFERENCES employers(id);
ALTER TABLE employments ADD COLUMN IF NOT EXISTS working_pattern_id uuid REFERENCES working_patterns(id);

-- Every employment must belong to an employer, or RTI cannot be filed for it.
CREATE INDEX IF NOT EXISTS employments_employer_idx ON employments(employer_id);

-- ------------------------------------------------------ occupational absence --
DO $$ BEGIN
    CREATE TYPE absence_kind AS ENUM
        ('sickness','maternity','paternity','adoption','shared_parental',
         'parental_bereavement','neonatal_care','carers','compassionate',
         'jury_service','unpaid','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS absence_schemes (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code              text NOT NULL UNIQUE,
    name              text NOT NULL,
    kind              absence_kind NOT NULL,

    -- 'rolling' looks back this many months from the first day of the
    -- absence. 'per_occurrence' treats each absence independently, which is
    -- how enhanced family leave usually works.
    window_type       text NOT NULL DEFAULT 'rolling',
    window_months     integer NOT NULL DEFAULT 12,

    -- Almost always true: occupational pay is INCLUSIVE of statutory. Paying
    -- both produces an overpayment that must be recovered from the employee.
    offsets_statutory boolean NOT NULL DEFAULT true,
    waiting_days      integer NOT NULL DEFAULT 0,

    requires_certificate_after_days integer,
    active            boolean NOT NULL DEFAULT true,
    created_at        timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT window_type_valid CHECK (window_type IN ('rolling','fixed','per_occurrence')),
    CONSTRAINT window_months_sane CHECK (window_months BETWEEN 0 AND 60),
    CONSTRAINT waiting_days_sane CHECK (waiting_days BETWEEN 0 AND 30)
);

-- Service bands. Entitlement in WEEKS, converted to days using the employee's
-- own pattern, so a part-timer gets the same weeks and fewer days.
CREATE TABLE IF NOT EXISTS absence_scheme_bands (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    scheme_id    uuid NOT NULL REFERENCES absence_schemes(id) ON DELETE CASCADE,
    from_months  integer NOT NULL,
    full_weeks   numeric(6,2) NOT NULL DEFAULT 0,
    half_weeks   numeric(6,2) NOT NULL DEFAULT 0,
    label        text NOT NULL,

    CONSTRAINT from_months_sane CHECK (from_months >= 0 AND from_months <= 600),
    CONSTRAINT weeks_not_negative CHECK (full_weeks >= 0 AND half_weeks >= 0),
    UNIQUE (scheme_id, from_months)
);

CREATE TABLE IF NOT EXISTS employee_absence_schemes (
    employee_id  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    scheme_id    uuid NOT NULL REFERENCES absence_schemes(id) ON DELETE RESTRICT,
    from_date    date NOT NULL DEFAULT CURRENT_DATE,
    to_date      date,
    PRIMARY KEY (employee_id, scheme_id, from_date)
);

-- ----------------------------------------------------------------- absences --
CREATE TABLE IF NOT EXISTS absences (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id      uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
    scheme_id        uuid REFERENCES absence_schemes(id),
    kind             absence_kind NOT NULL,

    starts_on        date NOT NULL,
    ends_on          date,
    working_days     numeric(6,2),

    -- What was actually paid, recorded rather than recalculated. A historic
    -- absence must not change because a scheme was edited afterwards.
    full_paid_days   numeric(6,2) NOT NULL DEFAULT 0,
    half_paid_days   numeric(6,2) NOT NULL DEFAULT 0,
    unpaid_days      numeric(6,2) NOT NULL DEFAULT 0,
    statutory_paid   numeric(12,2) NOT NULL DEFAULT 0,
    occupational_paid numeric(12,2) NOT NULL DEFAULT 0,

    reason           text,
    certificate_received boolean NOT NULL DEFAULT false,
    return_to_work_completed boolean NOT NULL DEFAULT false,

    -- Absence loaded from a previous system, needed for the rolling window to
    -- be correct from day one. Flagged so it is never mistaken for something
    -- this system calculated.
    imported         boolean NOT NULL DEFAULT false,
    imported_from    text,

    recorded_by      text,
    created_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT absence_dates_sane CHECK (ends_on IS NULL OR ends_on >= starts_on),
    CONSTRAINT paid_days_not_negative CHECK (
        full_paid_days >= 0 AND half_paid_days >= 0 AND unpaid_days >= 0)
);

CREATE INDEX IF NOT EXISTS absences_employee_idx ON absences(employee_id, starts_on DESC);
CREATE INDEX IF NOT EXISTS absences_open_idx ON absences(employee_id) WHERE ends_on IS NULL;

-- One person cannot be off twice at once. Two overlapping absences means one
-- of them is wrong, and the entitlement calculation would double-count.
CREATE EXTENSION IF NOT EXISTS btree_gist;
DO $$ BEGIN
    ALTER TABLE absences ADD CONSTRAINT absences_do_not_overlap
        EXCLUDE USING gist (
            employee_id WITH =,
            daterange(starts_on, COALESCE(ends_on, 'infinity'::date), '[]') WITH &&
        );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- --------------------------------------------------------------- timesheets --
-- For casual and as-and-when staff. Hours submitted, approved, then paid.
CREATE TABLE IF NOT EXISTS timesheets (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id   uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
    week_starting date NOT NULL,
    status        text NOT NULL DEFAULT 'draft',

    submitted_at  timestamptz,
    submitted_by  text,
    approved_at   timestamptz,
    approved_by   text,
    pay_run_id    uuid REFERENCES pay_runs(id),

    CONSTRAINT timesheet_status_valid CHECK (status IN ('draft','submitted','approved','rejected','paid')),
    -- Nobody may approve their own hours.
    CONSTRAINT approver_is_not_submitter CHECK (
        approved_by IS NULL OR submitted_by IS NULL OR approved_by <> submitted_by),
    UNIQUE (employee_id, week_starting)
);

CREATE TABLE IF NOT EXISTS timesheet_lines (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    timesheet_id  uuid NOT NULL REFERENCES timesheets(id) ON DELETE CASCADE,
    worked_on     date NOT NULL,
    hours         numeric(5,2) NOT NULL,
    rate          numeric(10,4),
    cost_centre   text,
    note          text,

    CONSTRAINT hours_sane CHECK (hours > 0 AND hours <= 24)
);

CREATE INDEX IF NOT EXISTS timesheet_lines_sheet_idx ON timesheet_lines(timesheet_id);

-- An approved timesheet is evidence of hours worked and cannot be altered.
-- Corrections go on a new sheet, in the same way a committed payslip is
-- superseded rather than edited.
CREATE OR REPLACE FUNCTION lock_approved_timesheets() RETURNS trigger AS $$
BEGIN
    IF (SELECT status FROM timesheets WHERE id =
            COALESCE(NEW.timesheet_id, OLD.timesheet_id)) IN ('approved','paid') THEN
        RAISE EXCEPTION 'an approved timesheet cannot be changed; raise a correcting sheet'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS timesheet_lines_locked ON timesheet_lines;
CREATE TRIGGER timesheet_lines_locked
    BEFORE INSERT OR UPDATE OR DELETE ON timesheet_lines
    FOR EACH ROW EXECUTE FUNCTION lock_approved_timesheets();

INSERT INTO schema_migrations(version, description)
VALUES (5, 'group structure, working patterns, occupational absence, timesheets')
ON CONFLICT (version) DO NOTHING;
