#!/bin/sh
# Fetch secrets from Infisical and start/update Docker Compose services.
# Called by Terraform deploy-config and cloud-init.
set -e

# Keep in sync with INFISICAL_CLI_VERSION ARG in Dockerfile
INFISICAL_CLI_VERSION=0.43.69

install_infisical() {
  if command -v infisical >/dev/null 2>&1; then
    return
  fi

  ARCH=$(uname -m)
  case "$ARCH" in
    x86_64) INF_ARCH=amd64 ;;
    aarch64) INF_ARCH=arm64 ;;
    *) INF_ARCH=$ARCH ;;
  esac

  INF_TAR="cli_${INFISICAL_CLI_VERSION}_linux_${INF_ARCH}.tar.gz"
  curl -fsSL "https://github.com/Infisical/cli/releases/download/v${INFISICAL_CLI_VERSION}/${INF_TAR}" -o "/tmp/${INF_TAR}"
  curl -fsSL "https://github.com/Infisical/cli/releases/download/v${INFISICAL_CLI_VERSION}/checksums.txt" -o /tmp/checksums.txt
  (cd /tmp && grep -F "${INF_TAR}" checksums.txt | sha256sum -c)
  tar xzf "/tmp/${INF_TAR}" -C /usr/local/bin infisical
  rm -f "/tmp/${INF_TAR}" /tmp/checksums.txt
  chmod +x /usr/local/bin/infisical
}

cd "$(dirname "$0")"
install_infisical

# Load INFISICAL_TOKEN from .env
if [ ! -f .env ]; then
  echo "Error: .env not found; cannot load INFISICAL_TOKEN." >&2
  exit 1
fi
INFISICAL_TOKEN=$(grep '^INFISICAL_TOKEN=' .env | head -n 1 | cut -d= -f2-)
if [ -z "$INFISICAL_TOKEN" ]; then
  echo "Error: INFISICAL_TOKEN is missing or empty in .env." >&2
  exit 1
fi

# Generate secrets.env for compose-level variable substitution
# (needed by non-dofek services: postgres, ota, collector, watchtower).
# Dofek containers fetch their own secrets via entrypoint.sh.
# Strip single quotes — Infisical dotenv format uses KEY='value'.
# Write to temp file first so a failed export doesn't leave a partial secrets.env.
INFISICAL_TOKEN="$INFISICAL_TOKEN" infisical export \
  --env=prod \
  --format=dotenv \
  --projectId="54712f56-98a9-4531-9e97-0b588d2e5a88" \
  > secrets.env.tmp
sed "s/='\(.*\)'$/=\1/" secrets.env.tmp > secrets.env
rm -f secrets.env.tmp

# Start services. config.env has non-secret config (client IDs),
# secrets.env has secrets from Infisical.
docker compose --env-file config.env --env-file secrets.env up -d --scale web=2
