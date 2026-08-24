# Changelog

## 0.7.0

HMRC Real Time Information. FPS and EPS generated as GovTalk XML and validated
against HMRC's own 2026-27 schemas.

- Full Payment Submission covering starters, leavers, directors on the annual
  NI basis, Scottish and Welsh tax regimes, emergency codes, student and
  postgraduate loans, and the NI earnings bands
- Employer Payment Summary covering statutory reclaims, NIC compensation, the
  Employment Allowance, the Apprenticeship Levy, no-payment periods and
  periods of inactivity
- IRmark computed as a canonicalised SHA-1 digest with the mark removed
- GovTalk envelope with the correct message classes
- Input validation that names the employee causing each problem, so a
  rejection is diagnosed before HMRC sees it

Five things the schema required that would each have caused a rejection, and
that were only found by validating against it:

- **The PAYE reference is two fields.** 120/AB12345 splits into OfficeNo and
  PayeRef; sending the whole string as either is invalid.
- **The tax code is a code, a regime and a basis.** S1257L W1 is the code
  1257L with a TaxRegime attribute of S and BasisNonCumulative of yes.
- **StudentLoanRecovered needs a mandatory PlanType attribute**, and Plan 5
  has no code in the 2026-27 enumeration.
- **Four fields are whole pounds**, not pence: the student loan figures and
  earnings at the Lower Earnings Limit.
- **EPS element order differs from FPS.** RelatedTaxYear sits near the end,
  and the no-payment flag and its dates are an inseparable pair.

Also fixed: money formatting used toFixed alone, so 100.005 rounded down
because it is held as 100.00499. It now matches the calculation engine.

Submission still requires HMRC recognition and credentials.

## 0.6.0

Self-service onboarding. A company signs up with its name and ends up with its
own database at its own subdomain.

- Company name becomes a subdomain: "Northgate Logistics Ltd" gives
  `northgate-logistics`. Reserved names are refused and alternatives offered.
- Email verification, then **manual approval**. Handing someone a system that
  holds their employees' bank details on the strength of a web form is not a
  decision to automate away.
- Provisioning creates the database and applies the schema and every tenant
  migration. Idempotent, and a failure leaves the tenant in `failed` for a
  person to look at rather than silently destroying a half-built database.
- Owner invitation, password, MFA. The database refuses an owner without MFA,
  so the membership is not accepted until it is enrolled.
- Decommissioning keeps the data by default — payroll records must be kept six
  years — and dropping a database requires typing the organisation's name.

Fixed, all found by the tests:

- Approval checked whether the slug was taken and counted the very request it
  was approving, so no registration could ever be approved.
- **Registry and tenant migrations were in one folder**, so a registry
  migration was being applied to every new tenant database. They are now in
  separate folders and a startup guard fails loudly if either is missing.
- Onboarding never collected a PAYE reference, so the database correctly
  refused to activate the organisation. It is collected at signup, and there
  is now a route to supply it afterwards.

## 0.5.0

Microsoft Entra ID single sign-on.

- Multi-tenant OIDC with PKCE. Replaces the password step and nothing else —
  tenancy, permissions, MFA gating and audit are unchanged after sign-in.
- **An organisation is bound to one Entra directory**, and a token is accepted
  only if its `tid` claim matches. Matching on email address instead would let
  anyone who can create alice@acme.example in their own directory sign in to
  Acme's payroll. The test suite performs exactly that attack and confirms it
  is refused.
- MFA is read from the token's `amr` claim, so it reflects how the person
  actually authenticated rather than a flag we set ourselves.
- Automatic user creation is off by default; when switched on, new accounts
  get the least privileged role.
- Enforced SSO closes the password route for that organisation.
- Token validation rejects `alg: none`, HS256, wrong audience, non-Microsoft
  issuers, an issuer disagreeing with its tenant claim, expiry, and nonce
  mismatch.

Fixed, and both were real:

- The audit trail's foreign key used the default RESTRICT, so **a user with any
  audit history could never be deleted** — which would have made UK GDPR
  erasure impossible. Now SET NULL, with the email captured at the time so the
  trail stays readable.
- That change then collided with the append-only trigger, because SET NULL
  performs an UPDATE. The trigger now permits exactly one thing — severing the
  link to an erased person — and still refuses every attempt to alter what
  happened, when, or by whom.

Migration 4 applies both to the registry database.

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
