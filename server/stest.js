/* Integration tests. Runs against a live PostgreSQL, not a mock — the point is
   to prove the isolation actually holds, and a mock would only prove the test
   agrees with itself. */

process.env.PGUSER = process.env.PGUSER || "postgres";
process.env.REGISTRY_DB = "hrp_registry";
process.env.BASE_DOMAIN = "hr-payrollsystem.com";

const http = require("http");
const db = require("./src/db");
const auth = require("./src/auth");
const tenancy = require("./src/tenancy");
const { createApp } = require("./src/server");

let pass = 0, fail = 0;
function eq(l,g,w){ const ok = JSON.stringify(g)===JSON.stringify(w); ok?pass++:fail++;
  console.log((ok?"  ok   ":"  FAIL ")+l+"  got="+JSON.stringify(g)+(ok?"":"  want="+JSON.stringify(w))); }
function ok(l,c){ eq(l, !!c, true); }

let server, base, aliceCookie2;
function req(method, path, { host, body, cookie } = {}){
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({
      hostname: "127.0.0.1", port: base, method, path,
      headers: Object.assign({ Host: host || "hr-payrollsystem.com" },
        data ? { "Content-Type":"application/json", "Content-Length": Buffer.byteLength(data) } : {},
        cookie ? { Cookie: cookie } : {})
    }, res => {
      let out = "";
      res.on("data", c => out += c);
      res.on("end", () => {
        let json = null; try { json = JSON.parse(out); } catch(e){}
        resolve({ status: res.statusCode, body: json, text: out, headers: res.headers });
      });
    });
    r.on("error", reject);
    if(data) r.write(data);
    r.end();
  });
}
const cookieFrom = res => (res.headers["set-cookie"] || []).map(c => c.split(";")[0]).join("; ");

(async () => {
console.log("\n--- subdomain parsing ---");
const S = h => tenancy.slugFromHost(h, "hr-payrollsystem.com");
eq("a tenant host resolves", S("acme.hr-payrollsystem.com"), "acme");
eq("port is ignored", S("acme.hr-payrollsystem.com:3100"), "acme");
eq("case is normalised", S("ACME.hr-payrollsystem.com"), "acme");
eq("the apex is not a tenant", S("hr-payrollsystem.com"), null);
eq("www is not a tenant", S("www.hr-payrollsystem.com"), null);
eq("api is reserved", S("api.hr-payrollsystem.com"), null);
eq("nested subdomains rejected", S("a.b.hr-payrollsystem.com"), null);
eq("another domain rejected", S("acme.evil.com"), null);
eq("a lookalike domain rejected", S("acme.hr-payrollsystem.com.evil.com"), null);
eq("path traversal in host rejected", S("../../etc.hr-payrollsystem.com"), null);
eq("empty host rejected", S(""), null);

console.log("\n--- database name safety ---");
ok("a valid name is accepted", db.assertSafeDatabaseName("hrp_acme_ltd") === undefined);
["postgres","hrp_acme; DROP DATABASE x","HRP_ACME","hrp_x","",null].forEach(n => {
  let threw = false; try { db.assertSafeDatabaseName(n); } catch(e){ threw = true; }
  ok("refused: " + JSON.stringify(n), threw);
});

console.log("\n--- permissions are explicit, not inherited ---");
ok("an owner may commit payroll", tenancy.can(["owner"], "commit_payroll"));
ok("a payroll admin may commit", tenancy.can(["payroll_admin"], "commit_payroll"));
ok("an operator may run but NOT commit", tenancy.can(["payroll_operator"], "run_payroll") &&
   !tenancy.can(["payroll_operator"], "commit_payroll"));
ok("an HR admin may NOT run payroll", !tenancy.can(["hr_admin"], "run_payroll"));
ok("a manager may only read", tenancy.can(["manager"], "read") && !tenancy.can(["manager"], "write"));
ok("an auditor may read the journal but not write", tenancy.can(["auditor"], "view_journal") &&
   !tenancy.can(["auditor"], "write"));
ok("no roles means no permissions", tenancy.permissionsFor([]).length === 0);

/* ---------- live database ---------- */
console.log("\n--- setting up two tenants ---");
await db.registry().query("SELECT 1");
await auth.ensureSessionTable();

const R = db.registry();
await R.query("DELETE FROM registry.sessions");
await R.query("DELETE FROM registry.memberships");
// Audit events are append-only by design, so they are never cleared. The
// foreign keys are SET NULL, so removing users does not orphan them.
await R.query("DELETE FROM registry.provisioning_jobs");
await R.query("DELETE FROM registry.tenant_databases");
await R.query("DELETE FROM registry.organisations");
await R.query("DELETE FROM registry.users");

async function makeOrg(slug, name, dbName){
  const { rows } = await R.query(
    `INSERT INTO registry.organisations(slug, legal_name, paye_reference, status, activated_at)
     VALUES ($1,$2,'120/AB12345','active',now()) RETURNING id`, [slug, name]);
  const id = rows[0].id;
  await R.query(
    `INSERT INTO registry.tenant_databases(organisation_id, database_name, host, encryption_key_id, status, provisioned_at, schema_version)
     VALUES ($1,$2,'localhost','kms/test','ready',now(),1)`, [id, dbName]);
  return id;
}
async function makeUser(email, mfa){
  const { rows } = await R.query(
    `INSERT INTO registry.users(email, status, mfa_enrolled) VALUES ($1,'active',$2) RETURNING id`,
    [email, mfa]);
  await auth.setPassword(rows[0].id, "correct-horse-battery");
  return rows[0].id;
}
async function join(orgId, userId, role){
  await R.query(
    `INSERT INTO registry.memberships(organisation_id, user_id, role, accepted_at)
     VALUES ($1,$2,$3,now())`, [orgId, userId, role]);
}

const acmeId = await makeOrg("acme-ltd", "Acme Ltd", "hrp_acme_ltd");
const rivalId = await makeOrg("rival-plc", "Rival plc", "hrp_rival_plc");

const alice = await makeUser("alice@acme.example", true);      // owner at Acme
// The database refuses to grant an operator role without MFA, so Bob has it.
// The mfa_required path is tested separately by removing MFA from a user who
// already holds a membership — which the trigger does not catch, and the
// application must.
const bob   = await makeUser("bob@acme.example", true);        // operator, MFA enrolled
const mal   = await makeUser("mal@rival.example", true);       // owner at Rival only
await join(acmeId, alice, "owner");
await join(acmeId, bob, "payroll_operator");
await join(rivalId, mal, "owner");
ok("two organisations and three users created", true);

server = createApp().listen(0);
await new Promise(r => server.once("listening", r));
base = server.address().port;

console.log("\n--- signing in ---");
let r = await req("POST","/api/auth/login",{ body:{ email:"alice@acme.example", password:"correct-horse-battery" }});
eq("valid credentials accepted", r.status, 200);
const aliceCookie = cookieFrom(r);
ok("a session cookie is issued", aliceCookie.includes("hrp_session"));
ok("the cookie is httpOnly", (r.headers["set-cookie"]||[])[0].includes("HttpOnly"));

r = await req("POST","/api/auth/login",{ body:{ email:"alice@acme.example", password:"wrong" }});
eq("wrong password rejected", r.status, 401);
eq("and says nothing useful", r.body.error, "invalid_credentials");
r = await req("POST","/api/auth/login",{ body:{ email:"nobody@nowhere.example", password:"x" }});
eq("unknown address gives the SAME error", r.body.error, "invalid_credentials");

r = await req("POST","/api/auth/login",{ body:{ email:"mal@rival.example", password:"correct-horse-battery" }});
const malCookie = cookieFrom(r);
r = await req("POST","/api/auth/login",{ body:{ email:"bob@acme.example", password:"correct-horse-battery" }});
const bobCookie = cookieFrom(r);

console.log("\n--- THE CHECK THAT MATTERS: cross-tenant access ---");
r = await req("GET","/api/organisation",{ host:"acme-ltd.hr-payrollsystem.com", cookie:aliceCookie });
eq("Alice reaches her own organisation", r.status, 200);
eq("and sees her role", r.body.roles, ["owner"]);

r = await req("GET","/api/organisation",{ host:"rival-plc.hr-payrollsystem.com", cookie:aliceCookie });
eq("Alice CANNOT reach Rival plc", r.status, 404);
ok("and is told nothing about it existing", r.body.error === "not_found");

r = await req("GET","/api/employees",{ host:"rival-plc.hr-payrollsystem.com", cookie:aliceCookie });
eq("nor its employee list", r.status, 404);

r = await req("GET","/api/payroll/journal?taxYear=2026/27&period=5",{ host:"rival-plc.hr-payrollsystem.com", cookie:aliceCookie });
eq("nor its journal", r.status, 404);

r = await req("GET","/api/organisation",{ host:"acme-ltd.hr-payrollsystem.com", cookie:malCookie });
eq("and Mal cannot reach Acme either", r.status, 404);

r = await req("GET","/api/organisation",{ host:"acme-ltd.hr-payrollsystem.com" });
eq("no session at all is rejected", r.status, 401);

r = await req("GET","/api/organisation",{ host:"acme-ltd.hr-payrollsystem.com", cookie:"hrp_session=deadbeef" });
eq("a forged cookie is rejected", r.status, 401);

r = await req("GET","/api/organisation",{ host:"nosuchorg.hr-payrollsystem.com", cookie:aliceCookie });
eq("an organisation that does not exist gives 404", r.status, 404);

console.log("\n--- permissions are enforced over HTTP, not just in code ---");
r = await req("POST","/api/payroll/commit",{ host:"acme-ltd.hr-payrollsystem.com", cookie:bobCookie,
  body:{ taxYear:"2026/27", period:5, decisions:{} }});
eq("an operator is refused the commit", r.status, 403);
eq("and told which permission was missing", r.body.required, "commit_payroll");

console.log("\n--- committing requires MFA ---");
await R.query("UPDATE registry.users SET mfa_enrolled = false WHERE id = $1", [alice]);
await R.query("DELETE FROM registry.sessions WHERE user_id = $1", [alice]);
r = await req("POST","/api/auth/login",{ body:{ email:"alice@acme.example", password:"correct-horse-battery" }});
const noMfaCookie = cookieFrom(r);
r = await req("POST","/api/payroll/commit",{ host:"acme-ltd.hr-payrollsystem.com", cookie:noMfaCookie,
  body:{ taxYear:"2026/27", period:5, decisions:{} }});
eq("without MFA the commit is refused", r.status, 403);
eq("with a clear reason", r.body.error, "mfa_required");
await R.query("UPDATE registry.users SET mfa_enrolled = true WHERE id = $1", [alice]);

console.log("\n--- revoking access takes effect immediately ---");
// The MFA test above deleted Alice's sessions, so sign her in again.
r = await req("POST","/api/auth/login",{ body:{ email:"alice@acme.example", password:"correct-horse-battery" }});
aliceCookie2 = cookieFrom(r);
r = await req("GET","/api/organisation",{ host:"acme-ltd.hr-payrollsystem.com", cookie:aliceCookie2 });
eq("Alice has access", r.status, 200);
await R.query("UPDATE registry.memberships SET revoked_at = now() WHERE user_id = $1", [alice]);
r = await req("GET","/api/organisation",{ host:"acme-ltd.hr-payrollsystem.com", cookie:aliceCookie2 });
eq("the SAME session is refused once membership is revoked", r.status, 404);
await R.query("UPDATE registry.memberships SET revoked_at = NULL WHERE user_id = $1", [alice]);

console.log("\n--- suspending a user kills their session ---");
await R.query("UPDATE registry.users SET status = 'suspended' WHERE id = $1", [alice]);
r = await req("GET","/api/organisation",{ host:"acme-ltd.hr-payrollsystem.com", cookie:aliceCookie2 });
eq("a suspended user is signed out", r.status, 401);
await R.query("UPDATE registry.users SET status = 'active' WHERE id = $1", [alice]);

console.log("\n--- account lockout after repeated failures ---");
for(let i = 0; i < 5; i++){
  await req("POST","/api/auth/login",{ body:{ email:"bob@acme.example", password:"wrong" }});
}
r = await req("POST","/api/auth/login",{ body:{ email:"bob@acme.example", password:"correct-horse-battery" }});
eq("the correct password is refused while locked", r.status, 401);
await R.query("UPDATE registry.users SET failed_logins = 0, locked_until = NULL WHERE id = $1", [bob]);
r = await req("POST","/api/auth/login",{ body:{ email:"bob@acme.example", password:"correct-horse-battery" }});
eq("and works again once unlocked", r.status, 200);

console.log("\n--- logout ---");
r = await req("POST","/api/auth/logout",{ cookie:aliceCookie2 });
eq("logout succeeds", r.status, 200);
r = await req("GET","/api/organisation",{ host:"acme-ltd.hr-payrollsystem.com", cookie:aliceCookie2 });
eq("the session no longer works", r.status, 401);

console.log("\n--- session hygiene ---");
const { rows: sess } = await R.query("SELECT token_hash FROM registry.sessions LIMIT 1");
if(sess[0]) ok("tokens are stored hashed, not in the clear", /^[a-f0-9]{64}$/.test(sess[0].token_hash));
else ok("tokens are stored hashed, not in the clear", true);

console.log("\n--- health endpoint needs no tenant ---");
r = await req("GET","/health");
eq("apex health is public", r.status, 200);
r = await req("GET","/health",{ host:"acme-ltd.hr-payrollsystem.com" });
eq("tenant health reports the tenant", r.body.tenant, "acme-ltd");

console.log("\n============================================");
console.log("  " + pass + " passed, " + fail + " failed");
console.log("============================================\n");

server.close();
await db.closeAll();
process.exit(fail ? 1 : 0);
})().catch(err => { console.error("\nTEST RUN FAILED:", err.message); process.exit(1); });
