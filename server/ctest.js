/* Connector framework tests. Runs against a live PostgreSQL. */
process.env.PGHOST = process.env.PGHOST || "127.0.0.1";
process.env.PGPORT = process.env.PGPORT || "5432";
process.env.PGUSER = process.env.PGUSER || "postgres";
process.env.REGISTRY_DB = "hrp_registry";

const db = require("./src/db");
const connectors = require("./src/connectors");
const conn = require("./src/connections");
const J = require("../packages/journal.js");

let pass = 0, fail = 0;
function eq(l,g,w){ const o = JSON.stringify(g)===JSON.stringify(w); o?pass++:fail++;
  console.log((o?"  ok   ":"  FAIL ")+l+"  got="+JSON.stringify(g)+(o?"":"  want="+JSON.stringify(w))); }
const ok = (l,c) => eq(l, !!c, true);

const JOURNAL = {
  reference: "PAY-2026-27-P05", date: "2026-08-28",
  narrative: "Payroll for August 2026",
  lines: [
    { code:"7000", account:"Gross wages", type:"expense", debit:10000, credit:0, costCentre:"OPS" },
    { code:"7006", account:"Employer NI", type:"expense", debit:1200, credit:0, costCentre:"OPS" },
    { code:"2210", account:"PAYE payable", type:"liability", debit:0, credit:1800 },
    { code:"2211", account:"NI payable", type:"liability", debit:0, credit:2000 },
    { code:"2220", account:"Net wages payable", type:"liability", debit:0, credit:7400 }
  ],
  totalDebit: 11200, totalCredit: 11200, difference: 0, balanced: true, employeesIncluded: 5
};

(async () => {
console.log("\n--- the registry declares what exists, honestly ---");
const list = connectors.list();
ok("several connectors are declared", list.length >= 4);
ok("manual export is available today", list.find(c => c.id === "manual").available);
ok("Xero is declared but not available", list.find(c => c.id === "xero").available === false);
ok("and says why", list.find(c => c.id === "xero").unavailableReason.includes("app review"));
ok("Sage is split by product, not lumped together",
   list.filter(c => c.vendor && c.vendor.includes("Sage")).length >= 2);
ok("every unavailable connector gives a reason",
   list.filter(c => !c.available).every(c => c.unavailableReason && c.unavailableReason.length > 20));

console.log("\n--- an unavailable connector cannot be reached ---");
let threw = null;
try { connectors.requireAvailable("xero"); } catch(e){ threw = e; }
ok("Xero is refused", threw && threw.status === 409);
ok("with the reason, not a generic error", threw.message.includes("app review"));
threw = null;
try { connectors.requireAvailable("nonesuch"); } catch(e){ threw = e; }
eq("an unknown connector is a 404", threw && threw.status, 404);
ok("manual passes the check", connectors.requireAvailable("manual").id === "manual");

console.log("\n--- every connector renders the journal it claims to ---");
["manual","xero","sage50","sage_business_cloud","quickbooks"].forEach(id => {
  const c = connectors.get(id);
  const out = c.render(JOURNAL);
  ok(id + " produces output", out && out.body && out.body.length > 50);
  ok(id + " declares a content type", /csv|json/.test(out.type));
});
const xeroOut = JSON.parse(connectors.get("xero").render(JOURNAL).body);
eq("the Xero payload is a draft", xeroOut.Status, "DRAFT");
eq("and its lines net to zero",
   Math.round(xeroOut.JournalLines.reduce((s,l) => s + l.LineAmount, 0) * 100) / 100, 0);

console.log("\n--- posting an unimplemented connector throws rather than pretending ---");
threw = null;
try { connectors.get("xero").post(); } catch(e){ threw = e; }
ok("Xero posting refuses", threw && threw.status === 501);
threw = null;
try { connectors.get("manual").post(); } catch(e){ threw = e; }
ok("manual posting refuses too — it exports, it does not post", threw && threw.status === 501);

console.log("\n--- the journal hash identifies content, not timing ---");
const h1 = connectors.journalHash(JOURNAL);
const h2 = connectors.journalHash(JSON.parse(JSON.stringify(JOURNAL)));
eq("the same journal hashes the same", h1, h2);
const changed = JSON.parse(JSON.stringify(JOURNAL));
changed.lines[0].debit = 10001; changed.totalDebit = 11201;
ok("a changed amount changes the hash", connectors.journalHash(changed) !== h1);
const reordered = JSON.parse(JSON.stringify(JOURNAL));
reordered.narrative = "different wording entirely";
eq("but rewording the narrative does not", connectors.journalHash(reordered), h1);

console.log("\n--- credentials are encrypted at rest ---");
const secret = { access_token: "very-secret-token", refresh_token: "also-secret" };
const enc = conn.encrypt(secret, "tenant-key-1");
ok("the ciphertext is a buffer", Buffer.isBuffer(enc));
ok("the token does not appear in it", !enc.toString("utf8").includes("very-secret-token"));
ok("the right key decrypts it", conn.decrypt(enc, "tenant-key-1").access_token === "very-secret-token");
ok("a different key does not", conn.decrypt(enc, "tenant-key-2") === null);
const tampered = Buffer.from(enc); tampered[tampered.length - 1] ^= 0xff;
ok("tampering is detected, not silently accepted", conn.decrypt(tampered, "tenant-key-1") === null);

/* ---------- live database ---------- */
console.log("\n--- applying the connector migration ---");
const T = db.tenant("hrp_acme_ltd");
const fs = require("fs");
const sql = fs.readFileSync(__dirname + "/../database/migrations/tenant/3_connectors.sql", "utf8");
await T.query(sql);
ok("migration applied", true);
await T.query(sql);
ok("and is safe to re-run", true);

await T.query("TRUNCATE payroll.journal_postings, payroll.connection_authorisations, payroll.connections, payroll.account_mappings CASCADE");

console.log("\n--- every connector is listed for a tenant, connected or not ---");
let listed = await conn.listForTenant(T);
eq("all are shown", listed.length, connectors.list().length);
ok("none are connected yet", listed.every(c => c.status === "not_connected"));

console.log("\n--- connecting and disconnecting ---");
await conn.saveConnection(T, { provider:"manual", credentials:null,
  externalOrgName:"Manual export", actor:"alice@acme.example", keyId:"tenant-key-1" });
listed = await conn.listForTenant(T);
eq("manual now shows connected", listed.find(c => c.id === "manual").status, "connected");
eq("and by whom", listed.find(c => c.id === "manual").connectedBy, "alice@acme.example");

await conn.saveConnection(T, { provider:"xero", credentials:{ access_token:"tok-123" },
  externalOrgName:"Acme Ltd (Xero)", actor:"alice@acme.example", keyId:"tenant-key-1" });
const creds = await conn.credentialsFor(T, "xero");
eq("credentials round-trip through encryption", creds.access_token, "tok-123");
const raw = (await T.query("SELECT credentials_enc FROM payroll.connections WHERE provider='xero'")).rows[0];
ok("and the token is not readable in the database",
   !raw.credentials_enc.toString("utf8").includes("tok-123"));

await conn.disconnect(T, "xero", "alice@acme.example");
eq("disconnecting clears the credentials", await conn.credentialsFor(T, "xero"), null);
const after = (await T.query("SELECT credentials_enc, status FROM payroll.connections WHERE provider='xero'")).rows[0];
eq("the row is marked revoked", after.status, "revoked");
eq("and the ciphertext is gone, not just flagged", after.credentials_enc, null);

console.log("\n--- THE DOUBLE POST GUARD ---");
const runId = (await T.query("SELECT id FROM payroll.pay_runs LIMIT 1")).rows[0].id;
const first = await conn.recordPosting(T, { payRunId: runId, provider:"manual",
  journal: JOURNAL, actor:"alice@acme.example" });
ok("the first posting is recorded", !!first.id);
eq("with the journal reference", first.reference, "PAY-2026-27-P05");

let dup = null;
try {
  await conn.recordPosting(T, { payRunId: runId, provider:"manual", journal: JOURNAL, actor:"alice@acme.example" });
} catch(e){ dup = e; }
ok("a second posting of the same run is refused", dup && dup.status === 409);
ok("and it says the content is unchanged", dup.sameContent === true);
ok("naming the earlier posting", dup.existing && dup.existing.reference === "PAY-2026-27-P05");

console.log("\n--- a changed journal is refused differently ---");
const revised = { ...JOURNAL, lines: JOURNAL.lines.map(l =>
  l.code === "7000" ? { ...l, debit: 10500 } : l), totalDebit: 11700, totalCredit: 11700 };
revised.lines = revised.lines.map(l => l.code === "2220" ? { ...l, credit: 7900 } : l);
let dup2 = null;
try {
  await conn.recordPosting(T, { payRunId: runId, provider:"manual", journal: revised, actor:"alice@acme.example" });
} catch(e){ dup2 = e; }
ok("still refused", dup2 && dup2.status === 409);
ok("but flagged as changed, not identical", dup2.sameContent === false);

console.log("\n--- a different provider is allowed for the same run ---");
const second = await conn.recordPosting(T, { payRunId: runId, provider:"xero",
  journal: JOURNAL, actor:"alice@acme.example" });
ok("posting to Xero as well is permitted", !!second.id);
eq("two postings recorded", (await conn.postingsFor(T, runId)).length, 2);

console.log("\n--- superseding frees the slot without losing history ---");
await conn.supersedePosting(T, first.id, "alice@acme.example", "recalculated after a correction");
const third = await conn.recordPosting(T, { payRunId: runId, provider:"manual",
  journal: revised, actor:"alice@acme.example" });
ok("a corrected posting is now accepted", !!third.id);
const all = await conn.postingsFor(T, runId);
eq("the superseded one is kept for the audit trail", all.filter(p => p.status === "superseded").length, 1);
eq("three postings in total", all.length, 3);

console.log("\n--- the database refuses an unbalanced posting ---");
let bad = null;
try {
  await T.query(
    `INSERT INTO payroll.journal_postings(pay_run_id, provider, reference, total_debit, total_credit, line_count, payload_hash)
     VALUES ($1,'sage50','BAD-1',100,90,3,'x')`, [runId]);
} catch(e){ bad = e; }
ok("rejected outright", !!bad);
ok("and says why", /balance/i.test(bad.message));

console.log("\n--- OAuth state is single use and expires ---");
const authStart = await conn.beginAuthorisation(T, { provider:"xero", actor:"alice@acme.example",
  redirectUri:"https://acme-ltd.hr-payrollsystem.com/callback" }).catch(e => e);
ok("Xero cannot start authorisation while unavailable", authStart instanceof Error && authStart.status === 409);

// Temporarily treat manual as OAuth-capable to exercise the state machine
const manualConnector = connectors.get("manual");
manualConnector.requiresOAuth = true;
manualConnector.oauth = { usesPKCE: true };
const started = await conn.beginAuthorisation(T, { provider:"manual", actor:"alice@acme.example",
  redirectUri:"https://acme-ltd.hr-payrollsystem.com/callback" });
ok("a state value is issued", started.state && started.state.length >= 32);
ok("with a PKCE verifier", !!started.codeVerifier);
const consumed = await conn.consumeAuthorisation(T, started.state);
eq("it resolves to the right provider", consumed.provider, "manual");
let replay = null;
try { await conn.consumeAuthorisation(T, started.state); } catch(e){ replay = e; }
ok("and cannot be replayed", replay && replay.status === 400);
let forged = null;
try { await conn.consumeAuthorisation(T, "a-state-nobody-issued"); } catch(e){ forged = e; }
ok("a forged state is rejected", forged && forged.status === 400);
manualConnector.requiresOAuth = false;
delete manualConnector.oauth;

console.log("\n--- the chart of accounts is overridable ---");
eq("defaults are used when nothing is mapped", await conn.accountsFor(T), null);
await conn.setAccount(T, { purpose:"grossPay", code:"5000", name:"Staff costs",
  type:"expense", actor:"alice@acme.example" });
const mapped = await conn.accountsFor(T);
eq("the override is stored", mapped.grossPay.code, "5000");
eq("with the customer's own wording", mapped.grossPay.name, "Staff costs");
await conn.setAccount(T, { purpose:"grossPay", code:"5100", name:"Payroll costs",
  type:"expense", actor:"bob@acme.example" });
eq("and can be changed again", (await conn.accountsFor(T)).grossPay.code, "5100");

console.log("\n--- a journal built with a customer's own codes still balances ---");
const custom = { ...J.DEFAULT_ACCOUNTS,
  grossPay: { code:"5100", name:"Payroll costs", type:"expense" } };
const jc = J.buildJournal({
  run:{ exceptions:[], decisions:{} },
  payslips:[{ employeeId:"E1", gross:3000, net:2200,
              paye:{tax:400}, ni:{employee:200,employer:300},
              pension:{employee:200,employer:100}, studentLoan:{total:0},
              deductions:[], totalDeductions:800, employerCost:3400 }],
  employees:[{ id:"E1", costCentre:"OPS" }],
  period:{ n:5, taxYear:"2026/27", label:"August 2026", payDate:"2026-08-28" },
  org:{ shortName:"Acme" }, accounts: custom });
ok("it balances", jc.balanced);
ok("and uses the customer's code", jc.lines.some(l => l.code === "5100"));

console.log("\n============================================");
console.log("  " + pass + " passed, " + fail + " failed");
console.log("============================================\n");
await db.closeAll();
process.exit(fail ? 1 : 0);
})().catch(e => { console.error("\nFAILED:", e.message, e.stack); process.exit(1); });
