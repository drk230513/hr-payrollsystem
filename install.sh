#!/usr/bin/env bash
# =============================================================================
# HR & PAYROLL SYSTEM — INSTALLER  v0.2.0
# -----------------------------------------------------------------------------
#   ./install.sh site        just the public website (what you have today)
#   ./install.sh full        website + database + payroll API
#   ./install.sh test        run every test suite, change nothing
#   ./install.sh testdb      create the two databases the API tests need
#   ./install.sh status      what is running
#
# Safe to run more than once. Nothing is deleted; existing config is kept.
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")"
ROOT="$(pwd)"

say()  { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
ok()   { printf '    \033[32mok\033[0m   %s\n' "$1"; }
warn() { printf '    \033[33mnote\033[0m %s\n' "$1"; }
die()  { printf '    \033[31mstop\033[0m %s\n' "$1"; exit 1; }

VERSION=$(cat VERSION 2>/dev/null || echo "unknown")

# --------------------------------------------------------------- helpers ----
env_value() {
  grep -E "^$1=" "$ROOT/site/deploy/.env" 2>/dev/null | head -1 | cut -d= -f2-
}
pg_port_from_compose() {
  grep -oE '"\$\{QSFP_IP\}:[0-9]+:5432"' "$ROOT/site/deploy/docker-compose.selfhost.yml" 2>/dev/null \
    | grep -oE ':[0-9]+:' | tr -d ':' | head -1
}
compose() { docker compose -f "$ROOT/site/deploy/docker-compose.selfhost.yml" "$@"; }

# Creates the two databases the integration suites expect. Test fixtures only —
# never run this against anything holding real payroll data.
create_test_databases() {
  say "Test databases"
  local u; u=$(env_value POSTGRES_USER)
  [ -n "$u" ] || die "no POSTGRES_USER in site/deploy/.env"
  for d in hrp_acme_ltd hrp_rival_plc; do
    if compose exec -T postgres psql -U "$u" -d postgres -tAc \
         "SELECT 1 FROM pg_database WHERE datname='$d'" 2>/dev/null | grep -q 1; then
      ok "$d already exists"
    else
      compose exec -T postgres psql -U "$u" -d postgres -q -c "CREATE DATABASE $d;" >/dev/null 2>&1 \
        && ok "created $d" || { warn "could not create $d"; continue; }
    fi
    compose exec -T postgres psql -U "$u" -d "$d" -q < "$ROOT/database/02_tenant.sql" >/dev/null 2>&1 \
      && ok "$d schema applied" || warn "$d schema may already be present"
  done
  warn "these hold test data only, and the suites TRUNCATE them on each run"
}

# ---------------------------------------------------------------- checks ----
preflight() {
  say "Checking the machine"
  printf '    release: %s\n' "$VERSION"
  local arch; arch=$(uname -m)
  printf '    architecture: %s\n' "$arch"
  [ "$arch" = "aarch64" ] || [ "$arch" = "arm64" ] \
    && ok "ARM64 — container images are pinned to match" \
    || warn "not ARM64; the compose files pin arm64 images and may not start here"

  command -v docker >/dev/null 2>&1 || die "docker is not installed. Run site/deploy/setup.sh first."
  docker compose version >/dev/null 2>&1 || die "docker compose v2 is missing"
  docker info >/dev/null 2>&1 || die "cannot reach the docker daemon — are you in the docker group?"
  ok "docker $(docker --version | cut -d, -f1 | awk '{print $3}')"

  command -v node >/dev/null 2>&1 && ok "node $(node --version)" \
    || warn "node is not installed — needed only to run the test suites"
}

# ------------------------------------------------------------------ site ----
install_site() {
  say "Website"
  cd "$ROOT/site/deploy"

  [ -f .env ] || { cp .env.selfhost.example .env
    local pw; pw=$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 40)
    sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${pw}|" .env
    chmod 600 .env
    ok "created .env with a generated database password"
    warn "add your CLOUDFLARE_TUNNEL_TOKEN to site/deploy/.env before starting"; }
  [ -f .env ] && ok ".env present"

  grep -q '^COMPOSE_PROJECT_NAME=' .env || echo 'COMPOSE_PROJECT_NAME=hrpayroll' >> .env
  mkdir -p pgdata backups && chmod 700 pgdata backups

  if grep -q '^CLOUDFLARE_TUNNEL_TOKEN=.\+' .env; then
    docker compose -f docker-compose.selfhost.yml up -d web tunnel || die "could not start the website"
    sleep 4
    docker compose -f docker-compose.selfhost.yml exec -T web nginx -t >/dev/null 2>&1 \
      && ok "nginx is serving" || warn "nginx did not report healthy — check the logs"
    ok "website started"
  else
    warn "no tunnel token set, so the website was not started"
    warn "set CLOUDFLARE_TUNNEL_TOKEN in site/deploy/.env then re-run"
  fi
  cd "$ROOT"
}

# -------------------------------------------------------------- database ----
install_database() {
  say "Database"
  cd "$ROOT/site/deploy"

  # A native PostgreSQL, or another project's container, commonly already holds
  # 5432. Detect it here rather than letting docker fail with a networking
  # error that says nothing about the real cause.
  local want; want=$(grep -oE '"\$\{QSFP_IP\}:[0-9]+:5432"' docker-compose.selfhost.yml | grep -oE ':[0-9]+:' | tr -d ':')
  want=${want:-5432}
  if ss -lntH 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${want}\$"; then
    warn "port ${want} is already in use on this machine"
    local alt=$((want + 1))
    while ss -lntH 2>/dev/null | awk '{print $4}' | grep -qE "[:.]${alt}\$"; do alt=$((alt + 1)); done
    sed -i "s|\"\${QSFP_IP}:${want}:5432\"|\"\${QSFP_IP}:${alt}:5432\"|" docker-compose.selfhost.yml
    ok "moved our postgres to ${alt} so it does not fight the existing one"
    want=$alt
  fi
  export HRP_PGPORT="$want"
  docker compose -f docker-compose.selfhost.yml up -d postgres || die "could not start postgres"

  printf '    waiting for postgres'
  for i in $(seq 1 30); do
    if docker compose -f docker-compose.selfhost.yml exec -T postgres pg_isready -q 2>/dev/null; then
      printf '\n'; ok "postgres is accepting connections"; break
    fi
    printf '.'; sleep 2
    [ "$i" -eq 30 ] && { printf '\n'; die "postgres did not start — check the logs"; }
  done

  # The registry schema loads on first init. If the volume already existed it
  # will not have run, so apply it here; the file is safe to skip if present.
  local user; user=$(grep '^POSTGRES_USER=' .env | cut -d= -f2)
  if docker compose -f docker-compose.selfhost.yml exec -T postgres \
       psql -U "$user" -d hrp_registry -tAc \
       "SELECT 1 FROM information_schema.schemata WHERE schema_name='registry'" 2>/dev/null | grep -q 1; then
    ok "registry schema already present"
  else
    docker compose -f docker-compose.selfhost.yml exec -T postgres \
      psql -U "$user" -d hrp_registry -q < "$ROOT/database/01_registry.sql" >/dev/null 2>&1 \
      && ok "registry schema applied" || warn "registry schema did not apply — check database/01_registry.sql"
  fi
  cd "$ROOT"
}

# ------------------------------------------------------------------- api ----
install_api() {
  say "Payroll API"
  command -v node >/dev/null 2>&1 || { warn "node is not installed, skipping the API"; return; }
  cd "$ROOT/server"
  [ -d node_modules ] || npm install --omit=dev >/dev/null 2>&1
  [ -d node_modules ] && ok "dependencies installed" || warn "npm install failed"
  warn "the API is not started automatically — it has no web interface yet"
  warn "run it manually with:  cd server && npm start"
  cd "$ROOT"
}

# ----------------------------------------------------------------- tests ----
run_tests() {
  say "Test suites"
  command -v node >/dev/null 2>&1 || die "node is required to run tests"
  local total=0 failed=0

  for t in test atest jtest; do
    printf '    %-22s' "$t"
    if out=$(cd "$ROOT/packages" && node "$t.js" 2>&1); then
      local n; n=$(echo "$out" | grep -oE '^  [0-9]+ passed' | grep -oE '[0-9]+' | head -1)
      printf '\033[32m%s passed\033[0m\n' "${n:-?}"; total=$((total + ${n:-0}))
    else
      printf '\033[31mFAILED\033[0m\n'; failed=$((failed+1))
      echo "$out" | grep FAIL | head -5
    fi
  done

  if [ "${RUN_DB_TESTS:-0}" = "1" ]; then
    for t in stest e2e ctest ssotest otest; do
      printf '    %-22s' "$t"
      if out=$(cd "$ROOT/server" && \
          PGPORT="${HRP_PGPORT:-$(pg_port_from_compose)}" \
          PGUSER="$(env_value POSTGRES_USER)" \
          PGPASSWORD="$(env_value POSTGRES_PASSWORD)" \
          node "$t.js" 2>&1); then
        local n; n=$(echo "$out" | grep -oE '^  [0-9]+ passed' | grep -oE '[0-9]+' | head -1)
        printf '\033[32m%s passed\033[0m\n' "${n:-?}"; total=$((total + ${n:-0}))
      else
        printf '\033[31mFAILED\033[0m\n'; failed=$((failed+1))
      fi
    done
  else
    warn "database tests skipped — they need a running postgres"
    warn "run them with:  RUN_DB_TESTS=1 ./install.sh test"
  fi

  printf '\n    \033[1m%s assertions passed, %s suites failed\033[0m\n' "$total" "$failed"
  [ "${RUN_DB_TESTS:-0}" = "1" ] && [ "$failed" -gt 0 ] && {
    warn "database suites need a reachable postgres and the two test databases"
    warn "create them with:  ./install.sh testdb"; }
  [ "$failed" -gt 0 ] && return 1 || return 0
}

# ---------------------------------------------------------------- status ----
show_status() {
  say "Status"
  printf '    release: %s\n\n' "$VERSION"
  cd "$ROOT/site/deploy" 2>/dev/null && docker compose -f docker-compose.selfhost.yml ps 2>/dev/null
  printf '\n'
  if command -v curl >/dev/null 2>&1; then
    local code; code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 https://hr-payrollsystem.com 2>/dev/null)
    [ "$code" = "200" ] && ok "hr-payrollsystem.com is live" || warn "site returned ${code:-no response}"
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 8 https://hr-payrollsystem.com/demo 2>/dev/null)
    [ "$code" = "200" ] && ok "the demo is live" || warn "demo returned ${code:-no response}"
  fi
  cd "$ROOT"
}

# ------------------------------------------------------------------ main ----
case "${1:-full}" in
  site)   preflight; install_site; show_status ;;
  full)   preflight; install_site; install_database; install_api; show_status
          say "Done"
          cat <<'NEXT'
    The website and database are running. The payroll API is installed but not
    started, because it has no web interface yet — it is an API only.

    Next:
      ./install.sh test              run the calculation test suites
      cd server && npm start         start the payroll API on port 3100
      cat site/LAUNCH.md             what still has to happen before customers
NEXT
          ;;
  test)   HRP_PGPORT=$(pg_port_from_compose); run_tests ;;
  testdb) create_test_databases ;;
  status) show_status ;;
  *) echo "usage: $0 {site|full|test|testdb|status}"; exit 1 ;;
esac
