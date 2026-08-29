# Changelog

## 0.11.5

- Occupational sick pay and named leave schemes were still listed as "built,
  not yet on screen" after both were wired into the demo. Understating what
  works is a smaller error than overstating it, but it is still wrong, and on
  a page whose whole argument is that its claims are checkable it matters
  more than usual. Both now read Live.

## 0.11.4

- Enquiry form question changed to "Where does your current system let you
  down?". The field name is unchanged, so existing submissions still map.

## 0.11.3

- **The enquiry form never worked from a browser.** `connect-src` in the
  security headers allowed Cloudflare Insights but not the form endpoint, so
  the browser blocked the request before it left the page. The endpoint itself
  was fine, which is why testing it with curl showed no problem — curl is not
  subject to a page's Content Security Policy. The bot submissions that did
  arrive went straight to the endpoint, bypassing the page, which made the form
  look like it was working.
- A blocked request now says so. A fetch stopped by policy throws a TypeError
  with no status and no body, which is indistinguishable from an outage unless
  the code checks for it.

## 0.11.2

- The enquiry form reported every failure as "That didn't send", which hid the
  one thing needed to fix it. It now reads the handler's response and shows
  what was actually refused — a rejected reCAPTCHA, a quota, a domain
  mismatch — and logs the status to the console.

## 0.11.1

- A proof strip beneath the hero: four things, three of which link straight
  into the demo where they can be checked in under a minute. The headline is
  unchanged — it is the proposition, and a list of features would weaken it.

## 0.11.0

Absence and leave are now in the demo, not just in the libraries.

- **New Absence tab** showing schemes, service bands, current absences with
  the split between full pay, half pay and unpaid, and remaining entitlement
  per person on a rolling twelve-month window.
- **Leave tab now shows named schemes**, entitlement per person in hours, and
  marks a scheme that falls below the statutory minimum.
- **Absence and leave exceptions now reach the commit gate** alongside the
  payroll ones. The seeded run raises a drop to half pay, an expiring
  carry-over, and an unlawful entitlement — all three of which a payroll
  manager would want to know about before the payslips go out.
- Landing page gains a **Depth** section separating what can be clicked
  through today from what is built but has no screen yet.

Fixed:

- `absence.js` and `leave.js` both define `serviceMonthsAt` and
  `entitlementFor`. Bundled into one scope the second silently overwrote the
  first, which would have shown up as leave entitlement calculated by the
  absence rules. Each now has its own namespace.
- The bundler stripped exports with a pattern that only matched the older
  `if(typeof module` guard, so the newer libraries kept their `module.exports`
  and the page failed to load. It now handles both forms and fails loudly
  rather than shipping a broken bundle.

## 0.10.0

Named leave schemes. Previously one entitlement sat on the employee record;
a large employer runs dozens, and Sovini has 46.

**`packages/leave.js`, 92 tests**

- Named schemes, assignable per employee, each with its own entitlement,
  accrual, carry-over and bank holiday treatment. Verified with all 46 at once.
- **The statutory minimum is 5.6 weeks capped at 28 days**, not 28 days for
  everyone. Three days a week is 16.8 days, and the cap never applies.
- **Irregular hours accrue at 12.07% of hours worked**, following
  *Harpur Trust v Brazel* and the 2024 reforms. Giving a casual worker a fixed
  annual figure is the error that case was about.
- **Carry-over expires, and carried hours are consumed first**, so an employee
  does not lose days they need not have lost.
- Long service increments, measured at the start of the leave year.
- Pro rata for starters and leavers, monthly accrual, minimum notice,
  maximum consecutive days, and team clash detection.
- A scheme below the statutory minimum raises a high-severity exception saying
  plainly that it is unlawful — but only for schemes that count toward it, so
  a two-day volunteering scheme is not wrongly flagged.

**Migration 6**, verified by attempting to violate every constraint:

- A scheme with no entitlement is refused unless it accrues on hours worked.
- Carry-over is recorded per employee per scheme per year, once.
- A scheme with requests against it cannot be deleted, only deactivated —
  deleting it would orphan the history.

Everything is held in hours. Someone on 43.75 hours and someone on 35 hours
both take "a day", and it costs them different amounts; holding days and
converting at the end is how part-time staff end up short-changed.

## 0.9.2

- `itest.js` needs jsdom, which was never declared as a dependency anywhere —
  it only ran where jsdom happened to be installed already. There is now a
  `packages/package.json` declaring it, and the installer installs it before
  running the suites.

## 0.9.1

- `itest.js` read the built demo relative to the working directory, so it only
  ran from the project root and failed from `packages/`. It now resolves the
  path relative to itself, and says what to run if the demo has not been built.
- The browser suite is now included in `./install.sh test`, which it never was
  — 249 assertions that were only running when invoked by hand.

## 0.9.0

Occupational absence, group structure, working patterns and timesheets. Driven
by a real tender: 9 PAYE schemes, 15 payrolls, 57 absence schemes with 100% of
staff entitled, and 5 FTE patterns worked as hours per day.

**Occupational absence** (`packages/absence.js`, 75 tests)

Company sick pay and enhanced family leave on top of the statutory minimum.
Four things it gets right that are commonly got wrong:

- **Entitlement is consumed, not reset.** Measured over a rolling window from
  the first day of the absence, so time off in March reduces what is available
  in October. An absence straddling the window edge is apportioned rather than
  counted whole.
- **Service is fixed at the start of the absence.** Crossing five years'
  service mid-absence does not move someone up a band part-way through.
- **Occupational pay is INCLUSIVE of statutory.** Full pay means normal pay, of
  which SSP forms part. Paying both is an overpayment, and a scheme configured
  to pay both raises an exception.
- **Weeks convert to days using the employee's own pattern**, so a part-timer
  gets the same weeks and fewer days.

Also: waiting days, non-working days that do not consume entitlement,
projection of when pay drops to half and then to nil, and the Bradford Factor
reported rather than acted upon.

**Migration 5** — group structure, verified against PostgreSQL by attempting
to violate every constraint:

- Many employers in one tenant. A duplicate PAYE reference is refused, and only
  one employer in a group may claim the Employment Allowance.
- Named working patterns as hours per day, not start and finish times.
- Absence schemes with service bands, and absences that cannot overlap for the
  same person.
- Imported absence history flagged, so it is never mistaken for something this
  system calculated.
- Timesheets for casual staff. Nobody may approve their own, and an approved
  timesheet cannot be edited — corrections go on a new sheet.

## 0.8.2

- **The P45 View button threw.** It called `openDoc()`, a function that was
  never defined. Download and Print worked, so the fault was in the handler
  rather than the document. It now opens in a dialog with its own Download and
  Print, matching how payslips already behave.
- **New test: every enabled button on every view is clicked** and the run
  fails if any throws. 80 buttons across 10 views.

  This is the test that should have existed already. The previous suite checked
  that views *rendered*, which is why three faults in a row — two dead buttons
  and an unusable dialog — were found by using the product rather than by
  running the tests.

## 0.8.1

- **The edit dialog could not be saved, closed or dismissed.** Modal buttons
  were bound with the same per-element helper used for the rest of the page,
  which attaches listeners only to elements that exist at that moment. Modal
  buttons are written in afterwards, so Save, Delete and Close received no
  listener at all and the only way out was reloading the page. Modal actions
  are now delegated from document.
- Escape and clicking the backdrop now close a dialog, so there is no way to
  become stuck in one.
- Nine regression tests covering save, delete, close, Escape, backdrop, and
  surviving a re-render.

## 0.8.0

- **P45 now works.** It was a permanently disabled button labelled "Not due"
  with nothing behind it — decoration on a legal obligation. A leaver
  certificates section lists anyone with a leaving date, produces Part 1A once
  their final pay is committed, and offers view, download and print.
  Week 1/month 1 leavers correctly report no cumulative total, and the
  document explains that Part 1 reaches HMRC through the FPS rather than
  separately.
- The journal view now has a test marker, so it is covered by the navigation
  suite like every other view.

Note on hourly pay: it already worked. Payroll → pay elements takes hours and
a rate, multiplies them, and the hours appear on the payslip against the rate
as section 8 requires. It is now covered by tests, but no behaviour changed.

## 0.7.1

- **Site settings moved into `site/config.js`**, which the installer creates
  once and never overwrites. The form endpoint, Turnstile key, company number,
  registered office and ICO reference were previously edited into index.html,
  so every upgrade reverted them and the enquiry form stopped working until
  somebody noticed. This happened three times.
- The anti-spam widget is now only rendered when a key is configured, instead
  of showing a permanent error on a fresh install.
- A **Compliance** section on the landing page: sixteen rows naming the
  specific statute and the specific mechanism that meets it — ERA 1996 s.8,
  the Working Time Regulations, *Harpur Trust v Brazel*, the Pensions Act,
  UK GDPR Articles 5, 17 and 22, six-year retention, FRS 102 and the CIPFA
  Code. What is not held is stated as plainly as what is.
- ICO registration reference added to the footer and the privacy notice.

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
