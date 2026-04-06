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

# Source .env for INFISICAL_TOKEN (and other non-secret config)
set -a
. ./.env
set +a

# Fetch secrets from Infisical into secrets.env
# This file provides both compose-level variable substitution (--env-file)
# and container-level env vars (env_file: in services).
# Strip single quotes from values — Infisical's dotenv format wraps values
# in single quotes (KEY='value') but Docker Compose treats quotes as literal.
infisical export \
  --env=prod \
  --format=dotenv \
  --projectId="54712f56-98a9-4531-9e97-0b588d2e5a88" \
  | sed "s/='\\(.*\\)'$/=\\1/" \
  > secrets.env

# Start services with config (config.env + .env) and secrets (secrets.env)
compose_args="--env-file .env --env-file secrets.env"
if [ -f config.env ]; then
  compose_args="--env-file config.env $compose_args"
fi
docker compose $compose_args up -d --scale web=2
