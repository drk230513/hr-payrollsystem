/* ============================================================================
   HTTP SERVER
   ----------------------------------------------------------------------------
   Route layout mirrors the tenancy model:

     /health, /api/auth/*        no tenant needed
     /api/*  on a tenant host    requires a session AND a live membership

   Every tenant route passes through requireMembership, which re-checks the
   registry on each request. There is no route that reads payroll data without
   that check, and none should ever be added.
   ========================================================================== */

const express = require("express");
const cookieParser = require("cookie-parser");

const db = require("./db");
const auth = require("./auth");
const tenancy = require("./tenancy");
const payroll = require("./payroll");
const connectors = require("./connectors");
const connections = require("./connections");
const ENGINE = require("../../packages/engine.js");
const JOURNAL = require("../../packages/journal.js");

function createApp({ baseDomain = process.env.BASE_DOMAIN || "hr-payrollsystem.com" } = {}){
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);

  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());
  app.use(auth.loadUser());
  app.use(tenancy.resolveTenant({ baseDomain }));

  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

  /* ---------------- public ---------------- */
  app.get("/health", (req, res) => res.json({ ok: true, tenant: req.tenantSlug || null }));

  app.post("/api/auth/login", wrap(async (req, res) => {
    const { email, password } = req.body || {};
    const result = await auth.verifyPassword(String(email || "").toLowerCase().trim(), password);
    if(!result.ok){
      // One message for every failure. Distinguishing "no such user" from
      // "wrong password" hands an attacker a list of valid addresses.
      return res.status(401).json({ error: "invalid_credentials" });
    }
    const { token } = await auth.createSession(result.user.id, {
      ip: req.ip, userAgent: req.headers["user-agent"]
    });
    res.cookie(auth.SESSION_COOKIE, token, auth.cookieOptions());
    res.json({ ok: true, user: { id: result.user.id, email: result.user.email, mfa: result.user.mfa_enrolled } });
  }));

  app.post("/api/auth/logout", wrap(async (req, res) => {
    await auth.destroySession(req.sessionToken);
    res.clearCookie(auth.SESSION_COOKIE, { path: "/" });
    res.json({ ok: true });
  }));

  app.get("/api/auth/me", tenancy.requireAuth, wrap(async (req, res) => {
    const orgs = await db.registry().query(
      `SELECT o.slug, o.legal_name, array_agg(m.role) AS roles
         FROM registry.memberships m
         JOIN registry.organisations o ON o.id = m.organisation_id
        WHERE m.user_id = $1 AND m.revoked_at IS NULL AND m.accepted_at IS NOT NULL
        GROUP BY o.slug, o.legal_name`, [req.user.id]);
    res.json({ user: { id: req.user.id, email: req.user.email, mfa: req.user.mfa_enrolled },
               organisations: orgs.rows });
  }));

  /* ---------------- tenant ---------------- */
  const tenantOnly = [tenancy.requireTenant, tenancy.requireAuth];

  app.get("/api/organisation", ...tenantOnly, tenancy.requireMembership("read"), wrap(async (req, res) => {
    res.json({
      slug: req.organisation.slug,
      name: req.organisation.legal_name,
      roles: req.roles,
      permissions: req.permissions
    });
  }));

  app.get("/api/employees", ...tenantOnly, tenancy.requireMembership("read"), wrap(async (req, res) => {
    const { rows } = await req.tenantDb.query(
      `SELECT employee_id, payroll_number, full_name, job_title, department,
              annual_salary, weekly_hours
         FROM payroll.v_current_remuneration ORDER BY full_name`);
    res.json({ employees: rows });
  }));

  app.post("/api/payroll/calculate", ...tenantOnly, tenancy.requireMembership("run_payroll"), wrap(async (req, res) => {
    const { taxYear, period } = req.body || {};
    const calc = await payroll.calculate(req.tenantDb, {
      taxYear, sequence: Number(period),
      config: ENGINE.DEFAULT_CONFIG, org: req.organisation
    });
    res.json({
      period: { taxYear, sequence: Number(period) },
      employees: calc.payslips.length,
      totals: calc.totals,
      reliefs: calc.reliefs,
      exceptions: calc.exceptions.map(x => ({
        ref: x.ref, severity: x.severity, title: x.title,
        subject: x.subject, amount: x.amount, evidence: x.evidence, action: x.action
      }))
    });
  }));

  /* Committing requires MFA as well as permission. This is the only action
     that moves money, so it carries the strictest gate in the application. */
  app.post("/api/payroll/commit", ...tenantOnly,
    tenancy.requireMembership("commit_payroll"), auth.requireMfa,
    wrap(async (req, res) => {
      const { taxYear, period, decisions } = req.body || {};
      try {
        const result = await payroll.commit(req.tenantDb, {
          taxYear, sequence: Number(period),
          config: ENGINE.DEFAULT_CONFIG, org: req.organisation,
          actor: req.user.email, decisions: decisions || {}
        });
        res.json({ ok: true, runId: result.runId, totals: result.totals });
      } catch(err){
        if(err.status === 409) return res.status(409).json({ error: "exceptions_undecided", undecided: err.undecided });
        throw err;
      }
    }));

  app.get("/api/payroll/journal", ...tenantOnly, tenancy.requireMembership("view_journal"), wrap(async (req, res) => {
    const journal = await payroll.journalFor(req.tenantDb, {
      taxYear: req.query.taxYear, sequence: Number(req.query.period),
      org: { shortName: req.organisation.legal_name }
    });
    const check = JOURNAL.validateJournal(journal);
    if(!check.valid) return res.status(500).json({ error: "journal_does_not_balance", problems: check.problems });

    if(req.query.format === "csv"){
      res.type("text/csv").attachment(journal.reference + ".csv").send(JOURNAL.journalToCSV(journal));
    } else if(req.query.format === "xero"){
      res.json(JOURNAL.journalToXero(journal));
    } else if(req.query.format === "sage"){
      res.type("text/csv").attachment(journal.reference + "-sage.csv").send(JOURNAL.journalToSage(journal));
    } else {
      res.json(journal);
    }
  }));

  /* ---------------- accounting connectors ---------------- */

  app.get("/api/connectors", ...tenantOnly, tenancy.requireMembership("view_journal"), wrap(async (req, res) => {
    res.json({ connectors: await connections.listForTenant(req.tenantDb) });
  }));

  /* Export in a connector's format. Works for every connector, including ones
     that cannot post yet — a customer with Xero can still hand the file over
     while app review is pending. */
  app.get("/api/connectors/:id/export", ...tenantOnly, tenancy.requireMembership("view_journal"), wrap(async (req, res) => {
    const c = connectors.get(req.params.id);
    const journal = await payroll.journalFor(req.tenantDb, {
      taxYear: req.query.taxYear, sequence: Number(req.query.period),
      org: { shortName: req.organisation.legal_name },
      accounts: await connections.accountsFor(req.tenantDb)
    });
    const check = JOURNAL.validateJournal(journal);
    if(!check.valid) return res.status(500).json({ error: "journal_does_not_balance", problems: check.problems });

    const out = c.render(journal, req.query.format);
    const ext = out.type.includes("json") ? "json" : "csv";
    res.type(out.type).attachment(journal.reference + "-" + c.id + "." + ext).send(out.body);
  }));

  /* Posting requires the permission to commit payroll, not merely to view the
     journal. Sending figures into a customer's accounts is not a read. */
  app.post("/api/connectors/:id/post", ...tenantOnly,
    tenancy.requireMembership("commit_payroll"), auth.requireMfa,
    wrap(async (req, res) => {
      const c = connectors.requireAvailable(req.params.id);
      if(!c.capabilities.post){
        return res.status(409).json({ error: "cannot_post", detail: c.name + " does not support direct posting" });
      }
      const { taxYear, period } = req.body || {};
      const journal = await payroll.journalFor(req.tenantDb, {
        taxYear, sequence: Number(period),
        org: { shortName: req.organisation.legal_name },
        accounts: await connections.accountsFor(req.tenantDb)
      });
      const check = JOURNAL.validateJournal(journal);
      if(!check.valid) return res.status(500).json({ error: "journal_does_not_balance", problems: check.problems });

      const p = await payroll.periodByNumber(req.tenantDb, taxYear, Number(period));
      const { rows } = await req.tenantDb.query(
        "SELECT id FROM payroll.pay_runs WHERE pay_period_id = $1 AND status = 'committed'", [p.id]);
      if(!rows[0]) return res.status(404).json({ error: "no_committed_run" });

      try {
        const posting = await connections.recordPosting({
          ...req.tenantDb, query: req.tenantDb.query.bind(req.tenantDb)
        }, { payRunId: rows[0].id, provider: c.id, journal, actor: req.user.email });
        res.json({ ok: true, posting });
      } catch(err){
        if(err.status === 409){
          return res.status(409).json({
            error: "already_posted",
            detail: err.sameContent
              ? "This run was already posted to " + c.name + " and the journal has not changed."
              : "This run was already posted to " + c.name + ", but the journal has since changed. Supersede the earlier posting first.",
            existing: err.existing
          });
        }
        throw err;
      }
    }));

  app.get("/api/connectors/postings", ...tenantOnly, tenancy.requireMembership("view_journal"), wrap(async (req, res) => {
    const p = await payroll.periodByNumber(req.tenantDb, req.query.taxYear, Number(req.query.period));
    if(!p) return res.status(404).json({ error: "not_found" });
    const { rows } = await req.tenantDb.query(
      "SELECT id FROM payroll.pay_runs WHERE pay_period_id = $1", [p.id]);
    if(!rows[0]) return res.json({ postings: [] });
    res.json({ postings: await connections.postingsFor(req.tenantDb, rows[0].id) });
  }));

  app.get("/api/connectors/accounts", ...tenantOnly, tenancy.requireMembership("view_journal"), wrap(async (req, res) => {
    const mapped = await connections.accountsFor(req.tenantDb);
    res.json({ accounts: mapped || JOURNAL.DEFAULT_ACCOUNTS, usingDefaults: !mapped });
  }));

  app.put("/api/connectors/accounts", ...tenantOnly, tenancy.requireMembership("manage_settings"), wrap(async (req, res) => {
    const entries = Object.entries(req.body || {});
    for(const [purpose, a] of entries){
      await connections.setAccount(req.tenantDb, {
        purpose, code: a.code, name: a.name, type: a.type, actor: req.user.email });
    }
    res.json({ ok: true, updated: entries.length });
  }));

  app.delete("/api/connectors/:id", ...tenantOnly, tenancy.requireMembership("manage_settings"), wrap(async (req, res) => {
    connectors.get(req.params.id);
    await connections.disconnect(req.tenantDb, req.params.id, req.user.email);
    res.json({ ok: true });
  }));

  /* ---------------- errors ---------------- */
  app.use((req, res) => res.status(404).json({ error: "not_found" }));

  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if(status >= 500) console.error("[error]", err.message, err.stack);
    // Internal messages never reach the client; they leak schema and paths.
    res.status(status).json({ error: status >= 500 ? "internal_error" : (err.message || "error") });
  });

  return app;
}

module.exports = { createApp };

if(require.main === module){
  (async () => {
    await auth.ensureSessionTable();
    const port = Number(process.env.PORT || 3100);
    createApp().listen(port, () => console.log("payroll api listening on " + port));
  })();
}
