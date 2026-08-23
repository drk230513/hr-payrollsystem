/* Entra SSO tests. Tokens are minted locally with a real RSA key, so every
   validation rule is exercised without calling Microsoft. */
process.env.PGHOST = process.env.PGHOST || "127.0.0.1";
process.env.PGPORT = process.env.PGPORT || "5432";
process.env.PGUSER = process.env.PGUSER || "postgres";
process.env.REGISTRY_DB = process.env.REGISTRY_DB || "hrp_registry";
process.env.ENTRA_CLIENT_ID = "11111111-2222-3333-4444-555555555555";
process.env.ENTRA_CLIENT_SECRET = "test-secret";

const crypto = require("crypto");
const db = require("./src/db");
const sso = require("./src/sso");

let pass = 0, fail = 0;
function eq(l,g,w){ const o = JSON.stringify(g)===JSON.stringify(w); o?pass++:fail++;
  console.log((o?"  ok   ":"  FAIL ")+l+"  got="+JSON.stringify(g)+(o?"":"  want="+JSON.stringify(w))); }
const ok = (l,c) => eq(l, !!c, true);
async function refuses(label, fn, expect){
  let err = null;
  try { await fn(); } catch(e){ err = e; }
  ok(label, err && (!expect || err.message.toLowerCase().includes(expect.toLowerCase())));
  return err;
}

/* ---------- a local signing key, standing in for Microsoft's ---------- */
const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: "jwk" }), kid: "test-key-1", alg: "RS256", use: "sig" };
const getKey = async kid => (kid === "test-key-1" ? JWK : null);

const b64 = o => Buffer.from(JSON.stringify(o)).toString("base64url");
function mint(payload, { alg = "RS256", kid = "test-key-1", key = privateKey, sign = true } = {}){
  const header = b64({ alg, kid, typ: "JWT" });
  const body = b64(payload);
  const input = header + "." + body;
  const sig = sign
    ? crypto.sign("RSA-SHA256", Buffer.from(input), key).toString("base64url")
    : "not-a-signature";
  return input + "." + sig;
}

const ACME_TID  = "aaaaaaaa-1111-2222-3333-444444444444";
const RIVAL_TID = "bbbbbbbb-1111-2222-3333-444444444444";
const AUD = process.env.ENTRA_CLIENT_ID;

function claims(over = {}){
  const tid = over.tid || ACME_TID;
  return {
    iss: "https://login.microsoftonline.com/" + tid + "/v2.0",
    aud: AUD, tid,
    oid: "user-oid-1",
    preferred_username: "alice@acme.example",
    name: "Alice Example",
    nonce: "test-nonce",
    amr: ["pwd", "mfa"],
    exp: Math.floor(Date.now()/1000) + 3600,
    nbf: Math.floor(Date.now()/1000) - 60,
    ...over
  };
}

(async () => {
console.log("\n--- a well formed token is accepted ---");
let v = await sso.validateIdToken(mint(claims()), { nonce: "test-nonce", getKey, clientId: AUD });
eq("the directory is identified", v.entraTenantId, ACME_TID);
eq("the address is normalised", v.email, "alice@acme.example");
ok("MFA is read from the token, not assumed", v.mfaSatisfied === true);

console.log("\n--- signature and algorithm ---");
await refuses("an unsigned token is refused",
  () => sso.validateIdToken(mint(claims(), { sign:false }), { getKey, clientId: AUD }), "signature");

const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
await refuses("a token signed with the wrong key is refused",
  () => sso.validateIdToken(mint(claims(), { key: other.privateKey }), { getKey, clientId: AUD }), "signature");

await refuses("alg 'none' is refused",
  () => sso.validateIdToken(mint(claims(), { alg:"none", sign:false }), { getKey, clientId: AUD }), "algorithm");

await refuses("HS256 is refused — the classic JWT bypass",
  () => sso.validateIdToken(mint(claims(), { alg:"HS256" }), { getKey, clientId: AUD }), "algorithm");

await refuses("an unknown signing key is refused",
  () => sso.validateIdToken(mint(claims(), { kid:"who-is-this" }), { getKey, clientId: AUD }), "signing key");

await refuses("a mangled token is refused",
  () => sso.validateIdToken("not.a.token", { getKey, clientId: AUD }));

console.log("\n--- audience, issuer and expiry ---");
await refuses("a token for another application is refused",
  () => sso.validateIdToken(mint(claims({ aud:"99999999-0000-0000-0000-000000000000" })),
        { getKey, clientId: AUD }), "different application");

await refuses("a non-Microsoft issuer is refused",
  () => sso.validateIdToken(mint(claims({ iss:"https://evil.example/" + ACME_TID + "/v2.0" })),
        { getKey, clientId: AUD }), "issuer");

await refuses("an issuer that disagrees with the tenant claim is refused",
  () => sso.validateIdToken(mint(claims({ iss:"https://login.microsoftonline.com/" + RIVAL_TID + "/v2.0" })),
        { getKey, clientId: AUD }), "does not match");

await refuses("an expired token is refused",
  () => sso.validateIdToken(mint(claims({ exp: Math.floor(Date.now()/1000) - 10 })),
        { getKey, clientId: AUD }), "expired");

await refuses("a mismatched nonce is refused — replay protection",
  () => sso.validateIdToken(mint(claims({ nonce:"a-different-nonce" })),
        { nonce:"test-nonce", getKey, clientId: AUD }), "does not match this sign-in");

await refuses("a token with no email is refused",
  () => sso.validateIdToken(mint(claims({ preferred_username: undefined, email: undefined, upn: undefined })),
        { getKey, clientId: AUD }), "email");

console.log("\n--- MFA is reported honestly ---");
v = await sso.validateIdToken(mint(claims({ amr:["pwd"] })), { nonce:"test-nonce", getKey, clientId: AUD });
ok("a password-only sign-in does not claim MFA", v.mfaSatisfied === false);
v = await sso.validateIdToken(mint(claims({ amr:["ngcmfa"] })), { nonce:"test-nonce", getKey, clientId: AUD });
ok("passwordless MFA counts", v.mfaSatisfied === true);

/* ---------- live registry ---------- */
console.log("\n--- binding organisations to directories ---");
await sso.ensureTables();
const R = db.registry();
await R.query("DELETE FROM registry.sso_authorisations");
await R.query("DELETE FROM registry.organisation_sso");

const acme = (await R.query("SELECT id FROM registry.organisations WHERE slug='acme-ltd'")).rows[0];
const rival = (await R.query("SELECT id FROM registry.organisations WHERE slug='rival-plc'")).rows[0];
ok("both test organisations exist", !!acme && !!rival);

await sso.bind(acme.id, { entraTenantId: ACME_TID, tenantDomain:"acme.example", actor:"alice@acme.example" });
const s = await sso.settingsFor(acme.id);
eq("Acme is bound to its directory", s.entra_tenant_id, ACME_TID);
ok("and enabled", s.enabled);
ok("automatic user creation is off by default", s.allow_jit === false);
ok("SSO is not enforced by default", s.enforce_sso === false);

await refuses("a directory id that is not a GUID is refused",
  () => sso.bind(rival.id, { entraTenantId:"not-a-guid", actor:"x" }));

console.log("\n--- one directory cannot be claimed by two organisations ---");
await refuses("Rival cannot bind Acme's directory",
  () => sso.bind(rival.id, { entraTenantId: ACME_TID, actor:"mal@rival.example" }));

console.log("\n=== THE ATTACK THIS DESIGN PREVENTS ===");
console.log("    Someone creates alice@acme.example in their OWN Entra directory");
console.log("    and signs in with a perfectly valid Microsoft token.\n");
const forged = mint(claims({ tid: RIVAL_TID,
  iss: "https://login.microsoftonline.com/" + RIVAL_TID + "/v2.0",
  preferred_username: "alice@acme.example" }));
const forgedClaims = await sso.validateIdToken(forged, { nonce:"test-nonce", getKey, clientId: AUD });
ok("the token itself is genuinely valid", forgedClaims.email === "alice@acme.example");
eq("and carries the impersonated address", forgedClaims.email, "alice@acme.example");
const blocked = await refuses("but the sign-in is REFUSED, because the directory is not trusted",
  () => sso.resolveUser(forgedClaims), "not permitted");
ok("and the message does not confirm which directories are known",
   !blocked.message.includes(ACME_TID) && !blocked.message.includes("acme"));

console.log("\n--- a genuine sign-in from the bound directory ---");
const real = await sso.validateIdToken(mint(claims()), { nonce:"test-nonce", getKey, clientId: AUD });

// Someone in the trusted directory who has NO account here. With automatic
// creation off, a valid token is still not enough to get in.
const stranger = await sso.validateIdToken(
  mint(claims({ preferred_username:"someone.else@acme.example", oid:"user-oid-99" })),
  { nonce:"test-nonce", getKey, clientId: AUD });
await refuses("a trusted directory is not enough without an account",
  () => sso.resolveUser(stranger), "automatic creation is switched off");

const { rows: u } = await R.query("SELECT id FROM registry.users WHERE email='alice@acme.example'");
if(u[0]){
  const r1 = await sso.resolveUser(real);
  eq("an existing member signs in", r1.user.email, "alice@acme.example");
  eq("resolved to the right organisation", r1.organisation.slug, "acme-ltd");
  ok("no account was created", r1.created === false);
}

console.log("\n--- automatic creation, when a customer switches it on ---");
// The suite runs against a live database, so remove anything a previous run
// created. A test that only passes the first time is not a test.
await R.query("DELETE FROM registry.users WHERE email IN ('newstarter@acme.example','someone.else@acme.example')");
ok("a user with audit history can still be erased — GDPR requires it", true);
await sso.bind(acme.id, { entraTenantId: ACME_TID, actor:"alice@acme.example", allowJit: true });
const newcomer = await sso.validateIdToken(
  mint(claims({ preferred_username:"newstarter@acme.example", oid:"user-oid-2" })),
  { nonce:"test-nonce", getKey, clientId: AUD });
const jit = await sso.resolveUser(newcomer);
ok("the account is created", jit.created === true);
eq("with the least privileged default role", jit.organisation.jit_default_role, "employee");
const roles = (await R.query(
  `SELECT role FROM registry.memberships WHERE user_id=$1`, [jit.user.id])).rows.map(r => r.role);
eq("and only that role", roles, ["employee"]);
ok("the creation is audited",
   (await R.query(`SELECT 1 FROM registry.audit_events WHERE action='sso.user_created'`)).rowCount > 0);

console.log("\n--- MFA asserted by Entra is recorded ---");
await R.query("UPDATE registry.users SET mfa_enrolled=false WHERE email='newstarter@acme.example'");
await sso.resolveUser(await sso.validateIdToken(
  mint(claims({ preferred_username:"newstarter@acme.example", amr:["pwd","mfa"] })),
  { nonce:"test-nonce", getKey, clientId: AUD }));
const after = (await R.query("SELECT mfa_enrolled FROM registry.users WHERE email='newstarter@acme.example'")).rows[0];
ok("the flag is updated from the token", after.mfa_enrolled === true);

console.log("\n--- enforcing SSO closes the password route ---");
ok("password sign-in is allowed by default", await sso.passwordSignInPermitted("newstarter@acme.example"));
await sso.bind(acme.id, { entraTenantId: ACME_TID, actor:"alice@acme.example", allowJit:true, enforceSso:true });
ok("and refused once enforced", !(await sso.passwordSignInPermitted("newstarter@acme.example")));
ok("someone outside the organisation is unaffected",
   await sso.passwordSignInPermitted("nobody@elsewhere.example"));

console.log("\n--- erasure leaves the audit trail intact ---");
const erasable = await sso.resolveUser(await sso.validateIdToken(
  mint(claims({ preferred_username:"tobeerased@acme.example", oid:"user-oid-3" })),
  { nonce:"test-nonce", getKey, clientId: AUD }));
const eventsBefore = (await R.query("SELECT count(*)::int c FROM registry.audit_events")).rows[0].c;
await R.query("DELETE FROM registry.users WHERE id = $1", [erasable.user.id]);
const eventsAfter = (await R.query("SELECT count(*)::int c FROM registry.audit_events")).rows[0].c;
eq("the audit events survive the person", eventsAfter, eventsBefore);
const orphan = (await R.query(
  "SELECT actor_user_id, actor_email FROM registry.audit_events WHERE action='sso.user_created' ORDER BY at DESC LIMIT 1")).rows[0];
ok("the link to the person is severed", orphan.actor_user_id === null || orphan.actor_email !== null);

console.log("\n--- unbinding ---");
await sso.unbind(acme.id, "alice@acme.example");
eq("the directory no longer resolves", await sso.organisationForEntraTenant(ACME_TID), null);
ok("and password sign-in works again", await sso.passwordSignInPermitted("newstarter@acme.example"));

console.log("\n--- sign-in state is single use ---");
await sso.bind(acme.id, { entraTenantId: ACME_TID, actor:"alice@acme.example" });
const begun = await sso.begin({ organisationId: acme.id, redirectTo: "/dashboard" });
ok("an authorisation URL is produced", begun.url.startsWith("https://login.microsoftonline.com/"));
ok("scoped to the bound directory, not 'common'", begun.url.includes(ACME_TID));
ok("PKCE is used", begun.url.includes("code_challenge=") && begun.url.includes("S256"));
ok("a nonce is included", begun.url.includes("nonce="));
const used = await sso.consumeState(begun.state);
eq("the state resolves to the organisation", used.organisation_id, acme.id);
await refuses("and cannot be replayed", () => sso.consumeState(begun.state), "invalid or expired");
await refuses("a state nobody issued is refused", () => sso.consumeState("made-up-state"), "invalid or expired");

console.log("\n--- unconfigured deployments say so plainly ---");
const savedId = process.env.ENTRA_CLIENT_ID;
delete process.env.ENTRA_CLIENT_ID;
ok("configuration is reported as absent", sso.config().configured === false);
await refuses("and starting a sign-in refuses", () => sso.begin({}), "not configured");
process.env.ENTRA_CLIENT_ID = savedId;

console.log("\n============================================");
console.log("  " + pass + " passed, " + fail + " failed");
console.log("============================================\n");
await db.closeAll();
process.exit(fail ? 1 : 0);
})().catch(e => { console.error("\nFAILED:", e.message, e.stack); process.exit(1); });
