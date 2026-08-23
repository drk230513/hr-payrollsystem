/* ============================================================================
   CONNECTIONS
   ----------------------------------------------------------------------------
   Stores which finance system a tenant uses, holds the credentials encrypted,
   and records what has been posted.

   The double-post guard is the important part. Sending the same payroll
   journal into an accounting system twice doubles the month's wage cost and
   takes an accountant to unpick, so it is enforced by a unique index in the
   database rather than by a check in application code that a future route
   might forget to call.
   ========================================================================== */

const crypto = require("crypto");
const connectors = require("./connectors");

/* Credentials are encrypted with the tenant's own key. In production the key
   comes from KMS by reference; the fallback here keeps development working
   without pretending it is secure. */
function keyFor(keyId){
  const material = process.env.HRP_ENCRYPTION_KEY || "development-only-not-for-real-data";
  return crypto.createHash("sha256").update(material + "|" + (keyId || "default")).digest();
}

function encrypt(plain, keyId){
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyFor(keyId), iv);
  const enc = Buffer.concat([cipher.update(JSON.stringify(plain), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]);
}

function decrypt(buf, keyId){
  if(!buf || buf.length < 29) return null;
  const iv = buf.subarray(0, 12), tag = buf.subarray(12, 28), body = buf.subarray(28);
  const d = crypto.createDecipheriv("aes-256-gcm", keyFor(keyId), iv);
  d.setAuthTag(tag);
  try {
    return JSON.parse(Buffer.concat([d.update(body), d.final()]).toString("utf8"));
  } catch(err){
    // A failure here means the key is wrong or the data was tampered with.
    // Either way the credentials are unusable and must not be guessed at.
    return null;
  }
}

/* ---------- reading ------------------------------------------------------ */
async function listForTenant(pool){
  const { rows } = await pool.query(
    `SELECT provider, status, external_org_name, connected_at, connected_by,
            expires_at, last_used_at, last_error, auto_post
       FROM payroll.connections`);
  const stored = Object.fromEntries(rows.map(r => [r.provider, r]));

  // Every known connector is listed, whether the tenant has touched it or not.
  // Showing only connected ones hides the fact that others exist.
  return connectors.list().map(c => ({
    ...c,
    status: stored[c.id] ? stored[c.id].status : "not_connected",
    connectedTo: stored[c.id] ? stored[c.id].external_org_name : null,
    connectedAt: stored[c.id] ? stored[c.id].connected_at : null,
    connectedBy: stored[c.id] ? stored[c.id].connected_by : null,
    lastUsedAt: stored[c.id] ? stored[c.id].last_used_at : null,
    lastError: stored[c.id] ? stored[c.id].last_error : null,
    autoPost: stored[c.id] ? stored[c.id].auto_post : false
  }));
}

async function credentialsFor(pool, provider){
  const { rows } = await pool.query(
    `SELECT credentials_enc, encryption_key_id, status FROM payroll.connections WHERE provider = $1`,
    [provider]);
  if(!rows[0] || rows[0].status !== "connected") return null;
  return decrypt(rows[0].credentials_enc, rows[0].encryption_key_id);
}

async function saveConnection(pool, { provider, credentials, externalOrgId, externalOrgName,
                                      scopes, expiresAt, actor, keyId }){
  connectors.get(provider);                      // refuse an unknown provider
  await pool.query(
    `INSERT INTO payroll.connections
       (provider, status, credentials_enc, encryption_key_id, external_org_id,
        external_org_name, scopes, connected_at, connected_by, expires_at)
     VALUES ($1,'connected',$2,$3,$4,$5,$6,now(),$7,$8)
     ON CONFLICT (provider) DO UPDATE SET
       status='connected', credentials_enc=EXCLUDED.credentials_enc,
       encryption_key_id=EXCLUDED.encryption_key_id,
       external_org_id=EXCLUDED.external_org_id,
       external_org_name=EXCLUDED.external_org_name,
       scopes=EXCLUDED.scopes, connected_at=now(),
       connected_by=EXCLUDED.connected_by, expires_at=EXCLUDED.expires_at,
       last_error=NULL`,
    [provider, credentials ? encrypt(credentials, keyId) : null, keyId || "default",
     externalOrgId || null, externalOrgName || null, scopes || null, actor, expiresAt || null]);
}

async function disconnect(pool, provider, actor){
  // Credentials are cleared, not merely marked revoked. A token left in the
  // database after a customer disconnects is a token that can still be used.
  await pool.query(
    `UPDATE payroll.connections
        SET status='revoked', credentials_enc=NULL, expires_at=NULL, last_error=NULL
      WHERE provider=$1`, [provider]);
  await pool.query(
    `INSERT INTO payroll.audit_log(actor, action, entity, after)
     VALUES ($1,'connector.disconnected','connection',$2)`,
    [actor, JSON.stringify({ provider })]);
}

/* ---------- posting ------------------------------------------------------ */

/* Has this run already gone to this provider? Returns the live posting if so.
   Called before doing anything, so a repeat is refused early with a clear
   answer rather than at a database constraint. */
async function existingPosting(pool, payRunId, provider){
  const { rows } = await pool.query(
    `SELECT id, reference, status, external_id, external_url, posted_at, posted_by, payload_hash
       FROM payroll.journal_postings
      WHERE pay_run_id = $1 AND provider = $2
        AND status IN ('queued','sent','confirmed')`,
    [payRunId, provider]);
  return rows[0] || null;
}

async function recordPosting(pool, { payRunId, provider, journal, actor, status = "queued" }){
  const hash = connectors.journalHash(journal);
  const existing = await existingPosting(pool, payRunId, provider);

  if(existing){
    const err = new Error("this run has already been posted to " + provider);
    err.status = 409;
    err.existing = existing;
    err.sameContent = existing.payload_hash === hash;
    throw err;
  }

  const { rows } = await pool.query(
    `INSERT INTO payroll.journal_postings
       (pay_run_id, provider, reference, status, total_debit, total_credit,
        line_count, payload_hash, posted_by, posted_at)
     VALUES ($1,$2,$3,$4::payroll.post_status,$5,$6,$7,$8,$9,
             CASE WHEN $4::payroll.post_status = 'sent' THEN now() ELSE NULL END)
     RETURNING id, reference, status, payload_hash`,
    [payRunId, provider, journal.reference, status,
     journal.totalDebit, journal.totalCredit, journal.lines.length, hash, actor]);

  await pool.query(
    `INSERT INTO payroll.audit_log(actor, action, entity, entity_id, after)
     VALUES ($1,'journal.posted','pay_run',$2,$3)`,
    [actor, payRunId, JSON.stringify({
      provider, reference: journal.reference,
      debit: journal.totalDebit, credit: journal.totalCredit })]);

  return rows[0];
}

/* A correction supersedes rather than replaces. The original posting stays in
   the audit trail — an accountant asking "what did you send us in August"
   deserves a truthful answer including anything later withdrawn. */
async function supersedePosting(pool, postingId, actor, reason){
  await pool.query(
    `UPDATE payroll.journal_postings SET status='superseded', last_error=$2 WHERE id=$1`,
    [postingId, reason || "superseded by a corrected journal"]);
  await pool.query(
    `INSERT INTO payroll.audit_log(actor, action, entity, entity_id, after)
     VALUES ($1,'journal.superseded','journal_posting',$2,$3)`,
    [actor, postingId, JSON.stringify({ reason })]);
}

async function postingsFor(pool, payRunId){
  const { rows } = await pool.query(
    `SELECT provider, reference, status, total_debit, total_credit, line_count,
            external_id, external_url, posted_at, posted_by, attempts, last_error
       FROM payroll.journal_postings
      WHERE pay_run_id = $1 ORDER BY created_at DESC`, [payRunId]);
  return rows;
}

/* ---------- OAuth state -------------------------------------------------- */
async function beginAuthorisation(pool, { provider, actor, redirectUri }){
  const c = connectors.requireAvailable(provider);
  if(!c.requiresOAuth){
    throw Object.assign(new Error(c.name + " does not use authorisation"), { status: 400 });
  }
  const state = crypto.randomBytes(24).toString("hex");
  const verifier = c.oauth && c.oauth.usesPKCE ? crypto.randomBytes(32).toString("base64url") : null;
  await pool.query(
    `INSERT INTO payroll.connection_authorisations(state, provider, started_by, redirect_uri, code_verifier)
     VALUES ($1,$2,$3,$4,$5)`, [state, provider, actor, redirectUri, verifier]);
  return { state, codeVerifier: verifier };
}

/* Single use, and expires. A state value that can be replayed is a way for
   someone else's authorisation to be attached to this tenant. */
async function consumeAuthorisation(pool, state){
  const { rows } = await pool.query(
    `UPDATE payroll.connection_authorisations
        SET consumed_at = now()
      WHERE state = $1 AND consumed_at IS NULL AND expires_at > now()
      RETURNING provider, started_by, redirect_uri, code_verifier`, [state]);
  if(!rows[0]) throw Object.assign(new Error("authorisation state is invalid or expired"), { status: 400 });
  return rows[0];
}

async function purgeExpiredAuthorisations(pool){
  const { rowCount } = await pool.query(
    `DELETE FROM payroll.connection_authorisations WHERE expires_at <= now() AND consumed_at IS NULL`);
  return rowCount;
}

/* ---------- account mapping ---------------------------------------------- */
async function accountsFor(pool){
  const { rows } = await pool.query(
    `SELECT purpose, code, name, account_type FROM payroll.account_mappings`);
  if(!rows.length) return null;                  // fall back to the defaults
  const map = {};
  rows.forEach(r => map[r.purpose] = { code: r.code, name: r.name, type: r.account_type });
  return map;
}

async function setAccount(pool, { purpose, code, name, type, actor }){
  await pool.query(
    `INSERT INTO payroll.account_mappings(purpose, code, name, account_type, updated_by)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (purpose) DO UPDATE SET
       code=EXCLUDED.code, name=EXCLUDED.name, account_type=EXCLUDED.account_type,
       updated_at=now(), updated_by=EXCLUDED.updated_by`,
    [purpose, code, name, type, actor]);
}

module.exports = {
  listForTenant, credentialsFor, saveConnection, disconnect,
  existingPosting, recordPosting, supersedePosting, postingsFor,
  beginAuthorisation, consumeAuthorisation, purgeExpiredAuthorisations,
  accountsFor, setAccount, encrypt, decrypt
};
