/* ============================================================================
   DATABASE ACCESS
   ----------------------------------------------------------------------------
   Two kinds of connection:

     registry  — one shared pool. Organisations, users, memberships, and the
                 map of which database belongs to whom. No payroll data.

     tenant    — one pool per customer database, created on first use and
                 cached. This is where the isolation lives: a tenant pool can
                 only ever see that tenant's tables, because PostgreSQL has no
                 cross-database references.

   Pools are capped deliberately. Each tenant holding twenty connections is how
   you exhaust a PostgreSQL server at forty customers, so the cap is low and
   PgBouncer sits in front in production.
   ========================================================================== */

const { Pool } = require("pg");

const CONFIG = {
  host: process.env.PGHOST || "localhost",
  port: Number(process.env.PGPORT || 5432),
  user: process.env.PGUSER || "postgres",
  password: process.env.PGPASSWORD || "",
  max: Number(process.env.PG_POOL_MAX || 4),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
};

const REGISTRY_DB = process.env.REGISTRY_DB || "hrp_registry";

const registryPool = new Pool({ ...CONFIG, database: REGISTRY_DB });
const tenantPools = new Map();

/* Tenant database names are derived from a validated slug, never from user
   input directly. The check here is belt and braces: if a name ever reaches
   this function that does not match the pattern, something has gone wrong
   upstream and we refuse rather than connect. */
function assertSafeDatabaseName(name){
  if(!/^hrp_[a-z0-9_]{3,50}$/.test(name || "")){
    throw new Error("refusing to connect to an unrecognised database name: " + name);
  }
}

function registry(){ return registryPool; }

function tenant(databaseName){
  assertSafeDatabaseName(databaseName);
  let pool = tenantPools.get(databaseName);
  if(!pool){
    pool = new Pool({ ...CONFIG, database: databaseName });
    pool.on("error", err => console.error("[db] idle client error on " + databaseName, err.message));
    tenantPools.set(databaseName, pool);
  }
  return pool;
}

/* Run several statements as one unit. Payroll writes are rarely a single
   statement — committing a run touches payslips, decisions and the run itself,
   and a half-applied commit is worse than a failed one. */
async function withTransaction(pool, fn){
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch(err){
    try { await client.query("ROLLBACK"); } catch(e){ /* connection already gone */ }
    throw err;
  } finally {
    client.release();
  }
}

async function closeAll(){
  const pools = [registryPool, ...tenantPools.values()];
  tenantPools.clear();
  await Promise.all(pools.map(p => p.end().catch(() => {})));
}

module.exports = { registry, tenant, withTransaction, closeAll, assertSafeDatabaseName, REGISTRY_DB };
