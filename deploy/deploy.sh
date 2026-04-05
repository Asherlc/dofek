#!/bin/sh
# Fetch secrets from Infisical and start/update Docker Compose services.
# Called by Terraform deploy-config and cloud-init.
set -e
cd "$(dirname "$0")"

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

# Start services with both config (.env) and secrets (secrets.env)
docker compose \
  --env-file .env \
  --env-file secrets.env \
  up -d --scale web=2
