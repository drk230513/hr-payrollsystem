/* ============================================================================
   AUTHENTICATION
   ----------------------------------------------------------------------------
   Sessions live in the registry, not in a tenant database, because one person
   can belong to more than one organisation. The session identifies the person;
   the subdomain identifies the organisation; membership links them.

   Session tokens are stored hashed. If the registry is read, the tokens in it
   cannot be replayed.
   ========================================================================== */

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const db = require("./db");

const SESSION_COOKIE = "hrp_session";
const SESSION_HOURS = Number(process.env.SESSION_HOURS || 12);
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MINUTES = 15;

const hashToken = t => crypto.createHash("sha256").update(t).digest("hex");

async function ensureSessionTable(){
  await db.registry().query(`
    CREATE TABLE IF NOT EXISTS registry.sessions (
      token_hash  text PRIMARY KEY,
      user_id     uuid NOT NULL REFERENCES registry.users(id) ON DELETE CASCADE,
      created_at  timestamptz NOT NULL DEFAULT now(),
      expires_at  timestamptz NOT NULL,
      ip          inet,
      user_agent  text
    );
    CREATE INDEX IF NOT EXISTS sessions_user_idx ON registry.sessions(user_id);
    CREATE INDEX IF NOT EXISTS sessions_expiry_idx ON registry.sessions(expires_at);
  `);
}

async function setPassword(userId, plain){
  if(!plain || plain.length < 12){
    throw new Error("password must be at least 12 characters");
  }
  const hash = await bcrypt.hash(plain, 12);
  await db.registry().query(
    "UPDATE registry.users SET password_hash = $1 WHERE id = $2", [hash, userId]);
}

/* Returns { ok, reason, user }. The reason is for logging, never for the
   response body — telling someone whether an address exists is a gift to
   anyone enumerating accounts. */
async function verifyPassword(email, plain){
  const { rows } = await db.registry().query(
    `SELECT id, email, password_hash, status, mfa_enrolled, failed_logins, locked_until
       FROM registry.users WHERE email = $1`, [email]);
  const user = rows[0];

  // Always spend the time hashing, even when the user does not exist, so the
  // response time does not reveal which addresses are registered.
  if(!user){
    await bcrypt.compare(plain || "x", "$2a$12$" + "x".repeat(53));
    return { ok:false, reason:"no_such_user" };
  }

  if(user.locked_until && new Date(user.locked_until) > new Date()){
    return { ok:false, reason:"locked", user };
  }
  if(user.status !== "active") return { ok:false, reason:"not_active", user };
  if(!user.password_hash)      return { ok:false, reason:"no_password", user };

  const match = await bcrypt.compare(plain || "", user.password_hash);
  if(!match){
    const failed = (user.failed_logins || 0) + 1;
    const lock = failed >= MAX_FAILED_LOGINS
      ? new Date(Date.now() + LOCKOUT_MINUTES * 60000) : null;
    await db.registry().query(
      "UPDATE registry.users SET failed_logins = $1, locked_until = $2 WHERE id = $3",
      [failed, lock, user.id]);
    return { ok:false, reason:"bad_password", user };
  }

  await db.registry().query(
    "UPDATE registry.users SET failed_logins = 0, locked_until = NULL, last_login_at = now() WHERE id = $1",
    [user.id]);
  return { ok:true, user };
}

async function createSession(userId, { ip, userAgent } = {}){
  const token = crypto.randomBytes(32).toString("hex");
  const expires = new Date(Date.now() + SESSION_HOURS * 3600000);
  await db.registry().query(
    `INSERT INTO registry.sessions(token_hash, user_id, expires_at, ip, user_agent)
     VALUES ($1,$2,$3,$4,$5)`,
    [hashToken(token), userId, expires, ip || null, (userAgent || "").slice(0,300)]);
  return { token, expires };
}

async function userForToken(token){
  if(!token) return null;
  const { rows } = await db.registry().query(
    `SELECT u.id, u.email, u.mfa_enrolled, u.status
       FROM registry.sessions s
       JOIN registry.users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now() AND u.status = 'active'`,
    [hashToken(token)]);
  return rows[0] || null;
}

async function destroySession(token){
  if(!token) return;
  await db.registry().query("DELETE FROM registry.sessions WHERE token_hash = $1", [hashToken(token)]);
}

async function destroyAllSessions(userId){
  await db.registry().query("DELETE FROM registry.sessions WHERE user_id = $1", [userId]);
}

async function purgeExpiredSessions(){
  const { rowCount } = await db.registry().query("DELETE FROM registry.sessions WHERE expires_at <= now()");
  return rowCount;
}

/* Attaches req.user when a valid session cookie is present. Never rejects on
   its own — that is requireAuth's job — so public routes still work. */
function loadUser(){
  return async function(req, res, next){
    try {
      const token = req.cookies ? req.cookies[SESSION_COOKIE] : null;
      req.sessionToken = token || null;
      req.user = token ? await userForToken(token) : null;
      next();
    } catch(err){ next(err); }
  };
}

/* Approving a payroll run requires MFA. The database enforces this for the
   membership row; this enforces it at request time, because a role granted
   before MFA was disabled must not keep working. */
function requireMfa(req, res, next){
  if(!req.user) return res.status(401).json({ error: "not_signed_in" });
  if(!req.user.mfa_enrolled) return res.status(403).json({ error: "mfa_required" });
  next();
}

function cookieOptions(){
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_HOURS * 3600000
  };
}

module.exports = {
  SESSION_COOKIE, ensureSessionTable, setPassword, verifyPassword,
  createSession, userForToken, destroySession, destroyAllSessions,
  purgeExpiredSessions, loadUser, requireMfa, cookieOptions,
  MAX_FAILED_LOGINS, LOCKOUT_MINUTES
};
