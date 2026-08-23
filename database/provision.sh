#!/usr/bin/env bash
# =============================================================================
# TENANT PROVISIONING WORKER
# -----------------------------------------------------------------------------
# Picks up queued jobs from the registry and creates or migrates tenant
# databases. Safe to run repeatedly: every step is idempotent, and a tenant that
# fails half way is left in 'failed' with the error recorded rather than in a
# half-built state that the next run silently skips.
#
#   ./provision.sh create      create databases for every queued organisation
#   ./provision.sh migrate     bring every ready tenant up to the latest version
#   ./provision.sh status      show where every tenant is
# =============================================================================
set -uo pipefail

PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"
PGUSER_ADMIN="${PGUSER_ADMIN:-postgres}"
REGISTRY_DB="${REGISTRY_DB:-hrp_registry}"
SCHEMA_DIR="${SCHEMA_DIR:-$(cd "$(dirname "$0")" && pwd)}"
TARGET_VERSION="${TARGET_VERSION:-1}"

psql_admin() { "$PGBIN/psql" -U "$PGUSER_ADMIN" -v ON_ERROR_STOP=1 -qtAX "$@"; }
reg()        { psql_admin -d "$REGISTRY_DB" "$@"; }

log() { printf '[%s] %s\n' "$(date +%H:%M:%S)" "$*"; }

fail_job() {
    local org="$1" msg="$2"
    reg -c "UPDATE provisioning_jobs SET state='failed', last_error=\$\$${msg}\$\$, finished_at=now()
            WHERE organisation_id='${org}' AND state='running';" >/dev/null
    reg -c "UPDATE tenant_databases SET status='failed' WHERE organisation_id='${org}';" >/dev/null
    log "FAILED ${org}: ${msg}"
}

# ---------------------------------------------------------------- create ----
cmd_create() {
    local rows
    rows=$(reg -c "SELECT o.id, o.slug, t.database_name
                   FROM organisations o
                   JOIN tenant_databases t ON t.organisation_id = o.id
                   JOIN provisioning_jobs j ON j.organisation_id = o.id
                   WHERE j.kind='create_database' AND j.state='queued' AND t.status='queued';")
    [ -z "$rows" ] && { log "nothing queued"; return 0; }

    while IFS='|' read -r org slug db; do
        [ -z "$org" ] && continue
        log "provisioning ${slug} -> ${db}"
        reg -c "UPDATE provisioning_jobs SET state='running', started_at=now(), attempts=attempts+1
                WHERE organisation_id='${org}' AND kind='create_database' AND state='queued';" >/dev/null
        reg -c "UPDATE tenant_databases SET status='provisioning' WHERE organisation_id='${org}';" >/dev/null

        # An existing database from a half-finished run is reused rather than
        # dropped, because dropping one that already holds payroll data would be
        # unrecoverable.
        if ! psql_admin -d postgres -c "SELECT 1 FROM pg_database WHERE datname='${db}';" | grep -q 1; then
            if ! psql_admin -d postgres -c "CREATE DATABASE \"${db}\";" >/dev/null 2>&1; then
                fail_job "$org" "could not create database ${db}"; continue
            fi
        fi

        # The initial schema is applied ONCE. It is not re-runnable — CREATE TYPE
        # and CREATE TRIGGER have no IF NOT EXISTS — and re-running it over a live
        # tenant throws dozens of errors while silently leaving the database in an
        # unknown state. Anything after v1 goes through migrations instead.
        already=$(psql_admin -d "$db" -c "SELECT coalesce(max(version),0) FROM payroll.schema_migrations;" 2>/dev/null || echo 0)
        if [ "${already:-0}" -ge 1 ]; then
            log "  schema already at v${already}, skipping initial load"
        elif ! psql_admin -d "$db" -f "${SCHEMA_DIR}/02_tenant.sql" >/tmp/prov_${db}.log 2>&1; then
            fail_job "$org" "schema load failed, see /tmp/prov_${db}.log"; continue
        fi

        reg -c "UPDATE tenant_databases SET status='ready', provisioned_at=now(), schema_version=${TARGET_VERSION}
                WHERE organisation_id='${org}';" >/dev/null
        reg -c "UPDATE provisioning_jobs SET state='succeeded', finished_at=now()
                WHERE organisation_id='${org}' AND kind='create_database' AND state='running';" >/dev/null
        reg -c "UPDATE organisations SET status='active', activated_at=now() WHERE id='${org}';" >/dev/null
        reg -c "INSERT INTO audit_events(organisation_id, action, detail)
                VALUES ('${org}','tenant.provisioned', jsonb_build_object('database','${db}'));" >/dev/null
        log "ready: ${db}"
    done <<< "$rows"
}

# --------------------------------------------------------------- migrate ----
# Runs every migration file numbered above the tenant's current version.
# Each tenant records its own version, so a partial rollout is resumable rather
# than leaving you guessing which databases got the change.
cmd_migrate() {
    local rows
    rows=$(reg -c "SELECT organisation_id, database_name, schema_version
                   FROM tenant_databases WHERE status='ready' AND schema_version < ${TARGET_VERSION};")
    [ -z "$rows" ] && { log "all tenants at version ${TARGET_VERSION}"; return 0; }

    while IFS='|' read -r org db ver; do
        [ -z "$org" ] && continue
        log "migrating ${db} from v${ver} to v${TARGET_VERSION}"
        reg -c "UPDATE tenant_databases SET status='migrating' WHERE organisation_id='${org}';" >/dev/null
        local failed=0
        for v in $(seq $((ver + 1)) "$TARGET_VERSION"); do
            local f="${SCHEMA_DIR}/migrations/${v}_*.sql"
            # shellcheck disable=SC2086
            f=$(ls $f 2>/dev/null | head -1)
            [ -z "$f" ] && { log "  no file for v${v}, stopping"; failed=1; break; }
            if psql_admin -d "$db" -f "$f" >>/tmp/migrate_${db}.log 2>&1; then
                psql_admin -d "$db" -c "INSERT INTO payroll.schema_migrations(version, description)
                    VALUES (${v}, '$(basename "$f")') ON CONFLICT DO NOTHING;" >/dev/null
                reg -c "UPDATE tenant_databases SET schema_version=${v} WHERE organisation_id='${org}';" >/dev/null
                log "  v${v} applied"
            else
                fail_job "$org" "migration v${v} failed"; failed=1; break
            fi
        done
        [ "$failed" -eq 0 ] && reg -c "UPDATE tenant_databases SET status='ready' WHERE organisation_id='${org}';" >/dev/null
    done <<< "$rows"
}

# ---------------------------------------------------------------- status ----
cmd_status() {
    "$PGBIN/psql" -U "$PGUSER_ADMIN" -d "$REGISTRY_DB" -c "
        SELECT o.slug, o.status AS org, t.database_name, t.status AS db,
               t.schema_version AS ver, t.region,
               coalesce(j.state::text,'-') AS last_job
        FROM organisations o
        LEFT JOIN tenant_databases t ON t.organisation_id = o.id
        LEFT JOIN LATERAL (SELECT state FROM provisioning_jobs
                           WHERE organisation_id = o.id ORDER BY queued_at DESC LIMIT 1) j ON true
        ORDER BY o.slug;"
}

case "${1:-status}" in
    create)  cmd_create ;;
    migrate) cmd_migrate ;;
    status)  cmd_status ;;
    *) echo "usage: $0 {create|migrate|status}"; exit 1 ;;
esac
