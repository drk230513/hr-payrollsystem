/* Onboarding tests. Actually creates a database, applies the schema, and runs
   a payroll in it — the whole chain from a company name to a working tenant. */
process.env.PGHOST = process.env.PGHOST || "127.0.0.1";
process.env.PGPORT = process.env.PGPORT || "5432";
process.env.PGUSER = process.env.PGUSER || "postgres";
process.env.REGISTRY_DB = process.env.REGISTRY_DB || "hrp_registry";
process.env.BASE_DOMAIN = "hr-payrollsystem.com";

const db = require("./src/db");
const onboarding = require("./src/onboarding");
const tenancy = require("./src/tenancy");
const auth = require("./src/auth");

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

const SLUG = "testco-" + Math.random().toString(36).slice(2, 7);
const DBNAME = "hrp_" + SLUG.replace(/-/g, "_");
const EMAIL = SLUG + "@example.com";

(async () => {
console.log("\n--- a company name becomes a web address ---");
eq("Ltd is dropped", onboarding.normaliseSlug("Northgate Logistics Ltd"), "northgate-logistics");
eq("plc too", onboarding.normaliseSlug("Rival plc"), "rival");
eq("ampersands are spelled out", onboarding.normaliseSlug("Smith & Jones"), "smith-and-jones");
eq("punctuation is stripped", onboarding.normaliseSlug("O'Brien's Haulage!"), "o-brien-s-haulage");
eq("accents and symbols go", onboarding.normaliseSlug("Café Ltd  "), "caf");
eq("a council keeps its words", onboarding.normaliseSlug("Thornbury Metropolitan Borough Council"),
   "thornbury-metropolitan-borough-council");
eq("something too short is refused", onboarding.normaliseSlug("A"), null);
eq("digits alone are refused", onboarding.normaliseSlug("123"), null);
eq("nothing is refused", onboarding.normaliseSlug(""), null);
ok("a very long name is truncated safely",
   onboarding.normaliseSlug("A".repeat(200) + " Company Limited").length <= 39);

console.log("\n--- reserved and taken names ---");
ok("www is taken", await onboarding.slugTaken("www"));
ok("api is taken", await onboarding.slugTaken("api"));
ok("hmrc is taken", await onboarding.slugTaken("hmrc"));
ok("an unused name is free", !(await onboarding.slugTaken(SLUG)));

console.log("\n--- signing up ---");
await refuses("no company name is refused", () => onboarding.signUp({ contactEmail:"a@b.com" }), "company name");
await refuses("a bad email is refused",
  () => onboarding.signUp({ legalName:"Test", contactEmail:"not-an-email" }), "email");
await refuses("a malformed PAYE reference is refused",
  () => onboarding.signUp({ legalName:"Test", contactEmail:"a@b.com", requestedSlug:"paye-check-" + SLUG,
                            payeReference:"ABC123" }), "120/AB12345");

const signup = await onboarding.signUp({
  legalName: "Test Co Limited", sector:"private",
  contactEmail: EMAIL, requestedSlug: SLUG, employeeEstimate: 40,
  payeReference: "120/AB12345" });
eq("the address is assigned", signup.slug, SLUG);
ok("a verification token is issued", signup.verificationToken && signup.verificationToken.length > 20);

await refuses("the same address cannot be requested twice",
  () => onboarding.signUp({ legalName:"Someone Else", contactEmail:"x@y.com", requestedSlug: SLUG }),
  "already in use");

console.log("\n--- alternatives are offered, not just refusal ---");
const suggestions = await onboarding.suggestSlugs("Test Co Limited");
ok("suggestions are made", suggestions.length > 0);
ok("and none of them are taken",
   (await Promise.all(suggestions.map(s => onboarding.slugTaken(s)))).every(t => !t));

console.log("\n--- approval requires a verified address ---");
let pending = await onboarding.listPending();
const mine = pending.find(p => p.requested_slug === SLUG);
ok("the request is waiting", !!mine);
eq("and not yet verified", mine.verified_at, null);

await refuses("it cannot be approved unverified",
  () => onboarding.approve(mine.id, { actor:"admin@hr-payrollsystem.com" }), "not been verified");

await refuses("a made-up token is refused", () => onboarding.verifyEmail("nonsense"), "invalid");
const verified = await onboarding.verifyEmail(signup.verificationToken);
eq("verification succeeds", verified.requested_slug, SLUG);
await refuses("and cannot be reused", () => onboarding.verifyEmail(signup.verificationToken), "invalid");

console.log("\n--- approving creates the organisation and queues the work ---");
const approved = await onboarding.approve(mine.id, { actor:"admin@hr-payrollsystem.com" });
eq("the organisation exists", approved.slug, SLUG);
ok("an owner was invited", !!approved.ownerUserId);

const st = await onboarding.statusOf(SLUG);
eq("but it is not active yet", st.org_status, "provisioning");
eq("and the database is only queued", st.db_status, "queued");

await refuses("it cannot be approved twice",
  () => onboarding.approve(mine.id, { actor:"admin@hr-payrollsystem.com" }), "already approved");

console.log("\n--- the subdomain does not work until provisioning finishes ---");
const orgBefore = await tenancy.organisationBySlug(SLUG);
ok("the organisation resolves", !!orgBefore);
ok("but is not ready to serve", orgBefore.status !== "active" || orgBefore.db_status !== "ready");

console.log("\n--- provisioning ---");
const steps = [];
const result = await onboarding.provision(approved.organisationId, { onProgress: m => steps.push(m) });
eq("the database is named from the slug", result.database, DBNAME);
ok("progress was reported", steps.length > 0);
steps.forEach(s => console.log("       " + s));

const after = await onboarding.statusOf(SLUG);
ok("it activated, because a PAYE reference was supplied", result.activated === true);
eq("the organisation is active", after.org_status, "active");
eq("the database is ready", after.db_status, "ready");
ok("at the current schema version", after.schema_version >= 1);

console.log("\n--- the tenant database is genuinely usable ---");
const pool = db.tenant(DBNAME);
const tables = await pool.query(
  "SELECT count(*)::int c FROM information_schema.tables WHERE table_schema='payroll' AND table_type='BASE TABLE'");
ok("the payroll schema is present", tables.rows[0].c > 20);
const mig = await pool.query("SELECT version FROM payroll.schema_migrations ORDER BY version");
ok("migrations were applied, not just the base schema", mig.rows.length >= 1);
console.log("       schema versions: " + mig.rows.map(r => r.version).join(", "));
const conns = await pool.query(
  "SELECT count(*)::int c FROM information_schema.tables WHERE table_name='connections'");
ok("connector tables came with it", conns.rows[0].c === 1);

console.log("\n--- provisioning again is harmless ---");
const again = await onboarding.provision(approved.organisationId);
ok("it reports the work was already done", again.alreadyProvisioned === true);

console.log("\n--- the new tenant is isolated from every other ---");
const empty = await pool.query("SELECT count(*)::int c FROM payroll.employees");
eq("it starts with no employees of its own", empty.rows[0].c, 0);
let crossed = null;
try { await pool.query("SELECT 1 FROM hrp_acme_ltd.payroll.employees"); } catch(e){ crossed = e; }
ok("and cannot reach another tenant's tables", crossed && /cross-database/i.test(crossed.message));

console.log("\n--- the owner sets a password and enrols MFA ---");
const invite = await onboarding.createInvite(approved.ownerUserId, approved.organisationId, "admin@hr-payrollsystem.com");
ok("an invitation is issued", invite.length > 30);
await refuses("a short password is refused",
  () => onboarding.acceptInvite(invite, { password:"short" }), "12 characters");
const accepted = await onboarding.acceptInvite(invite, { password:"a-properly-long-passphrase" });
eq("the owner is identified", accepted.email, EMAIL);
await refuses("the invitation cannot be reused",
  () => onboarding.acceptInvite(invite, { password:"another-long-passphrase" }), "invalid or expired");

const signIn = await auth.verifyPassword(EMAIL, "a-properly-long-passphrase");
ok("the owner can now authenticate", signIn.ok);

console.log("\n--- but has no access until MFA is enrolled ---");
let roles = await tenancy.rolesFor(approved.ownerUserId, approved.organisationId);
eq("the membership is not yet accepted", roles, []);
await onboarding.enrolMfaAndActivate(approved.ownerUserId, approved.organisationId);
roles = await tenancy.rolesFor(approved.ownerUserId, approved.organisationId);
eq("and now they are the owner", roles, ["owner"]);
ok("with the permission to commit payroll", tenancy.can(roles, "commit_payroll"));

console.log("\n--- the subdomain now serves ---");
const orgAfter = await tenancy.organisationBySlug(SLUG);
eq("the organisation is active", orgAfter.status, "active");
eq("its database is ready", orgAfter.db_status, "ready");
eq("and resolves from the host header",
   tenancy.slugFromHost(SLUG + ".hr-payrollsystem.com", "hr-payrollsystem.com"), SLUG);

console.log("\n--- a rejected registration goes no further ---");
const doomed = await onboarding.signUp({
  legalName:"Rejected Co", contactEmail:"reject-" + SLUG + "@example.com",
  requestedSlug:"rejected-" + SLUG });
await onboarding.verifyEmail(doomed.verificationToken);
const doomedId = (await onboarding.listPending()).find(p => p.requested_slug === "rejected-" + SLUG).id;
await onboarding.reject(doomedId, "could not verify the company", "admin@hr-payrollsystem.com");
await refuses("it cannot then be approved",
  () => onboarding.approve(doomedId, { actor:"admin@hr-payrollsystem.com" }), "rejected");
ok("and the address is free again", !(await onboarding.slugTaken("rejected-" + SLUG)));

console.log("\n--- decommissioning ---");
await refuses("dropping a database needs the name typed to confirm",
  () => onboarding.decommission(approved.organisationId, { actor:"admin", dropDatabase:true, confirmSlug:"wrong" }),
  "confirm");

const closedOnly = await onboarding.decommission(approved.organisationId, { actor:"admin@hr-payrollsystem.com" });
eq("closing keeps the data by default", closedOnly.databaseRetained, DBNAME);
eq("and the organisation is closed", (await onboarding.statusOf(SLUG)).org_status, "closed");
const stillThere = await db.registry().query("SELECT 1 FROM pg_database WHERE datname=$1", [DBNAME]);
eq("the database is still there — payroll records must be kept six years", stillThere.rows.length, 1);

const dropped = await onboarding.decommission(approved.organisationId,
  { actor:"admin@hr-payrollsystem.com", dropDatabase:true, confirmSlug: SLUG });
eq("with confirmation it is dropped", dropped.databaseDropped, DBNAME);
const gone = await db.registry().query("SELECT 1 FROM pg_database WHERE datname=$1", [DBNAME]);
eq("and it really is gone", gone.rows.length, 0);

// registration_requests also references the organisation, so the record of
// how a customer joined survives the organisation being closed. That is the
// right default; the test clears it only because this is a test.
await db.registry().query(
  "UPDATE registry.registration_requests SET organisation_id = NULL WHERE requested_slug = $1", [SLUG]);
await db.registry().query("DELETE FROM registry.organisations WHERE slug = $1", [SLUG]);
await db.registry().query("DELETE FROM registry.registration_requests WHERE requested_slug LIKE $1", ["%" + SLUG + "%"]);
ok("the registry entry can then be removed", true);

console.log("\n============================================");
console.log("  " + pass + " passed, " + fail + " failed");
console.log("============================================\n");
await db.closeAll();
process.exit(fail ? 1 : 0);
})().catch(e => { console.error("\nFAILED:", e.message, e.stack); process.exit(1); });
