# HR & Payroll — multi-tenant database layer

Everything here has been run against PostgreSQL 16, not just written. Three
tenants were provisioned, seeded, and then deliberately attacked with invalid
data to confirm the constraints hold.

```
sql/
  01_registry.sql     control plane   — one shared database, no payroll data
  02_tenant.sql       tenant template — applied once per organisation, at v1
  migrations/         everything after v1, tracked per tenant
  provision.sh        create | migrate | status
```

## How it fits together

```
                        ┌──────────────────────────┐
   portal signup  ──▶   │      hrp_registry        │
                        │  organisations, users,   │
                        │  memberships, tenant map │
                        │  NO employee data        │
                        └────────────┬─────────────┘
                                     │ provisioning job
                        ┌────────────┴─────────────┐
                        ▼            ▼             ▼
              hrp_northgate_    hrp_thornbury_  hrp_harbour_
                logistics           mbc           trust
              ───────────────  ─────────────── ──────────────
              employees, pay runs, payslips, leave, audit
```

The registry deliberately holds **no payroll data**. If it leaks, it exposes
company names and login records — not anyone's salary, National Insurance
number or bank details.

## Database-per-tenant: the honest trade-off

You asked for a separate database per company. It is a defensible choice for
payroll and it sells well — *"your data is in its own database"* is a real
answer in a procurement questionnaire, not marketing. But it is not free, and
you should go in knowing the costs.

**What you gain**

- Hard isolation. A missing `WHERE org_id = ?` cannot leak another company's
  payroll, because the other company's tables are not reachable. Postgres
  refuses cross-database references outright — tested.
- Trivial per-tenant backup, restore and point-in-time recovery.
- GDPR erasure is `DROP DATABASE`, not a hunt across forty tables.
- Per-tenant encryption keys, so one compromised key exposes one customer.
- A noisy tenant running a huge report cannot bloat everyone else's tables.

**What it costs**

- **Connection pooling.** Each database needs its own pool. Five hundred
  tenants × ten connections is far beyond what one Postgres instance handles.
  PgBouncer in transaction mode is not optional at any real scale.
- **Migrations run N times** and can fail on tenant 340 of 500. This is why
  `schema_version` is tracked per tenant and `provision.sh migrate` is
  resumable — a partial rollout is a normal Tuesday, not a crisis.
- **Managed-service limits.** RDS and Aurora have practical ceilings in the
  low thousands of databases per instance. Past that you shard across clusters,
  which the `host` column in `tenant_databases` already anticipates.
- **Cross-tenant analytics get harder.** "Average payroll cost across all
  customers" needs a warehouse, not a query.

**Practical guidance:** database-per-tenant is comfortable to roughly 500–1,000
tenants per cluster. If you expect thousands of small private companies,
schema-per-tenant gives most of the isolation at a fraction of the operational
cost. A reasonable hybrid, and the one I would recommend: **schema-per-tenant
for self-serve small customers, database-per-tenant for enterprise and public
sector**, where isolation is contractual. The registry already supports both —
add a `tenancy_model` column and let `tenant_database_name()` resolve either.

## Two ideas that run through the tenant schema

**Effective dating.** Payroll must be reconstructable. *"What was this person's
salary on 12 August 2026?"* has to be answerable three years later at a
tribunal or an HMRC compliance check. Nothing that affects pay is overwritten;
it is superseded. `remuneration`, `tax_codes`, `ni_categories` and
`bank_accounts` all carry `effective_from` / `effective_to` with a GiST
exclusion constraint that makes overlapping rows impossible.

**Immutable payslips.** Once a run is committed, its payslips are frozen by a
trigger. A correction is a new payslip carrying `supersedes_id`, which is also
how RTI expects corrections to be reported.

## What the database enforces on its own

Not in application code, where it can be forgotten:

| Rule | Mechanism |
|---|---|
| No overlapping salary, tax code, NI category or bank record | GiST exclusion constraint |
| `net = gross − total_deductions`, and deductions sum correctly | CHECK |
| A run cannot commit with an undecided exception | trigger |
| A committed payslip cannot be edited or deleted | trigger |
| A committed run must name the person who committed it | CHECK |
| Audit tables are append-only | trigger |
| Tax codes match HMRC's format | CHECK regex |
| A qualifying-earnings scheme must have a band | CHECK |
| Weekly schedules have 52 periods, monthly 12 | CHECK |
| Anyone who can approve payroll holds MFA | trigger |
| One owner per organisation | partial unique index |
| Tenant data stays in a UK region | CHECK |

All of these were tested by trying to violate them. All were rejected.

## Two bugs found by running it

**`citext` makes regex matching case-insensitive.** The slug check
`slug ~ '^[a-z]...'` happily accepted `ACME`, because citext folds case in
`~` too. Fixed with an explicit `::text` cast plus a normalising trigger, so
`Acme-Ltd` is accepted and stored as `acme-ltd` rather than rejected.

**The tenant schema is not idempotent.** Re-running it over a live database
produced 49 errors — `CREATE TYPE` and `CREATE TRIGGER` have no
`IF NOT EXISTS`. Data survived, but the script's own comment claimed it was
re-runnable, which was false. The initial schema now loads exactly once;
everything after goes through `migrations/`, which *are* required to be
idempotent.

## Security notes for the procurement questionnaire

- `bank_accounts` and `integration_credentials` are encrypted with `pgcrypto`.
  Keys live in KMS; the registry stores only a key *reference*. Rotate per
  tenant without touching anyone else.
- Three roles per tenant: `hrp_app` (read/write, **no** access to bank
  details), `hrp_payments` (read-only, bank details only), `hrp_readonly`.
  The application cannot read a full account number.
- `account_last4` exists so screens can show something useful without ever
  decrypting.
- Every payroll action lands in the tenant's append-only `audit_log`; every
  account action lands in the registry's `audit_events`.
- `rates_snapshot` freezes the exact tax and NI rates used on each run, so a
  historic payslip can be re-derived even after rates change.

## Not done, and needed before production

1. **Row-level security** inside tenants, for employee self-service so a person
   sees only their own payslips.
2. **Encryption of `ni_number`** — currently plaintext, and it is personal data
   under UK GDPR. Same treatment as bank details.
3. **Backup verification.** An untested restore is not a backup. Restore one
   tenant weekly, automatically, and alert if it fails.
4. **Connection pooling** via PgBouncer before tenant fifty.
5. **A retention policy.** Payroll records must be kept six years; personal
   data beyond that should be purged. Nothing here expires anything yet.

## Running it

```bash
createdb hrp_registry
psql -d hrp_registry -f 01_registry.sql

psql -d hrp_registry -c "SELECT register_organisation(
  'acme-ltd','Acme Ltd','private','120/AB12345','owner@acme.example','kms/uk/key-001');"

./provision.sh create
./provision.sh status
TARGET_VERSION=2 ./provision.sh migrate
```
