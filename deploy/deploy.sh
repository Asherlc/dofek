#!/bin/sh
# Fetch secrets from Infisical and start/update Docker Compose services.
# Called by Terraform deploy-config and cloud-init.
set -e

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

  curl -fsSL "https://github.com/Infisical/cli/releases/download/v${INFISICAL_CLI_VERSION}/cli_${INFISICAL_CLI_VERSION}_linux_${INF_ARCH}.tar.gz" \
    | tar xz -C /usr/local/bin infisical
  chmod +x /usr/local/bin/infisical
}

cd "$(dirname "$0")"
install_infisical

# Source .env for INFISICAL_TOKEN (and other non-secret config)
set -a
. ./.env
set +a

# Fetch secrets from Infisical into secrets.env
# This file provides both compose-level variable substitution (--env-file)
# and container-level env vars (env_file: in services).
infisical export \
  --env=prod \
  --format=dotenv \
  --projectId="54712f56-98a9-4531-9e97-0b588d2e5a88" \
  > secrets.env

# Start services with config (config.env + .env) and secrets (secrets.env)
docker compose \
  --env-file config.env \
  --env-file .env \
  --env-file secrets.env \
  up -d --scale web=2
