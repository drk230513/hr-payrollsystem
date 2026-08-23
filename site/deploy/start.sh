#!/usr/bin/env bash
# Starts the site from the GB10 and checks it actually came up.
# Safe to run repeatedly.
set -uo pipefail
cd "$(dirname "$0")"
COMPOSE="docker compose -f docker-compose.selfhost.yml"

if [ ! -f .env ]; then
  echo "No .env found."
  echo "  cp .env.selfhost.example .env"
  echo "  then paste your Cloudflare tunnel token into it"
  exit 1
fi

if ! grep -q '^CLOUDFLARE_TUNNEL_TOKEN=.\+' .env; then
  echo "CLOUDFLARE_TUNNEL_TOKEN is empty in .env."
  echo "Get it from: Cloudflare dashboard > Zero Trust > Networks > Tunnels"
  exit 1
fi

echo "Starting..."
$COMPOSE up -d || exit 1

echo -n "Waiting for the web container"
for i in $(seq 1 20); do
  if $COMPOSE exec -T web wget -qO- http://localhost:8080/healthz >/dev/null 2>&1; then
    echo " ok"; break
  fi
  echo -n "."; sleep 1
  [ "$i" -eq 20 ] && { echo " failed"; $COMPOSE logs --tail 30 web; exit 1; }
done

echo -n "Waiting for the tunnel"
for i in $(seq 1 30); do
  if $COMPOSE logs tunnel 2>&1 | grep -q "Registered tunnel connection"; then
    echo " connected"; break
  fi
  echo -n "."; sleep 2
  [ "$i" -eq 30 ] && {
    echo " not connected"
    echo "Check the token is correct and the hostname routes to http://web:8080"
    $COMPOSE logs --tail 30 tunnel; exit 1; }
done

echo
echo "Live at https://hr-payrollsystem.com"
echo "Demo at https://hr-payrollsystem.com/demo"
echo
echo "Logs:  $COMPOSE logs -f tunnel"
echo "Stop:  $COMPOSE down"
