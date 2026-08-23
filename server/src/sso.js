/* ============================================================================
   SINGLE SIGN-ON — MICROSOFT ENTRA ID
   ----------------------------------------------------------------------------
   Replaces the password step, and nothing else. Once a session exists, the
   tenancy check, permissions, MFA gate and audit behave exactly as before.

   THE RULE THAT MATTERS:

       An organisation is bound to ONE Entra tenant id.
       A token is accepted only if its `tid` claim matches that binding.

   Matching on email address instead would be a critical flaw: anyone able to
   create alice@acme.example inside their OWN Entra tenant could then sign in
   to Acme's payroll. The tenant id is the anchor; the email only identifies a
   person WITHIN an already-trusted tenant.

   Same discipline as the subdomain check — the token says who is asking, the
   registry says whether they are allowed.
   ========================================================================== */

const crypto = require("crypto");
const db = require("./db");

const ENTRA_BASE = "https://login.microsoftonline.com";

/* ---------- configuration ------------------------------------------------ */
function config(){
  return {
    clientId: process.env.ENTRA_CLIENT_ID || "",
    clientSecret: process.env.ENTRA_CLIENT_SECRET || "",
    redirectUri: process.env.ENTRA_REDIRECT_URI ||
      "https://app.hr-payrollsystem.com/api/auth/sso/callback",
    configured: !!(process.env.ENTRA_CLIENT_ID && process.env.ENTRA_CLIENT_SECRET)
  };
}

async function ensureTables(){
  await db.registry().query(`
    CREATE TABLE IF NOT EXISTS registry.organisation_sso (
      organisation_id  uuid PRIMARY KEY REFERENCES registry.organisations(id) ON DELETE CASCADE,
      provider         text NOT NULL DEFAULT 'entra',
      entra_tenant_id  text NOT NULL,
      tenant_domain    text,
      enabled          boolean NOT NULL DEFAULT false,

      -- Off by default. Most payroll customers want to control exactly who
      -- exists in the system; silently creating a user because someone in
      -- their directory clicked a link is rarely what they want.
      allow_jit        boolean NOT NULL DEFAULT false,
      jit_default_role text NOT NULL DEFAULT 'employee',

      -- When true, password sign-in is refused for this organisation.
      enforce_sso      boolean NOT NULL DEFAULT false,

      configured_by    text,
      configured_at    timestamptz NOT NULL DEFAULT now(),

      CONSTRAINT entra_tenant_is_guid CHECK (
        entra_tenant_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'),
      CONSTRAINT jit_role_valid CHECK (jit_default_role IN ('employee','manager','hr_admin','auditor'))
    );

    -- One Entra tenant maps to one organisation. Without this, two customers
    -- could bind the same directory and a user from one would resolve into
    -- the other.
    CREATE UNIQUE INDEX IF NOT EXISTS organisation_sso_tenant_unique
      ON registry.organisation_sso(entra_tenant_id) WHERE enabled;

    CREATE TABLE IF NOT EXISTS registry.sso_authorisations (
      state           text PRIMARY KEY,
      organisation_id uuid REFERENCES registry.organisations(id) ON DELETE CASCADE,
      nonce           text NOT NULL,
      code_verifier   text NOT NULL,
      redirect_to     text,
      created_at      timestamptz NOT NULL DEFAULT now(),
      expires_at      timestamptz NOT NULL DEFAULT now() + interval '10 minutes',
      consumed_at     timestamptz
    );
  `);
}

/* ---------- binding an organisation to a directory ----------------------- */
async function bind(organisationId, { entraTenantId, tenantDomain, actor,
                                      allowJit = false, enforceSso = false }){
  await db.registry().query(
    `INSERT INTO registry.organisation_sso
       (organisation_id, entra_tenant_id, tenant_domain, enabled, allow_jit, enforce_sso, configured_by)
     VALUES ($1,$2,$3,true,$4,$5,$6)
     ON CONFLICT (organisation_id) DO UPDATE SET
       entra_tenant_id = EXCLUDED.entra_tenant_id,
       tenant_domain   = EXCLUDED.tenant_domain,
       enabled = true, allow_jit = EXCLUDED.allow_jit,
       enforce_sso = EXCLUDED.enforce_sso,
       configured_by = EXCLUDED.configured_by, configured_at = now()`,
    [organisationId, entraTenantId, tenantDomain || null, allowJit, enforceSso, actor]);
}

async function unbind(organisationId, actor){
  await db.registry().query(
    `UPDATE registry.organisation_sso SET enabled = false, enforce_sso = false WHERE organisation_id = $1`,
    [organisationId]);
  await db.registry().query(
    `INSERT INTO registry.audit_events(organisation_id, action, detail)
     VALUES ($1,'sso.unbound',$2)`, [organisationId, JSON.stringify({ actor })]);
}

async function settingsFor(organisationId){
  const { rows } = await db.registry().query(
    `SELECT entra_tenant_id, tenant_domain, enabled, allow_jit, jit_default_role, enforce_sso
       FROM registry.organisation_sso WHERE organisation_id = $1`, [organisationId]);
  return rows[0] || null;
}

/* Which organisation, if any, trusts this directory. */
async function organisationForEntraTenant(tid){
  const { rows } = await db.registry().query(
    `SELECT o.id, o.slug, o.legal_name, s.allow_jit, s.jit_default_role, s.enforce_sso
       FROM registry.organisation_sso s
       JOIN registry.organisations o ON o.id = s.organisation_id
      WHERE s.entra_tenant_id = $1 AND s.enabled AND o.status = 'active'`, [tid]);
  return rows[0] || null;
}

/* ---------- starting a sign-in ------------------------------------------- */
function base64url(buf){ return buf.toString("base64url"); }

async function begin({ organisationId, redirectTo }){
  const c = config();
  if(!c.configured){
    throw Object.assign(new Error("single sign-on is not configured on this deployment"), { status: 501 });
  }

  const state = base64url(crypto.randomBytes(24));
  const nonce = base64url(crypto.randomBytes(16));
  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(crypto.createHash("sha256").update(verifier).digest());

  await db.registry().query(
    `INSERT INTO registry.sso_authorisations(state, organisation_id, nonce, code_verifier, redirect_to)
     VALUES ($1,$2,$3,$4,$5)`,
    [state, organisationId || null, nonce, verifier, redirectTo || null]);

  // `common` lets any Entra directory sign in; which ones are ACCEPTED is
  // decided afterwards by the tid check, not here.
  const authority = organisationId ? await authorityFor(organisationId) : "common";

  const params = new URLSearchParams({
    client_id: c.clientId,
    response_type: "code",
    redirect_uri: c.redirectUri,
    response_mode: "query",
    scope: "openid profile email offline_access User.Read",
    state, nonce,
    code_challenge: challenge,
    code_challenge_method: "S256"
  });

  return { url: `${ENTRA_BASE}/${authority}/oauth2/v2.0/authorize?${params}`, state };
}

async function authorityFor(organisationId){
  const s = await settingsFor(organisationId);
  return s && s.enabled ? s.entra_tenant_id : "common";
}

async function consumeState(state){
  const { rows } = await db.registry().query(
    `UPDATE registry.sso_authorisations SET consumed_at = now()
      WHERE state = $1 AND consumed_at IS NULL AND expires_at > now()
      RETURNING organisation_id, nonce, code_verifier, redirect_to`, [state]);
  if(!rows[0]) throw Object.assign(new Error("sign-in request is invalid or expired"), { status: 400 });
  return rows[0];
}

/* ---------- validating the token -----------------------------------------
   Written so it can be tested without calling Microsoft: the JWKS fetcher is
   injectable. The checks themselves are the point, not the transport.
------------------------------------------------------------------------- */
function decodeSegment(seg){
  return JSON.parse(Buffer.from(seg, "base64url").toString("utf8"));
}

function parseJwt(token){
  const parts = String(token || "").split(".");
  if(parts.length !== 3) throw Object.assign(new Error("malformed token"), { status: 401 });
  return {
    header: decodeSegment(parts[0]),
    payload: decodeSegment(parts[1]),
    signingInput: parts[0] + "." + parts[1],
    signature: Buffer.from(parts[2], "base64url")
  };
}

function verifySignature(jwt, jwk){
  if(!jwk) throw Object.assign(new Error("no signing key for this token"), { status: 401 });
  const key = crypto.createPublicKey({ key: jwk, format: "jwk" });
  const alg = jwt.header.alg;
  if(alg !== "RS256"){
    // `none` and symmetric algorithms are the classic JWT bypass. Only RS256
    // is accepted, whatever the token claims about itself.
    throw Object.assign(new Error("unsupported token algorithm: " + alg), { status: 401 });
  }
  const ok = crypto.verify("RSA-SHA256", Buffer.from(jwt.signingInput), key, jwt.signature);
  if(!ok) throw Object.assign(new Error("token signature is not valid"), { status: 401 });
}

/* Every check that stands between a token and a session. */
async function validateIdToken(idToken, { nonce, getKey, now = Date.now(), clientId }){
  const jwt = parseJwt(idToken);
  const p = jwt.payload;

  verifySignature(jwt, await getKey(jwt.header.kid));

  const aud = clientId || config().clientId;
  if(p.aud !== aud) throw Object.assign(new Error("token was issued for a different application"), { status: 401 });

  if(!/^https:\/\/login\.microsoftonline\.com\/[0-9a-fA-F-]{36}\/v2\.0$/.test(p.iss || "")){
    throw Object.assign(new Error("token issuer is not Microsoft Entra"), { status: 401 });
  }
  // The issuer embeds the directory id, and it must agree with the tid claim.
  const issuerTid = (p.iss.match(/([0-9a-fA-F-]{36})/) || [])[1];
  if(!p.tid || p.tid !== issuerTid){
    throw Object.assign(new Error("token issuer does not match its tenant claim"), { status: 401 });
  }

  if(!p.exp || p.exp * 1000 <= now) throw Object.assign(new Error("token has expired"), { status: 401 });
  if(p.nbf && p.nbf * 1000 > now + 300000) throw Object.assign(new Error("token is not yet valid"), { status: 401 });

  // Without the nonce check, a token obtained elsewhere could be replayed here.
  if(nonce && p.nonce !== nonce) throw Object.assign(new Error("token does not match this sign-in request"), { status: 401 });

  const email = (p.preferred_username || p.email || p.upn || "").toLowerCase().trim();
  if(!email) throw Object.assign(new Error("token carries no email address"), { status: 401 });

  return {
    entraTenantId: p.tid,
    subject: p.oid || p.sub,
    email,
    name: p.name || null,
    // Entra reports how the user actually authenticated on THIS sign-in, which
    // is a stronger statement than a flag we set ourselves.
    mfaSatisfied: Array.isArray(p.amr) && (p.amr.includes("mfa") || p.amr.includes("ngcmfa")),
    amr: p.amr || []
  };
}

/* ---------- turning a validated token into a session --------------------- */
async function resolveUser(claims){
  const org = await organisationForEntraTenant(claims.entraTenantId);
  if(!org){
    // Deliberately vague. Telling an unknown directory that it is unknown
    // confirms which directories ARE known.
    throw Object.assign(new Error("this directory is not permitted to sign in"), { status: 403 });
  }

  const { rows } = await db.registry().query(
    `SELECT u.id, u.email, u.status, u.mfa_enrolled
       FROM registry.users u
       JOIN registry.memberships m ON m.user_id = u.id
      WHERE u.email = $1 AND m.organisation_id = $2
        AND m.revoked_at IS NULL AND m.accepted_at IS NOT NULL`,
    [claims.email, org.id]);

  if(rows[0]){
    if(rows[0].status !== "active"){
      throw Object.assign(new Error("this account is not active"), { status: 403 });
    }
    // Entra asserted MFA on this sign-in, so record it rather than trusting
    // our own stale flag.
    if(claims.mfaSatisfied && !rows[0].mfa_enrolled){
      await db.registry().query("UPDATE registry.users SET mfa_enrolled = true WHERE id = $1", [rows[0].id]);
    }
    return { user: rows[0], organisation: org, created: false };
  }

  if(!org.allow_jit){
    throw Object.assign(
      new Error("no account exists for this address, and automatic creation is switched off"),
      { status: 403 });
  }

  const created = await db.registry().query(
    `INSERT INTO registry.users(email, status, mfa_enrolled) VALUES ($1,'active',$2)
     ON CONFLICT (email) DO UPDATE SET status = 'active'
     RETURNING id, email, status, mfa_enrolled`,
    [claims.email, !!claims.mfaSatisfied]);

  await db.registry().query(
    `INSERT INTO registry.memberships(organisation_id, user_id, role, accepted_at)
     VALUES ($1,$2,$3,now()) ON CONFLICT DO NOTHING`,
    [org.id, created.rows[0].id, org.jit_default_role]);

  await db.registry().query(
    `INSERT INTO registry.audit_events(organisation_id, actor_user_id, action, detail)
     VALUES ($1,$2,'sso.user_created',$3)`,
    [org.id, created.rows[0].id, JSON.stringify({ email: claims.email, role: org.jit_default_role })]);

  return { user: created.rows[0], organisation: org, created: true };
}

/* Whether password sign-in is still allowed for this address. */
async function passwordSignInPermitted(email){
  const { rows } = await db.registry().query(
    `SELECT bool_or(s.enforce_sso) AS enforced
       FROM registry.users u
       JOIN registry.memberships m ON m.user_id = u.id AND m.revoked_at IS NULL
       JOIN registry.organisation_sso s ON s.organisation_id = m.organisation_id AND s.enabled
      WHERE u.email = $1`, [email]);
  return !(rows[0] && rows[0].enforced);
}

module.exports = {
  config, ensureTables, bind, unbind, settingsFor, organisationForEntraTenant,
  begin, consumeState, validateIdToken, resolveUser, passwordSignInPermitted,
  parseJwt, verifySignature
};
