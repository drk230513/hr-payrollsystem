/* ============================================================================
   TENANT RESOLUTION AND ACCESS CONTROL
   ----------------------------------------------------------------------------
   This is the highest-risk code in the product. A mistake here is not a bug,
   it is one company reading another company's payroll.

   The rule, stated once so it cannot drift:

       The subdomain says which tenant is being ASKED FOR.
       The session says who is ASKING.
       Access requires a live membership linking the two.

   The subdomain is never trusted on its own. It arrives from the browser and a
   browser can send anything. Every request re-checks membership against the
   registry rather than trusting something stamped into a cookie at login,
   because access revoked at 9am must not still work at 10am.
   ========================================================================== */

const db = require("./db");

const RESERVED = new Set(["www","app","api","admin","portal","status","mail","demo","docs","help","support"]);

/* ---------- subdomain --------------------------------------------------- */
function slugFromHost(host, baseDomain){
  if(!host) return null;
  const clean = String(host).toLowerCase().split(":")[0];
  const base = String(baseDomain || "").toLowerCase();
  if(!clean.endsWith("." + base)) return null;

  const prefix = clean.slice(0, -(base.length + 1));
  if(!prefix || prefix.includes(".")) return null;      // no nested subdomains
  if(RESERVED.has(prefix)) return null;
  if(!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(prefix)) return null;
  return prefix;
}

/* ---------- organisation lookup ----------------------------------------- */
async function organisationBySlug(slug){
  if(!slug) return null;
  const { rows } = await db.registry().query(
    `SELECT o.id, o.slug, o.legal_name, o.status,
            t.database_name, t.status AS db_status
       FROM registry.organisations o
       JOIN registry.tenant_databases t ON t.organisation_id = o.id
      WHERE o.slug = $1`, [slug]);
  return rows[0] || null;
}

/* ---------- the membership check ----------------------------------------
   Returns the roles this user holds in this organisation, or an empty array.
   An empty array means no access — there is no partial or implied access.
------------------------------------------------------------------------- */
async function rolesFor(userId, organisationId){
  if(!userId || !organisationId) return [];
  const { rows } = await db.registry().query(
    `SELECT m.role
       FROM registry.memberships m
       JOIN registry.users u ON u.id = m.user_id
      WHERE m.user_id = $1
        AND m.organisation_id = $2
        AND m.revoked_at IS NULL
        AND m.accepted_at IS NOT NULL
        AND u.status = 'active'`, [userId, organisationId]);
  return rows.map(r => r.role);
}

/* ---------- what each role may do ---------------------------------------
   Deliberately explicit rather than hierarchical. A hierarchy invites the
   assumption that a "higher" role inherits everything, and payroll approval is
   not something an HR administrator should inherit by accident.
------------------------------------------------------------------------- */
const PERMISSIONS = {
  owner:            ["read","write","run_payroll","commit_payroll","manage_users","manage_settings","view_journal"],
  payroll_admin:    ["read","write","run_payroll","commit_payroll","manage_settings","view_journal"],
  payroll_operator: ["read","write","run_payroll","view_journal"],
  hr_admin:         ["read","write","manage_settings"],
  manager:          ["read"],
  employee:         ["read_self"],
  auditor:          ["read","view_journal"]
};

function permissionsFor(roles){
  const set = new Set();
  (roles || []).forEach(r => (PERMISSIONS[r] || []).forEach(p => set.add(p)));
  return [...set];
}

function can(roles, permission){
  return permissionsFor(roles).includes(permission);
}

/* ---------- middleware ---------------------------------------------------
   Attaches req.tenant only when every condition holds. Anything short of that
   is a refusal, and the refusal is deliberately vague to the caller: telling
   an attacker whether an organisation exists is itself information.
------------------------------------------------------------------------- */
function resolveTenant({ baseDomain }){
  return async function(req, res, next){
    try {
      const slug = slugFromHost(req.headers.host, baseDomain);
      if(!slug) return next();                       // not a tenant host, carry on

      const org = await organisationBySlug(slug);
      if(!org || org.status !== "active" || org.db_status !== "ready"){
        return res.status(404).json({ error: "not_found" });
      }

      req.tenantSlug = slug;
      req.organisation = org;
      next();
    } catch(err){ next(err); }
  };
}

function requireTenant(req, res, next){
  if(!req.organisation) return res.status(404).json({ error: "not_found" });
  next();
}

function requireAuth(req, res, next){
  if(!req.user) return res.status(401).json({ error: "not_signed_in" });
  next();
}

/* The check that stops cross-tenant access. Runs on every request rather than
   at login, so revoking someone's access takes effect immediately. */
function requireMembership(permission){
  return async function(req, res, next){
    try {
      if(!req.user) return res.status(401).json({ error: "not_signed_in" });
      if(!req.organisation) return res.status(404).json({ error: "not_found" });

      const roles = await rolesFor(req.user.id, req.organisation.id);
      if(!roles.length){
        // 404 rather than 403: a signed-in user probing other subdomains
        // should not be able to discover which organisations exist.
        return res.status(404).json({ error: "not_found" });
      }

      if(permission && !can(roles, permission)){
        return res.status(403).json({ error: "insufficient_permission", required: permission });
      }

      req.roles = roles;
      req.permissions = permissionsFor(roles);
      req.tenantDb = db.tenant(req.organisation.database_name);
      next();
    } catch(err){ next(err); }
  };
}

module.exports = {
  slugFromHost, organisationBySlug, rolesFor, permissionsFor, can,
  resolveTenant, requireTenant, requireAuth, requireMembership,
  PERMISSIONS, RESERVED
};
