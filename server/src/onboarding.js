/* ============================================================================
   ONBOARDING
   ----------------------------------------------------------------------------
   A company signs up with its name, and ends up with its own database and a
   portal at its own subdomain.

   The sequence, and why it is a sequence:

     1. sign up            name, contact, desired subdomain
     2. verify the email   proves the address is reachable before any work
     3. approve            a person decides. See the note below.
     4. provision          create the database, apply the schema
     5. invite the owner   set a password, enrol MFA
     6. sign in            at acme-ltd.hr-payrollsystem.com

   Step 3 is deliberately manual. Handing someone a system that will hold their
   employees' bank details, on the strength of a web form, is not a decision to
   automate away. It is also a good answer in a procurement conversation.

   Creating databases from an HTTP request is the sharpest edge here. The name
   is derived from a slug that has already passed a regex, a reserved-word
   check and a uniqueness constraint, and is checked once more immediately
   before use. Nothing from the request reaches SQL directly.
   ========================================================================== */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const db = require("./db");
const auth = require("./auth");

const SCHEMA_DIR = path.join(__dirname, "..", "..", "database");

/* Held between sign-up and approval. The registration table has no column for
   it, and adding one is a registry migration rather than something to smuggle
   into this module. */
const pendingPaye = new Map();

/* ---------- 1. sign up --------------------------------------------------- */
async function signUp({ legalName, sector, contactEmail, contactName, requestedSlug,
                        employeeEstimate, companiesHouseNumber, payeReference }){
  const slug = normaliseSlug(requestedSlug || legalName);

  const problems = [];
  if(!legalName || legalName.trim().length < 2) problems.push("a company name is required");
  if(!contactEmail || !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(contactEmail)) problems.push("a valid email address is required");
  if(!slug) problems.push("that name cannot be used as a web address");
  // HMRC format, e.g. 120/AB12345. Not required to sign up, but required
  // before the organisation can go live — the database enforces that, and
  // asking now avoids a customer being provisioned and then stuck.
  if(payeReference && !/^[0-9]{3}\/[A-Z0-9]{1,10}$/i.test(payeReference.trim())){
    problems.push("the PAYE reference should look like 120/AB12345");
  }
  if(problems.length) throw Object.assign(new Error(problems.join("; ")), { status: 400 });

  const taken = await slugTaken(slug);
  if(taken) throw Object.assign(
    new Error("the address " + slug + " is already in use"), { status: 409, slug });

  const { rows } = await db.registry().query(
    `INSERT INTO registry.registration_requests
       (requested_slug, legal_name, sector, contact_email, companies_house_number, employee_estimate)
     VALUES ($1,$2,$3,$4,$5,$6)
     RETURNING id, requested_slug, verification_token`,
    [slug, legalName.trim(), sector || "private", contactEmail.toLowerCase().trim(),
     companiesHouseNumber || null, employeeEstimate || null]);

  if(payeReference){
    pendingPaye.set(rows[0].id, payeReference.trim().toUpperCase());
  }

  await db.registry().query(
    `INSERT INTO registry.audit_events(action, actor_email, detail)
     VALUES ('registration.requested',$1,$2)`,
    [contactEmail.toLowerCase().trim(), JSON.stringify({ slug, legalName })]);

  return {
    id: rows[0].id,
    slug: rows[0].requested_slug,
    // In production this is emailed, never returned. Returned here so the
    // flow is testable without a mail server.
    verificationToken: rows[0].verification_token
  };
}

/* A company name becomes a subdomain, so it has to survive being one. */
function normaliseSlug(input){
  const s = String(input || "").toLowerCase().trim()
    .replace(/&/g, " and ")
    .replace(/\b(ltd|limited|plc|llp|cic|inc|corp)\b/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 39)
    .replace(/-+$/, "");
  if(!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(s) || s.length < 3) return null;
  return s;
}

/* `exceptRequestId` matters when approving: the request being approved is
   itself an outstanding claim on the slug, and would otherwise block itself. */
async function slugTaken(slug, exceptRequestId){
  const { rows } = await db.registry().query(
    `SELECT 1 FROM registry.organisations WHERE slug = $1
      UNION ALL
     SELECT 1 FROM registry.reserved_slugs WHERE slug = $1
      UNION ALL
     SELECT 1 FROM registry.registration_requests
      WHERE requested_slug = $1 AND rejected_at IS NULL AND organisation_id IS NULL
        AND ($2::uuid IS NULL OR id <> $2::uuid)`, [slug, exceptRequestId || null]);
  return rows.length > 0;
}

/* Offers alternatives rather than just refusing. */
async function suggestSlugs(base){
  const root = normaliseSlug(base);
  if(!root) return [];
  const out = [];
  for(const candidate of [root, root + "-payroll", root + "-hr", root + "-uk", root + "-1", root + "-2"]){
    if(candidate.length <= 39 && !(await slugTaken(candidate))) out.push(candidate);
    if(out.length >= 3) break;
  }
  return out;
}

/* ---------- 2. verify the email ------------------------------------------ */
async function verifyEmail(token){
  const { rows } = await db.registry().query(
    `UPDATE registry.registration_requests SET verified_at = now()
      WHERE verification_token = $1 AND verified_at IS NULL AND rejected_at IS NULL
      RETURNING id, requested_slug, legal_name, contact_email`, [token]);
  if(!rows[0]) throw Object.assign(new Error("this verification link is invalid or already used"), { status: 400 });
  return rows[0];
}

/* ---------- 3. approve --------------------------------------------------- */
async function listPending(){
  const { rows } = await db.registry().query(
    `SELECT id, requested_slug, legal_name, sector, contact_email, employee_estimate,
            companies_house_number, verified_at, created_at
       FROM registry.registration_requests
      WHERE approved_at IS NULL AND rejected_at IS NULL
      ORDER BY created_at`);
  return rows;
}

async function reject(requestId, reason, actor){
  await db.registry().query(
    `UPDATE registry.registration_requests SET rejected_at = now(), rejection_reason = $2
      WHERE id = $1 AND approved_at IS NULL`, [requestId, reason || "not approved"]);
  await db.registry().query(
    `INSERT INTO registry.audit_events(action, actor_email, detail)
     VALUES ('registration.rejected',$1,$2)`,
    [actor, JSON.stringify({ requestId, reason })]);
}

/* Approval creates the organisation and queues provisioning. It does not
   create the database — that is a separate step so a failure there does not
   leave a half-approved request. */
async function approve(requestId, { actor, keyId, payeReference }){
  const { rows } = await db.registry().query(
    `SELECT * FROM registry.registration_requests WHERE id = $1`, [requestId]);
  const r = rows[0];
  if(!r) throw Object.assign(new Error("no such registration"), { status: 404 });
  if(r.approved_at) throw Object.assign(new Error("already approved"), { status: 409 });
  if(r.rejected_at) throw Object.assign(new Error("this registration was rejected"), { status: 409 });
  if(!r.verified_at) throw Object.assign(new Error("the contact address has not been verified"), { status: 409 });

  if(await slugTaken(r.requested_slug, requestId)){
    throw Object.assign(new Error("the address " + r.requested_slug + " was taken in the meantime"), { status: 409 });
  }

  return db.withTransaction(db.registry(), async client => {
    const paye = (payeReference || pendingPaye.get(requestId) || "").trim().toUpperCase() || null;
    const { rows: orgRows } = await client.query(
      `INSERT INTO registry.organisations(slug, legal_name, sector, paye_reference, status)
       VALUES ($1,$2,$3,$4,'provisioning') RETURNING id, slug`,
      [r.requested_slug, r.legal_name, r.sector, paye]);
    const org = orgRows[0];

    await client.query(
      `INSERT INTO registry.tenant_databases
         (organisation_id, database_name, host, encryption_key_id, status)
       VALUES ($1, registry.tenant_database_name($2), $3, $4, 'queued')`,
      [org.id, org.slug, process.env.PGHOST || "localhost", keyId || ("kms/uk/" + org.slug)]);

    const { rows: userRows } = await client.query(
      `INSERT INTO registry.users(email, status, mfa_enrolled)
       VALUES ($1,'invited',false)
       ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
       RETURNING id`, [r.contact_email]);

    await client.query(
      `INSERT INTO registry.memberships(organisation_id, user_id, role)
       VALUES ($1,$2,'owner')`, [org.id, userRows[0].id]);

    await client.query(
      `INSERT INTO registry.provisioning_jobs(organisation_id, kind, target_version)
       VALUES ($1,'create_database',$2)`, [org.id, currentSchemaVersion()]);

    await client.query(
      `UPDATE registry.registration_requests
          SET approved_at = now(), organisation_id = $2 WHERE id = $1`, [requestId, org.id]);

    await client.query(
      `INSERT INTO registry.audit_events(organisation_id, actor_email, action, detail)
       VALUES ($1,$2,'organisation.approved',$3)`,
      [org.id, actor, JSON.stringify({ slug: org.slug, legalName: r.legal_name })]);

    return { organisationId: org.id, slug: org.slug, ownerUserId: userRows[0].id };
  });
}

/* Registry migrations and tenant migrations live in separate folders.
   Mixing them meant a registry migration was applied to a tenant database
   during provisioning, which failed on a schema that does not exist there.
   The separation is structural so it cannot recur. */
const TENANT_MIGRATIONS = path.join(SCHEMA_DIR, "migrations", "tenant");
const REGISTRY_MIGRATIONS = path.join(SCHEMA_DIR, "migrations", "registry");

function currentSchemaVersion(){
  try {
    const files = fs.readdirSync(TENANT_MIGRATIONS)
      .map(f => parseInt(f, 10)).filter(n => !isNaN(n));
    return files.length ? Math.max(...files) : 1;
  } catch(e){ return 1; }
}

/* ---------- 4. provision ------------------------------------------------- */

/* Creates the database and applies the schema. Deliberately paranoid about the
   name: it comes from the registry, not the request, and is re-validated
   immediately before being interpolated. */
async function provision(organisationId, { onProgress } = {}){
  const { rows } = await db.registry().query(
    `SELECT o.slug, o.legal_name, t.database_name, t.status
       FROM registry.organisations o
       JOIN registry.tenant_databases t ON t.organisation_id = o.id
      WHERE o.id = $1`, [organisationId]);
  const t = rows[0];
  if(!t) throw Object.assign(new Error("no such organisation"), { status: 404 });
  if(t.status === "ready") return { alreadyProvisioned: true, database: t.database_name };

  db.assertSafeDatabaseName(t.database_name);
  const say = m => onProgress && onProgress(m);

  await db.registry().query(
    `UPDATE registry.tenant_databases SET status='provisioning' WHERE organisation_id=$1`, [organisationId]);
  await db.registry().query(
    `UPDATE registry.provisioning_jobs SET state='running', started_at=now(), attempts=attempts+1
      WHERE organisation_id=$1 AND kind='create_database' AND state='queued'`, [organisationId]);

  const admin = db.registry();
  try {
    const exists = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [t.database_name]);
    if(!exists.rows.length){
      // Identifiers cannot be parameterised, hence the re-validation above.
      await admin.query('CREATE DATABASE "' + t.database_name + '"');
      say("created " + t.database_name);
    } else {
      say(t.database_name + " already exists, reusing it");
    }

    const pool = db.tenant(t.database_name);
    const applied = await appliedVersions(pool);

    if(!applied.includes(1)){
      await pool.query(fs.readFileSync(path.join(SCHEMA_DIR, "02_tenant.sql"), "utf8"));
      say("applied the tenant schema");
    }

    for(const { version, file } of pendingMigrations(applied)){
      await pool.query(fs.readFileSync(file, "utf8"));
      await pool.query(
        `INSERT INTO payroll.schema_migrations(version, description)
         VALUES ($1,$2) ON CONFLICT DO NOTHING`, [version, path.basename(file)]);
      say("applied migration " + version);
    }

    const version = currentSchemaVersion();
    await db.registry().query(
      `UPDATE registry.tenant_databases
          SET status='ready', provisioned_at=now(), schema_version=$2
        WHERE organisation_id=$1`, [organisationId, version]);
    await db.registry().query(
      `UPDATE registry.provisioning_jobs SET state='succeeded', finished_at=now()
        WHERE organisation_id=$1 AND kind='create_database' AND state='running'`, [organisationId]);

    // The database refuses to activate an organisation with no PAYE reference,
    // which is correct: without one it cannot file anything. The database is
    // built and waiting; the organisation stays short of active until the
    // reference is supplied.
    const { rows: pr } = await db.registry().query(
      `SELECT paye_reference FROM registry.organisations WHERE id=$1`, [organisationId]);
    const activated = !!pr[0].paye_reference;
    if(activated){
      await db.registry().query(
        `UPDATE registry.organisations SET status='active', activated_at=now() WHERE id=$1`, [organisationId]);
    }
    await db.registry().query(
      `INSERT INTO registry.audit_events(organisation_id, action, detail)
       VALUES ($1,'tenant.provisioned',$2)`,
      [organisationId, JSON.stringify({ database: t.database_name, schemaVersion: version })]);

    return { database: t.database_name, schemaVersion: version, slug: t.slug,
             activated, awaiting: activated ? null : "a PAYE reference is needed before the organisation can go live" };
  } catch(err){
    // Left in 'failed', not rolled back. A half-built database is a thing a
    // person should look at, not something to silently destroy — it may
    // already hold data if this was a retry.
    await db.registry().query(
      `UPDATE registry.tenant_databases SET status='failed' WHERE organisation_id=$1`, [organisationId]);
    await db.registry().query(
      `UPDATE registry.provisioning_jobs SET state='failed', last_error=$2, finished_at=now()
        WHERE organisation_id=$1 AND kind='create_database' AND state='running'`,
      [organisationId, err.message.slice(0, 500)]);
    throw err;
  }
}

async function appliedVersions(pool){
  try {
    const { rows } = await pool.query("SELECT version FROM payroll.schema_migrations ORDER BY version");
    return rows.map(r => r.version);
  } catch(e){ return []; }
}

function pendingMigrations(applied){
  const dir = TENANT_MIGRATIONS;
  if(!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => /^\d+_.*\.sql$/.test(f))
    .map(f => ({ version: parseInt(f, 10), file: path.join(dir, f) }))
    .filter(m => !applied.includes(m.version))
    .sort((a,b) => a.version - b.version);
}

/* ---------- 5. invite the owner ------------------------------------------ */
async function createInvite(userId, organisationId, actor){
  await db.registry().query(`
    CREATE TABLE IF NOT EXISTS registry.invitations (
      token_hash      text PRIMARY KEY,
      user_id         uuid NOT NULL REFERENCES registry.users(id) ON DELETE CASCADE,
      organisation_id uuid NOT NULL REFERENCES registry.organisations(id) ON DELETE CASCADE,
      created_at      timestamptz NOT NULL DEFAULT now(),
      expires_at      timestamptz NOT NULL DEFAULT now() + interval '7 days',
      accepted_at     timestamptz
    )`);
  const token = crypto.randomBytes(32).toString("hex");
  await db.registry().query(
    `INSERT INTO registry.invitations(token_hash, user_id, organisation_id)
     VALUES ($1,$2,$3)`,
    [crypto.createHash("sha256").update(token).digest("hex"), userId, organisationId]);
  return token;
}

/* Accepting sets the password and activates the account. MFA is enrolled
   separately, and the database refuses an owner without it. */
async function acceptInvite(token, { password }){
  const hash = crypto.createHash("sha256").update(token).digest("hex");
  const { rows } = await db.registry().query(
    `SELECT i.user_id, i.organisation_id, u.email
       FROM registry.invitations i
       JOIN registry.users u ON u.id = i.user_id
      WHERE i.token_hash = $1 AND i.accepted_at IS NULL AND i.expires_at > now()`, [hash]);
  if(!rows[0]) throw Object.assign(new Error("this invitation is invalid or expired"), { status: 400 });

  await auth.setPassword(rows[0].user_id, password);
  await db.registry().query(
    `UPDATE registry.users SET status='active' WHERE id=$1`, [rows[0].user_id]);
  await db.registry().query(
    `UPDATE registry.invitations SET accepted_at=now() WHERE token_hash=$1`, [hash]);

  return { userId: rows[0].user_id, email: rows[0].email, organisationId: rows[0].organisation_id };
}

/* The owner's membership cannot be accepted until MFA is enrolled — the
   database enforces that — so this is the last step. */
async function enrolMfaAndActivate(userId, organisationId){
  await db.registry().query("UPDATE registry.users SET mfa_enrolled = true WHERE id = $1", [userId]);
  await db.registry().query(
    `UPDATE registry.memberships SET accepted_at = now()
      WHERE user_id = $1 AND organisation_id = $2 AND accepted_at IS NULL`,
    [userId, organisationId]);
}

/* ---------- decommission -------------------------------------------------
   The order is forced by the schema: tenant_databases references the
   organisation with RESTRICT, so an organisation cannot be removed while a
   database is still recorded against it. That is deliberate — it stops an
   organisation being deleted while its payroll data still exists somewhere.

   `dropDatabase` is off by default. Payroll records must be kept six years,
   so removing a customer usually means marking them closed, not destroying
   the data.
------------------------------------------------------------------------- */
async function decommission(organisationId, { actor, dropDatabase = false, confirmSlug }){
  const { rows } = await db.registry().query(
    `SELECT o.slug, t.database_name FROM registry.organisations o
       LEFT JOIN registry.tenant_databases t ON t.organisation_id = o.id
      WHERE o.id = $1`, [organisationId]);
  const t = rows[0];
  if(!t) throw Object.assign(new Error("no such organisation"), { status: 404 });

  // Destroying a customer's payroll history should require typing the name.
  if(dropDatabase && confirmSlug !== t.slug){
    throw Object.assign(
      new Error("to drop the database, confirm by supplying the organisation's address"),
      { status: 400 });
  }

  await db.registry().query(
    `UPDATE registry.organisations SET status='closed', closed_at=now() WHERE id=$1`, [organisationId]);
  await db.registry().query(
    `INSERT INTO registry.audit_events(organisation_id, actor_email, action, detail)
     VALUES ($1,$2,'organisation.closed',$3)`,
    [organisationId, actor, JSON.stringify({ slug: t.slug, databaseDropped: dropDatabase })]);

  if(!dropDatabase) return { closed: true, databaseRetained: t.database_name };

  db.assertSafeDatabaseName(t.database_name);
  await db.closeTenant(t.database_name);
  await db.registry().query(
    `UPDATE registry.tenant_databases SET status='decommissioned' WHERE organisation_id=$1`, [organisationId]);
  await db.registry().query('DROP DATABASE IF EXISTS "' + t.database_name + '"');
  await db.registry().query(`DELETE FROM registry.tenant_databases WHERE organisation_id=$1`, [organisationId]);
  return { closed: true, databaseDropped: t.database_name };
}

/* ---------- status ------------------------------------------------------- */
/* Supplying the PAYE reference is what finally activates an organisation. */
async function setPayeReference(organisationId, { payeReference, accountsOfficeReference, actor }){
  const paye = String(payeReference || "").trim().toUpperCase();
  if(!/^[0-9]{3}\/[A-Z0-9]{1,10}$/.test(paye)){
    throw Object.assign(new Error("the PAYE reference should look like 120/AB12345"), { status: 400 });
  }
  await db.registry().query(
    `UPDATE registry.organisations
        SET paye_reference=$2, accounts_office_reference=COALESCE($3, accounts_office_reference)
      WHERE id=$1`, [organisationId, paye, accountsOfficeReference || null]);

  const { rows } = await db.registry().query(
    `SELECT o.status, t.status AS db_status FROM registry.organisations o
       JOIN registry.tenant_databases t ON t.organisation_id=o.id WHERE o.id=$1`, [organisationId]);
  if(rows[0] && rows[0].db_status === "ready" && rows[0].status !== "active"){
    await db.registry().query(
      `UPDATE registry.organisations SET status='active', activated_at=now() WHERE id=$1`, [organisationId]);
  }
  await db.registry().query(
    `INSERT INTO registry.audit_events(organisation_id, actor_email, action, detail)
     VALUES ($1,$2,'organisation.paye_reference_set',$3)`,
    [organisationId, actor, JSON.stringify({ payeReference: paye })]);
  return { activated: true };
}

async function statusOf(slug){
  const { rows } = await db.registry().query(
    `SELECT o.slug, o.legal_name, o.status AS org_status,
            t.status AS db_status, t.schema_version, t.provisioned_at
       FROM registry.organisations o
       LEFT JOIN registry.tenant_databases t ON t.organisation_id = o.id
      WHERE o.slug = $1`, [slug]);
  return rows[0] || null;
}

/* Fails at startup if the schema files are not where they are expected.
   A missing migration otherwise surfaces halfway through provisioning a real
   customer, with a database already created. */
function assertSchemaFilesPresent(){
  const missing = [];
  if(!fs.existsSync(path.join(SCHEMA_DIR, "02_tenant.sql"))) missing.push("02_tenant.sql");
  if(!fs.existsSync(TENANT_MIGRATIONS)) missing.push("migrations/tenant/");
  if(!fs.existsSync(REGISTRY_MIGRATIONS)) missing.push("migrations/registry/");
  if(missing.length){
    throw new Error("schema files are missing from " + SCHEMA_DIR + ": " + missing.join(", "));
  }
  return true;
}

module.exports = {
  assertSchemaFilesPresent,
  signUp, normaliseSlug, slugTaken, suggestSlugs, verifyEmail,
  listPending, approve, reject, provision, setPayeReference, createInvite, acceptInvite,
  enrolMfaAndActivate, decommission, statusOf, currentSchemaVersion
};
