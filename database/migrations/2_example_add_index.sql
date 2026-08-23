-- Example migration. Migrations MUST be idempotent and safe to re-run.
CREATE INDEX IF NOT EXISTS payslips_run_idx ON payroll.payslips(pay_run_id);
