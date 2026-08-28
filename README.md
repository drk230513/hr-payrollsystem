# HR & Payroll System — v0.9.0

Everything in one place. Start with the install script.

```bash
tar -xzf hr-payrollsystem-0.9.0.tar.gz
cd hr-payrollsystem
chmod +x install.sh
./install.sh full
```

## What each command does

| Command | Effect |
|---|---|
| `./install.sh site` | Website and demo only. Nothing else touched. |
| `./install.sh full` | Website, database and payroll API. |
| `./install.sh test` | Runs the test suites. Changes nothing. |
| `./install.sh testdb` | Creates the two databases the API tests need. |
| `./install.sh status` | What is running, and whether the site responds. |

## What is in the box

```
install.sh              one entry point for everything
VERSION                 0.2.0

packages/               the calculation libraries and their tests
  engine.js               PAYE, NI, pensions, student loans, statutory pay, leave
  automation.js           automation policy, delegation limits, cover mode
  journal.js              payroll to double-entry accounting
  rti.js                  HMRC FPS and EPS as GovTalk XML
  absence.js              occupational sick pay and enhanced family leave
  test.js atest.js jtest.js
  app.js app.css build.js builds the browser demo

server/                 the multi-tenant payroll API
  src/db.js               per-tenant connection pooling
  src/tenancy.js          subdomain resolution and the membership check
  src/auth.js             sessions, password verification, MFA gating
  src/payroll.js          engine + database + journal
  src/server.js           HTTP routes
  src/connectors/         registry of accounting systems
  src/connections.js      encrypted credentials, posting history
  src/sso.js              Microsoft Entra ID single sign-on
  src/onboarding.js       signup, approval, provisioning, invitations
  stest.js e2e.js         56 + 27 tests against a real database

database/               PostgreSQL schema
  01_registry.sql         control plane
  migrations/registry/    changes to the control plane
  migrations/tenant/      changes applied to every customer database: organisations, users, memberships
  02_tenant.sql           one database per customer
  provision.sh            create and migrate tenant databases

site/                   the public website
  index.html              landing page
  config.example.js       copy to config.js — the installer will not overwrite it
  demo/index.html         the interactive demo
  privacy terms dpa security
  deploy/                 docker compose, nginx, tunnel, runbook
  LAUNCH.md               what must happen before taking customers
```

## Test counts

| Suite | Covers | Assertions |
|---|---|---|
| `packages/test.js` | calculation engine | 86 |
| `packages/atest.js` | automation and cover mode | 72 |
| `packages/jtest.js` | accounting journal | 71 |
| `server/stest.js` | tenancy, auth, isolation | 56 |
| `server/e2e.js` | full payroll through the API | 27 |
| `server/ctest.js` | connectors, encryption, double-post guard | 69 |
| `server/ssotest.js` | Entra SSO, token validation, tenant binding | 54 |
| `server/otest.js` | signup, provisioning, invitation, decommission | 67 |
| `packages/rtest.js` | RTI FPS and EPS, validated against HMRC's schemas | 103 |
| `packages/abstest.js` | occupational absence, entitlement, rolling windows | 75 |
| | **total** | **605** |

The database suites need PostgreSQL running:

```bash
./install.sh testdb            # once, to create the test databases
RUN_DB_TESTS=1 ./install.sh test
```

Connection settings are read from `site/deploy/.env`, so this works whether
PostgreSQL is on 5432 or the container moved it to 5433.

## What works, and what does not

**Working:** the website, the interactive demo, the calculation engine, the
automation policy engine, the accounting journal, the multi-tenant database
schema, and a payroll API with authentication and tenant isolation.

**Not working yet:** there is no web interface for the payroll API. It has no
screens, no signup flow, no password reset and no email. The demo runs in the
browser and does not talk to the API.

**Blocked on accreditation:** HMRC RTI submission needs software recognition.
BACS payment needs a Service User Number. Neither is a development task.

See `site/LAUNCH.md` for the full position.


## HMRC schema validation

`packages/rtest.js` validates every generated document against HMRC's own
schemas. Those schemas are HMRC's and are not redistributed here — download
them from GOV.UK and place them in `specs/`:

```
specs/FullPaymentSubmission-2027-v1-0.xsd
specs/EmployerPaymentSummary-2027-v1-0.xsd
```

Requires `pip install xmlschema`. Without them the suite still runs and simply
reports that schema validation was skipped.
