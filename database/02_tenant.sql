-- ============================================================================
-- TENANT TEMPLATE  ·  one database per organisation: hrp_<slug>
--
-- APPLIED ONCE, at version 1. This file is deliberately NOT idempotent:
-- CREATE TYPE and CREATE TRIGGER have no IF NOT EXISTS, so re-running it over a
-- live tenant produces dozens of errors and leaves the database in an unclear
-- state. Every later change goes in migrations/<n>_*.sql and is tracked per
-- tenant in payroll.schema_migrations. provision.sh enforces this.
-- ----------------------------------------------------------------------------
-- Applied identically to every tenant database. Two ideas run through it:
--
--   1. EFFECTIVE DATING. Payroll must be reconstructable. "What was this
--      person's salary on 12 August 2026?" has to be answerable three years
--      later during a tribunal or an HMRC compliance check. Nothing that
--      affects pay is ever overwritten; it is superseded.
--
--   2. IMMUTABLE PAYSLIPS. Once a run is committed the payslips are frozen by
--      a trigger, not by convention. A correction is a new payslip that
--      supersedes the old one, which is how RTI expects corrections anyway.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS btree_gist;   -- needed for the no-overlap constraints

CREATE SCHEMA IF NOT EXISTS payroll;
SET search_path = payroll, public;

DO $sp$ BEGIN
    EXECUTE format('ALTER DATABASE %I SET search_path = payroll, public', current_database());
END $sp$;

-- ---------------------------------------------------------------- enums ----
CREATE TYPE employee_status AS ENUM ('active','leaver','suspended');
CREATE TYPE pay_frequency   AS ENUM ('weekly','fortnightly','four_weekly','monthly','quarterly');
CREATE TYPE tax_basis       AS ENUM ('cumulative','week1_month1');
CREATE TYPE pension_basis   AS ENUM ('qualifying','pensionable','total','basic');
CREATE TYPE pension_method  AS ENUM ('net_pay','salary_sacrifice','relief_at_source');
CREATE TYPE run_status      AS ENUM ('draft','in_review','committed','reversed');
CREATE TYPE line_kind       AS ENUM ('payment','deduction','employer_cost');
CREATE TYPE severity        AS ENUM ('high','med','low');
CREATE TYPE decision_kind   AS ENUM ('hold','release','dismiss');
CREATE TYPE leave_status    AS ENUM ('pending','approved','rejected','cancelled','taken');
CREATE TYPE leave_kind      AS ENUM ('annual','carried','unpaid','sick','maternity','paternity','other');

-- ------------------------------------------------------------ reference ----
CREATE TABLE departments (
    id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code      citext NOT NULL UNIQUE,
    name      text NOT NULL,
    cost_centre text,
    parent_id uuid REFERENCES departments(id)
);

CREATE TABLE pay_schedules (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name             text NOT NULL,
    frequency        pay_frequency NOT NULL,
    periods_per_year integer NOT NULL,
    is_default       boolean NOT NULL DEFAULT false,
    CONSTRAINT periods_match_frequency CHECK (
        (frequency='weekly'      AND periods_per_year=52) OR
        (frequency='fortnightly' AND periods_per_year=26) OR
        (frequency='four_weekly' AND periods_per_year=13) OR
        (frequency='monthly'     AND periods_per_year=12) OR
        (frequency='quarterly'   AND periods_per_year=4))
);
CREATE UNIQUE INDEX pay_schedules_one_default ON pay_schedules((is_default)) WHERE is_default;

CREATE TABLE pay_periods (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    schedule_id  uuid NOT NULL REFERENCES pay_schedules(id),
    tax_year     text NOT NULL,                        -- '2026/27'
    sequence     integer NOT NULL,
    starts_on    date NOT NULL,
    ends_on      date NOT NULL,
    pay_date     date NOT NULL,
    UNIQUE (schedule_id, tax_year, sequence),
    CONSTRAINT period_dates_ordered CHECK (ends_on >= starts_on),
    CONSTRAINT pay_date_sane        CHECK (pay_date >= starts_on)
);

-- ------------------------------------------------------------ employees ----
CREATE TABLE employees (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    payroll_number  citext NOT NULL UNIQUE,
    first_name      text NOT NULL,
    last_name       text NOT NULL,
    date_of_birth   date,
    ni_number       text,                                -- encrypted at rest, see note
    email           citext,
    status          employee_status NOT NULL DEFAULT 'active',
    is_director     boolean NOT NULL DEFAULT false,
    created_at      timestamptz NOT NULL DEFAULT now(),

    -- HMRC format: two letters, six digits, one of A/B/C/D. Stored encrypted in
    -- production; the shape check runs on the plaintext before encryption.
    CONSTRAINT dob_is_plausible CHECK (date_of_birth IS NULL
        OR (date_of_birth > '1920-01-01' AND date_of_birth < current_date - interval '13 years'))
);

CREATE INDEX employees_status_idx ON employees(status);
CREATE INDEX employees_name_idx   ON employees(last_name, first_name);

-- Employment spells. A person can be re-employed, so this is one-to-many.
CREATE TABLE employments (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id   uuid NOT NULL REFERENCES employees(id) ON DELETE RESTRICT,
    schedule_id   uuid NOT NULL REFERENCES pay_schedules(id),
    department_id uuid REFERENCES departments(id),
    job_title     text,
    started_on    date NOT NULL,
    ended_on      date,
    leaving_reason text,
    period        daterange GENERATED ALWAYS AS
                  (daterange(started_on, ended_on, '[)')) STORED,
    CONSTRAINT employment_dates_ordered CHECK (ended_on IS NULL OR ended_on >= started_on),
    -- One person cannot hold two overlapping employment spells
    EXCLUDE USING gist (employee_id WITH =, daterange(started_on, ended_on, '[)') WITH &&)
);

-- Effective-dated pay. Never updated in place — a change closes the old row
-- and opens a new one, so any historic payslip can be re-derived exactly.
CREATE TABLE remuneration (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employment_id  uuid NOT NULL REFERENCES employments(id) ON DELETE CASCADE,
    effective_from date NOT NULL,
    effective_to   date,
    annual_salary  numeric(12,2) NOT NULL,
    weekly_hours   numeric(5,2)  NOT NULL DEFAULT 37.5,
    days_per_week  numeric(3,1)  NOT NULL DEFAULT 5,
    reason         text,
    recorded_at    timestamptz NOT NULL DEFAULT now(),
    recorded_by    text,
    CONSTRAINT salary_not_negative CHECK (annual_salary >= 0),
    CONSTRAINT hours_plausible CHECK (weekly_hours > 0 AND weekly_hours <= 80),
    CONSTRAINT days_plausible  CHECK (days_per_week > 0 AND days_per_week <= 7),
    CONSTRAINT remuneration_dates_ordered CHECK (effective_to IS NULL OR effective_to > effective_from),
    EXCLUDE USING gist (employment_id WITH =, daterange(effective_from, effective_to, '[)') WITH &&)
);

CREATE TABLE tax_codes (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id    uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    code           text NOT NULL,
    basis          tax_basis NOT NULL DEFAULT 'cumulative',
    effective_from date NOT NULL,
    effective_to   date,
    source         text NOT NULL DEFAULT 'manual',   -- manual | p45 | p6 | p9 | starter_declaration
    CONSTRAINT tax_code_shape CHECK (code ~ '^S?C?([0-9]{1,5}[LMNTY]|BR|D[0-2]|NT|K[0-9]{1,5})$'),
    EXCLUDE USING gist (employee_id WITH =, daterange(effective_from, effective_to, '[)') WITH &&)
);

CREATE TABLE ni_categories (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id    uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    category       char(1) NOT NULL,
    effective_from date NOT NULL,
    effective_to   date,
    CONSTRAINT ni_category_valid CHECK (category IN ('A','B','C','F','H','I','J','L','M','S','V','X','Z')),
    EXCLUDE USING gist (employee_id WITH =, daterange(effective_from, effective_to, '[)') WITH &&)
);

-- Bank details are the highest-value target in the database. Stored encrypted;
-- the application never selects these columns except when building a BACS file.
CREATE TABLE bank_accounts (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id    uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    sort_code_enc      bytea NOT NULL,
    account_number_enc bytea NOT NULL,
    account_last4  char(4) NOT NULL,        -- for display, never the full number
    account_name   text,
    effective_from date NOT NULL,
    effective_to   date,
    verified_at    timestamptz,
    EXCLUDE USING gist (employee_id WITH =, daterange(effective_from, effective_to, '[)') WITH &&)
);

-- -------------------------------------------------------------- pensions ----
CREATE TABLE pension_schemes (
    id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name             text NOT NULL,
    provider         text NOT NULL DEFAULT 'other',
    basis            pension_basis NOT NULL,
    method           pension_method NOT NULL,
    employee_rate    numeric(6,4) NOT NULL,
    employer_rate    numeric(6,4) NOT NULL,
    qualifying_lower numeric(12,2),
    qualifying_upper numeric(12,2),
    employer_ref     text,
    group_ref        text,
    is_default       boolean NOT NULL DEFAULT false,
    CONSTRAINT rates_are_fractions CHECK (employee_rate BETWEEN 0 AND 1 AND employer_rate BETWEEN 0 AND 1),
    CONSTRAINT qualifying_band_ordered CHECK (qualifying_upper IS NULL OR qualifying_lower IS NULL
                                              OR qualifying_upper > qualifying_lower),
    -- A qualifying-earnings scheme without a band is a silent mis-calculation
    CONSTRAINT qualifying_needs_band CHECK (basis <> 'qualifying' OR qualifying_lower IS NOT NULL)
);
CREATE UNIQUE INDEX pension_schemes_one_default ON pension_schemes((is_default)) WHERE is_default;

CREATE TABLE scheme_memberships (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id    uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    scheme_id      uuid NOT NULL REFERENCES pension_schemes(id),
    joined_on      date NOT NULL,
    left_on        date,
    opt_out_on     date,
    opt_out_notice_ref text,
    EXCLUDE USING gist (employee_id WITH =, daterange(joined_on, left_on, '[)') WITH &&)
);

-- ------------------------------------------------------------- pay runs ----
CREATE TABLE pay_runs (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    pay_period_id  uuid NOT NULL REFERENCES pay_periods(id),
    status         run_status NOT NULL DEFAULT 'draft',
    calculated_at  timestamptz,
    committed_at   timestamptz,
    committed_by   text,
    reversed_at    timestamptz,
    reversal_reason text,
    engine_version text NOT NULL,
    rates_snapshot jsonb NOT NULL,          -- the exact rates used, frozen with the run
    UNIQUE (pay_period_id),
    CONSTRAINT committed_has_actor CHECK (status <> 'committed' OR (committed_by IS NOT NULL AND committed_at IS NOT NULL))
);

CREATE TABLE payslips (
    id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    pay_run_id         uuid NOT NULL REFERENCES pay_runs(id) ON DELETE CASCADE,
    employee_id        uuid NOT NULL REFERENCES employees(id),
    supersedes_id      uuid REFERENCES payslips(id),

    gross              numeric(12,2) NOT NULL,
    taxable_pay        numeric(12,2) NOT NULL,
    niable_pay         numeric(12,2) NOT NULL,
    tax                numeric(12,2) NOT NULL,
    employee_ni        numeric(12,2) NOT NULL,
    employer_ni        numeric(12,2) NOT NULL,
    pension_employee   numeric(12,2) NOT NULL DEFAULT 0,
    pension_employer   numeric(12,2) NOT NULL DEFAULT 0,
    student_loan       numeric(12,2) NOT NULL DEFAULT 0,
    other_deductions   numeric(12,2) NOT NULL DEFAULT 0,
    total_deductions   numeric(12,2) NOT NULL,
    net                numeric(12,2) NOT NULL,

    ytd_gross          numeric(12,2) NOT NULL,
    ytd_taxable        numeric(12,2) NOT NULL,
    ytd_tax            numeric(12,2) NOT NULL,
    ytd_employee_ni    numeric(12,2) NOT NULL,
    ytd_pension        numeric(12,2) NOT NULL,

    tax_code_used      text NOT NULL,
    tax_basis_used     tax_basis NOT NULL,
    ni_category_used   char(1) NOT NULL,

    created_at         timestamptz NOT NULL DEFAULT now(),

    UNIQUE (pay_run_id, employee_id),
    -- The arithmetic must hold. A payslip that does not balance cannot be stored.
    CONSTRAINT payslip_balances CHECK (net = gross - total_deductions),
    CONSTRAINT deductions_add_up CHECK (
        total_deductions = tax + employee_ni + pension_employee + student_loan + other_deductions),
    CONSTRAINT net_not_negative CHECK (net >= 0)
);

CREATE INDEX payslips_employee_idx ON payslips(employee_id, created_at DESC);

CREATE TABLE payslip_lines (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    payslip_id  uuid NOT NULL REFERENCES payslips(id) ON DELETE CASCADE,
    kind        line_kind NOT NULL,
    sequence    integer NOT NULL,
    label       text NOT NULL,
    amount      numeric(12,2) NOT NULL,
    hours       numeric(8,2),
    rate        numeric(10,4),
    is_pensionable boolean NOT NULL DEFAULT true,
    is_niable      boolean NOT NULL DEFAULT true,
    is_taxable     boolean NOT NULL DEFAULT true,
    UNIQUE (payslip_id, kind, sequence),
    -- Section 8 ERA 1996: where pay varies with hours, the hours must be shown
    CONSTRAINT hours_need_rate CHECK ((hours IS NULL) = (rate IS NULL))
);

-- ------------------------------------------------------------ exceptions ----
CREATE TABLE run_exceptions (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    pay_run_id    uuid NOT NULL REFERENCES pay_runs(id) ON DELETE CASCADE,
    reference     text NOT NULL,
    rule_id       text NOT NULL,
    severity      severity NOT NULL,
    title         text NOT NULL,
    amount        numeric(12,2) NOT NULL DEFAULT 0,
    evidence      jsonb NOT NULL DEFAULT '[]'::jsonb,
    UNIQUE (pay_run_id, reference)
);

CREATE TABLE exception_employees (
    exception_id uuid NOT NULL REFERENCES run_exceptions(id) ON DELETE CASCADE,
    employee_id  uuid NOT NULL REFERENCES employees(id),
    PRIMARY KEY (exception_id, employee_id)
);

CREATE TABLE exception_decisions (
    exception_id uuid PRIMARY KEY REFERENCES run_exceptions(id) ON DELETE CASCADE,
    decision     decision_kind NOT NULL,
    decided_by   text NOT NULL,
    decided_at   timestamptz NOT NULL DEFAULT now(),
    by_rule      text,                    -- set when an automation rule decided it
    note         text
);

-- ---------------------------------------------------------------- leave ----
CREATE TABLE leave_years (
    id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    starts_on  date NOT NULL,
    ends_on    date NOT NULL,
    label      text NOT NULL,
    UNIQUE (starts_on),
    CONSTRAINT leave_year_ordered CHECK (ends_on > starts_on)
);

CREATE TABLE leave_entitlements (
    id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id       uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    leave_year_id     uuid NOT NULL REFERENCES leave_years(id),
    entitlement_hours numeric(8,2) NOT NULL,
    bank_holiday_hours numeric(8,2) NOT NULL DEFAULT 0,
    carried_hours     numeric(8,2) NOT NULL DEFAULT 0,
    carry_expires_on  date,
    UNIQUE (employee_id, leave_year_id),
    CONSTRAINT entitlement_not_negative CHECK (entitlement_hours >= 0 AND carried_hours >= 0)
);

CREATE TABLE leave_requests (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id   uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
    leave_year_id uuid NOT NULL REFERENCES leave_years(id),
    kind          leave_kind NOT NULL DEFAULT 'annual',
    starts_on     date NOT NULL,
    ends_on       date NOT NULL,
    hours         numeric(8,2) NOT NULL,
    status        leave_status NOT NULL DEFAULT 'pending',
    requested_at  timestamptz NOT NULL DEFAULT now(),
    decided_by    text,
    decided_at    timestamptz,
    CONSTRAINT leave_dates_ordered CHECK (ends_on >= starts_on),
    CONSTRAINT leave_hours_positive CHECK (hours > 0)
);

CREATE INDEX leave_requests_pending_idx ON leave_requests(status) WHERE status = 'pending';

-- Approved leave cannot overlap for the same person
CREATE UNIQUE INDEX leave_no_overlap_guard ON leave_requests(employee_id, starts_on, ends_on)
    WHERE status IN ('approved','taken');

-- ------------------------------------------------------------ automation ----
CREATE TABLE automation_policy (
    rule_id    text PRIMARY KEY,
    tier       text NOT NULL DEFAULT 'off',
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by text,
    CONSTRAINT tier_valid CHECK (tier IN ('off','propose','notify','apply'))
);

CREATE TABLE automation_log (
    id          bigserial PRIMARY KEY,
    at          timestamptz NOT NULL DEFAULT now(),
    rule_id     text NOT NULL,
    tier        text NOT NULL,
    pay_run_id  uuid REFERENCES pay_runs(id),
    employee_id uuid REFERENCES employees(id),
    label       text NOT NULL,
    was_automatic boolean NOT NULL,
    undo        jsonb,
    reversed_at timestamptz,
    actor       text NOT NULL
);

-- ---------------------------------------------------------- integrations ----
CREATE TABLE integration_credentials (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind        text NOT NULL UNIQUE,        -- hmrc_rti | bacs | pension_provider
    reference   text,
    secret_enc  bytea,
    configured_at timestamptz,
    last_used_at  timestamptz,
    status      text NOT NULL DEFAULT 'not_connected'
);

CREATE TABLE rti_submissions (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    pay_run_id    uuid NOT NULL REFERENCES pay_runs(id),
    kind          text NOT NULL,              -- FPS | EPS
    submitted_at  timestamptz,
    correlation_id text,
    response      jsonb,
    status        text NOT NULL DEFAULT 'pending'
);

-- ------------------------------------------------------------- audit -------
CREATE TABLE audit_log (
    id          bigserial PRIMARY KEY,
    at          timestamptz NOT NULL DEFAULT now(),
    actor       text NOT NULL,
    actor_ip    inet,
    action      text NOT NULL,
    entity      text NOT NULL,
    entity_id   uuid,
    before      jsonb,
    after       jsonb
);

CREATE INDEX audit_log_entity_idx ON audit_log(entity, entity_id, at DESC);

CREATE OR REPLACE FUNCTION deny_change() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'audit_log is append-only' USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_log_append_only
    BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION deny_change();

-- ============================================================================
-- PAYSLIP IMMUTABILITY
-- Once a run is committed its payslips are frozen. Corrections create a new
-- payslip that supersedes the old one, which is also how RTI handles them.
-- ============================================================================
CREATE OR REPLACE FUNCTION freeze_committed_payslips() RETURNS trigger AS $$
DECLARE v_status run_status;
BEGIN
    SELECT status INTO v_status FROM pay_runs
    WHERE id = COALESCE(NEW.pay_run_id, OLD.pay_run_id);

    IF v_status = 'committed' THEN
        RAISE EXCEPTION 'payslips in a committed run are immutable; issue a superseding payslip instead'
            USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER payslips_frozen_when_committed
    BEFORE UPDATE OR DELETE ON payslips
    FOR EACH ROW EXECUTE FUNCTION freeze_committed_payslips();

-- A run cannot be committed while any exception is undecided.
CREATE OR REPLACE FUNCTION block_commit_with_open_exceptions() RETURNS trigger AS $$
DECLARE v_open integer;
BEGIN
    IF NEW.status = 'committed' AND OLD.status <> 'committed' THEN
        SELECT count(*) INTO v_open
        FROM run_exceptions e
        LEFT JOIN exception_decisions d ON d.exception_id = e.id
        WHERE e.pay_run_id = NEW.id AND d.exception_id IS NULL;

        IF v_open > 0 THEN
            RAISE EXCEPTION 'cannot commit: % exception(s) still undecided', v_open
                USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER pay_runs_commit_gate
    BEFORE UPDATE ON pay_runs
    FOR EACH ROW EXECUTE FUNCTION block_commit_with_open_exceptions();

-- ============================================================================
-- VIEWS
-- ============================================================================

-- Current pay for everyone, resolving the effective-dated rows.
CREATE OR REPLACE VIEW v_current_remuneration AS
SELECT e.id AS employee_id, e.payroll_number,
       e.first_name || ' ' || e.last_name AS full_name,
       em.job_title, d.name AS department,
       r.annual_salary, r.weekly_hours, r.days_per_week,
       r.effective_from
FROM employees e
JOIN employments em ON em.employee_id = e.id AND em.ended_on IS NULL
LEFT JOIN departments d ON d.id = em.department_id
JOIN remuneration r ON r.employment_id = em.id
 AND daterange(r.effective_from, r.effective_to, '[)') @> current_date
WHERE e.status = 'active';

-- What HMRC needs per employee per run.
CREATE OR REPLACE VIEW v_fps_lines AS
SELECT pr.id AS pay_run_id, pp.tax_year, pp.sequence AS period, pp.pay_date,
       e.payroll_number, e.last_name, e.first_name, e.ni_number, e.date_of_birth,
       p.tax_code_used, p.tax_basis_used, p.ni_category_used,
       p.taxable_pay, p.tax, p.ytd_taxable, p.ytd_tax,
       p.employee_ni, p.employer_ni, p.pension_employee, p.student_loan, p.net
FROM payslips p
JOIN pay_runs pr   ON pr.id = p.pay_run_id
JOIN pay_periods pp ON pp.id = pr.pay_period_id
JOIN employees e   ON e.id = p.employee_id
WHERE pr.status = 'committed';

-- Leave balance in hours, which is the only unit that survives part-time staff.
CREATE OR REPLACE VIEW v_leave_balances AS
SELECT en.employee_id,
       e.first_name || ' ' || e.last_name AS full_name,
       ly.label AS leave_year,
       en.entitlement_hours + en.bank_holiday_hours + en.carried_hours AS total_hours,
       COALESCE(SUM(lr.hours) FILTER (WHERE lr.status IN ('approved','taken')
                                        AND lr.kind IN ('annual','carried')), 0) AS used_hours,
       COALESCE(SUM(lr.hours) FILTER (WHERE lr.status = 'pending'
                                        AND lr.kind IN ('annual','carried')), 0) AS pending_hours,
       en.entitlement_hours + en.bank_holiday_hours + en.carried_hours
         - COALESCE(SUM(lr.hours) FILTER (WHERE lr.status IN ('approved','taken','pending')
                                            AND lr.kind IN ('annual','carried')), 0) AS available_hours,
       en.carry_expires_on
FROM leave_entitlements en
JOIN employees e   ON e.id = en.employee_id
JOIN leave_years ly ON ly.id = en.leave_year_id
LEFT JOIN leave_requests lr ON lr.employee_id = en.employee_id AND lr.leave_year_id = en.leave_year_id
GROUP BY en.id, e.first_name, e.last_name, ly.label, en.entitlement_hours,
         en.bank_holiday_hours, en.carried_hours, en.carry_expires_on, en.employee_id;

-- ============================================================================
-- ROLES  (least privilege inside every tenant database)
-- ============================================================================
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrp_app')      THEN CREATE ROLE hrp_app;      END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrp_readonly') THEN CREATE ROLE hrp_readonly; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hrp_payments') THEN CREATE ROLE hrp_payments; END IF;
END $$;

GRANT USAGE ON SCHEMA payroll TO hrp_app, hrp_readonly, hrp_payments;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA payroll TO hrp_app;
GRANT SELECT ON ALL TABLES IN SCHEMA payroll TO hrp_readonly;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA payroll TO hrp_app;

-- Only the payment service may read encrypted bank details, and only read.
REVOKE ALL ON bank_accounts FROM hrp_app, hrp_readonly;
GRANT SELECT ON bank_accounts TO hrp_payments;
GRANT INSERT, UPDATE ON bank_accounts TO hrp_app;
REVOKE ALL ON integration_credentials FROM hrp_readonly;

CREATE TABLE schema_migrations (
    version     integer PRIMARY KEY,
    applied_at  timestamptz NOT NULL DEFAULT now(),
    description text NOT NULL
);
INSERT INTO schema_migrations(version, description) VALUES (1, 'initial tenant schema');
