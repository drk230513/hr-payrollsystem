# Changelog

## 0.4.1

- `e2e.js` hardcoded the database user, so it ignored `PGUSER` and failed
  against any PostgreSQL not running as `postgres`. All three database suites
  now read the environment the same way.

## 0.4.0

Accounting connectors — the framework, not yet the integrations.

- Connector registry declaring Xero, Sage 50, Sage Business Cloud, QuickBooks
  and manual export. Each states plainly whether it is available and, if not,
  why. An unavailable connector cannot be reached by any route.
- Credentials encrypted per tenant with AES-256-GCM. Disconnecting clears the
  ciphertext rather than flagging the row.
- **Double-post protection.** One live posting per run per provider, enforced
  by a unique index. A repeat is refused and distinguishes "already sent,
  unchanged" from "already sent, but the journal has since changed".
- Superseding keeps the original posting for the audit trail.
- OAuth state is single-use, expires in fifteen minutes, and supports PKCE.
- Chart of accounts is overridable per tenant; the defaults are Sage-style
  codes that suit almost nobody exactly.
- The database refuses to record a posting that does not balance.

Fixed:

- Development and release layouts used different module paths, which is what
  broke the server suites in 0.2.0. Both now use `packages/`.
- A parameter served as both an enum value and a comparison, which PostgreSQL
  could not type-infer.

## 0.3.0

- The accounting journal is now visible in the demo: a Journal tab showing cost
  and liability side by side, with CSV, Sage 50 and Xero export
- Held records are excluded from the journal and the exclusion is shown

Fixed:

- The journal identified pension deductions by matching the word "pension" in
  the label, so any scheme named otherwise was counted twice and the journal
  did not balance. Categories are now derived arithmetically, which cannot be
  fooled by what a customer names their scheme.

## 0.2.1

Packaging fixes. No change to the calculation engine or the API.

- The server imported the engine and journal from the wrong path in the
  release layout, so `stest.js` and `e2e.js` could not start at all
- Test suites now honour `PGHOST`, `PGPORT`, `PGUSER` and `PGPASSWORD`
  instead of assuming a local PostgreSQL on 5432
- The installer detects a port collision on 5432 and moves our container
  rather than failing with a docker networking error that hides the cause
- New `./install.sh testdb` creates the two databases the API suites need

## 0.2.0

Added the backend.

- Multi-tenant payroll API: subdomain resolution, session authentication,
  per-tenant connection pooling, and a membership check re-run on every request
- Accounting journal engine with CSV, Xero and Sage exports
- Cover mode: delegation limits and plain-English guidance for a stand-in
- Reserved subdomains, so a customer cannot register `www` or `api`
- One installer for the whole release

Fixed:

- Journals were posting department codes instead of cost centres, which a
  finance system would not recognise
- Tenant schema is applied once and changes go through migrations; re-running
  it over a live database threw dozens of errors

## 0.1.0

- UK calculation engine: cumulative and non-cumulative PAYE including Scottish
  bands, NI across all categories plus the directors' annual basis, student and
  postgraduate loans, four pension earnings bases, statutory payments, leave
  held in hours
- Pre-commit assurance with exception detection and a commit gate
- Automation policy engine with manual, assisted and automated modes
- PostgreSQL schema: control plane plus one database per customer
- Public website, interactive demo, legal pages
