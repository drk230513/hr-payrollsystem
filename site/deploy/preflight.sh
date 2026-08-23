#!/usr/bin/env bash
# =============================================================================
# PREFLIGHT — run this on the GB10 before deploying anything
# -----------------------------------------------------------------------------
#   ./preflight.sh
#
# Checks the things that actually bite when self-hosting on ARM64 hardware
# behind a consumer or business broadband line. Read the FAIL and WARN lines;
# the PASS lines are just there so you know the check ran.
# =============================================================================
set -uo pipefail

PASS=0; WARN=0; FAIL=0
ok()   { printf '  \033[32mPASS\033[0m  %s\n' "$1"; PASS=$((PASS+1)); }
warn() { printf '  \033[33mWARN\033[0m  %s\n' "$1"; WARN=$((WARN+1)); }
bad()  { printf '  \033[31mFAIL\033[0m  %s\n' "$1"; FAIL=$((FAIL+1)); }
head() { printf '\n\033[1m%s\033[0m\n' "$1"; }

DOMAIN="${DOMAIN:-hr-payrollsystem.com}"
EXPECT_IP="${EXPECT_IP:-81.108.239.141}"

head "Hardware and OS"
ARCH=$(uname -m)
case "$ARCH" in
  aarch64|arm64) ok "architecture is $ARCH — remember every container image must be arm64" ;;
  x86_64)        warn "architecture is $ARCH, not the ARM64 you get on a GB10. Are you on the right box?" ;;
  *)             warn "unrecognised architecture: $ARCH" ;;
esac
printf '  ....  %s\n' "$(uname -sr)"
MEM_GB=$(( $(grep MemTotal /proc/meminfo | awk '{print $2}') / 1024 / 1024 ))
[ "$MEM_GB" -ge 64 ] && ok "${MEM_GB}GB memory — far more than payroll needs, ideal for local inference" \
                     || warn "${MEM_GB}GB memory"
DISK_FREE=$(df -BG --output=avail / 2>/dev/null | tail -1 | tr -dc '0-9')
[ "${DISK_FREE:-0}" -ge 100 ] && ok "${DISK_FREE}GB free on /" || warn "only ${DISK_FREE}GB free on /"

head "Container runtime"
if command -v docker >/dev/null 2>&1; then
  ok "docker present: $(docker --version | cut -d, -f1)"
  docker compose version >/dev/null 2>&1 && ok "docker compose v2 present" \
    || bad "docker compose v2 missing — install the compose plugin"
  docker info >/dev/null 2>&1 && ok "docker daemon reachable" \
    || bad "cannot reach the docker daemon (permissions? add yourself to the docker group)"
else
  bad "docker not installed"
fi

head "ARM64 image availability"
# pgbouncer is the one that commonly has no arm64 build. Check before you
# discover it at deploy time.
for img in postgres:16-alpine nginx:1.27-alpine cloudflare/cloudflared:latest certbot/certbot:latest edoburu/pgbouncer:latest; do
  if command -v docker >/dev/null 2>&1 && docker manifest inspect "$img" >/tmp/mf.json 2>/dev/null; then
    if grep -q '"architecture": *"arm64"' /tmp/mf.json; then ok "$img has an arm64 build"
    else bad "$img has NO arm64 build — find an alternative or build it yourself"; fi
  else
    warn "could not inspect $img (no network or not logged in) — verify manually"
  fi
done

head "Networking"
LOCAL_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
printf '  ....  local address: %s\n' "${LOCAL_IP:-unknown}"
PUBLIC_IP=$(curl -s --max-time 8 https://api.ipify.org 2>/dev/null || echo "")
# Only trust it if it actually looks like an address; a proxy error page is not one.
echo "$PUBLIC_IP" | grep -qE '^[0-9]{1,3}(\.[0-9]{1,3}){3}$' || PUBLIC_IP=""
if [ -n "$PUBLIC_IP" ]; then
  printf '  ....  public address: %s\n' "$PUBLIC_IP"
  [ "$PUBLIC_IP" = "$EXPECT_IP" ] && ok "public IP matches the expected $EXPECT_IP" \
    || warn "public IP is $PUBLIC_IP but you expected $EXPECT_IP — dynamic address?"
else
  warn "could not determine the public IP"
fi

# A changing public IP is fatal for a service people depend on. Check whether
# the ISP has actually given you a static one.
head "Is the address static?"
warn "This script cannot tell. Confirm with your ISP in writing that 81.108.239.141"
warn "is static, and that their terms permit running a commercial service."
warn "Consumer broadband contracts usually prohibit it, and a dynamic address"
warn "means your customers' payslips vanish the day the lease renews."

head "DNS"
for d in "$DOMAIN" "www.$DOMAIN" vinmur.uk opensource-ai-cloud.uk; do
  R=$(dig +short "$d" A 2>/dev/null | tail -1)
  if [ -z "$R" ]; then warn "$d does not resolve yet"
  elif [ "$R" = "$EXPECT_IP" ]; then ok "$d -> $R"
  else printf '  ....  %s -> %s\n' "$d" "$R"; fi
done

head "Ports"
for p in 80 443; do
  if ss -lntH 2>/dev/null | awk '{print $4}' | grep -qE "[:.]$p\$"; then
    warn "port $p is already in use locally — nginx will fail to bind"
  else
    ok "port $p free locally"
  fi
done
warn "Inbound 80/443 must also be forwarded on the router AND not blocked by the ISP."
warn "Many UK consumer lines block inbound 80. Cloudflare Tunnel avoids this entirely."

head "Time"
if timedatectl show -p NTPSynchronized --value 2>/dev/null | grep -q yes; then
  ok "clock is NTP-synchronised — required for TLS and for RTI timestamps"
else
  bad "clock is NOT NTP-synchronised. Fix before anything else; TLS and HMRC submissions depend on it."
fi

head "Power and continuity"
if command -v upsc >/dev/null 2>&1 && upsc -l 2>/dev/null | grep -q .; then
  ok "a UPS is configured via NUT"
else
  warn "no UPS detected. A payroll run interrupted mid-commit on an unprotected"
  warn "box is exactly the failure the commit gate exists to prevent."
fi

head "Second node"
PEER="${PEER_IP:-}"
if [ -n "$PEER" ]; then
  if ping -c1 -W2 "$PEER" >/dev/null 2>&1; then ok "peer $PEER reachable"
  else bad "peer $PEER unreachable"; fi
else
  warn "set PEER_IP to the second GB10's address over the QSFP link to test it"
fi

printf '\n\033[1mSummary\033[0m  %d passed, %d warnings, %d failures\n\n' "$PASS" "$WARN" "$FAIL"
[ "$FAIL" -gt 0 ] && exit 1 || exit 0
