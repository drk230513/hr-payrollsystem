#!/usr/bin/env bash
# =============================================================================
# SETUP — run this once on the GB10
# -----------------------------------------------------------------------------
#   ./setup.sh
#
# Installs Docker from Docker's own repository (Ubuntu's packaged version is
# usually too old for `docker compose`), prepares the directories, and creates
# your .env. Does not start anything — run ./start.sh after you have a
# Cloudflare tunnel token.
#
# Safe to run more than once.
# =============================================================================
set -uo pipefail
cd "$(dirname "$0")"

say()  { printf '\n\033[1m==> %s\033[0m\n' "$1"; }
ok()   { printf '    \033[32mok\033[0m   %s\n' "$1"; }
warn() { printf '    \033[33mnote\033[0m %s\n' "$1"; }
die()  { printf '    \033[31mstop\033[0m %s\n' "$1"; exit 1; }

[ "$(id -u)" -eq 0 ] && die "Do not run this with sudo. Run it as your normal user; it will ask for sudo when needed."

say "Checking the machine"
ARCH=$(dpkg --print-architecture)
printf '    architecture: %s\n' "$ARCH"
[ "$ARCH" = "arm64" ] && ok "ARM64 as expected for a GB10" \
  || warn "expected arm64, got $ARCH — the compose file pins arm64 images and will fail here"
. /etc/os-release 2>/dev/null || true
printf '    os: %s %s\n' "${NAME:-unknown}" "${VERSION_ID:-}"

say "Installing Docker"
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  ok "docker and compose v2 already installed: $(docker --version | cut -d, -f1)"
else
  sudo apt-get update -qq || die "apt update failed"
  sudo apt-get install -y -qq ca-certificates curl gnupg || die "could not install prerequisites"

  sudo install -m 0755 -d /etc/apt/keyrings
  if [ ! -f /etc/apt/keyrings/docker.asc ]; then
    sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc \
      || die "could not fetch Docker's signing key"
    sudo chmod a+r /etc/apt/keyrings/docker.asc
  fi

  echo "deb [arch=${ARCH} signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null

  sudo apt-get update -qq || die "apt update failed after adding the Docker repository"
  sudo apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin \
    || die "Docker install failed"
  ok "installed $(docker --version | cut -d, -f1)"
fi

say "Docker permissions"
if groups "$USER" | tr ' ' '\n' | grep -qx docker; then
  ok "$USER is already in the docker group"
else
  sudo usermod -aG docker "$USER"
  warn "added $USER to the docker group"
  warn "LOG OUT AND BACK IN (or run: newgrp docker) before running ./start.sh"
fi

sudo systemctl enable --now docker >/dev/null 2>&1 && ok "docker service enabled at boot"

say "Directories"
mkdir -p pgdata backups
chmod 700 pgdata backups
ok "pgdata/ and backups/ ready"

say "Configuration"
if [ -f .env ]; then
  ok ".env already exists, leaving it alone"
else
  cp .env.selfhost.example .env
  # Generate a real password rather than leaving a blank for someone to fill
  # in with something memorable.
  PW=$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 40)
  sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${PW}|" .env
  chmod 600 .env
  ok "created .env with a generated database password"
fi

say "Time synchronisation"
if timedatectl show -p NTPSynchronized --value 2>/dev/null | grep -q yes; then
  ok "clock is synchronised"
else
  sudo timedatectl set-ntp true 2>/dev/null
  warn "enabled NTP. TLS and HMRC submissions both depend on an accurate clock."
fi

say "Done"
cat <<'NEXT'
    Next, in this order:

      1. Put your Cloudflare tunnel token in .env
             nano .env
         Set CLOUDFLARE_TUNNEL_TOKEN=...

      2. Check the machine is ready
             ./preflight.sh

      3. Start it
             ./start.sh

    If you were just added to the docker group, log out and back in first.
NEXT
