#!/bin/bash
# Load non-secret config from .env (as defaults), apply .env.local overrides,
# then fetch secrets from Infisical and run a command.
# Usage: ./scripts/with-env.sh pnpm dev
#
# Requires: infisical CLI installed and authenticated (run `infisical login` first)
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Load .env as defaults (don't overwrite existing vars)
if [ -f "$REPO_ROOT/.env" ]; then
  while IFS='=' read -r key value; do
    case "$key" in ''|\#*) continue ;; esac
    if [ -z "${!key+x}" ]; then
      export "$key=$value"
    fi
  done < "$REPO_ROOT/.env"
fi

# Load .env.local as overrides (always overwrite)
if [ -f "$REPO_ROOT/.env.local" ]; then
  set -a
  . "$REPO_ROOT/.env.local"
  set +a
fi

exec infisical run --env=prod -- "$@"
