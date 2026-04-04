#!/bin/bash
# Load non-secret config from .env, then fetch secrets from Infisical and run a command.
# Usage: ./scripts/with-env.sh pnpm dev
#
# Requires: infisical CLI installed and authenticated (run `infisical login` first)
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
set -a
. "$REPO_ROOT/.env"
set +a
exec infisical run --env=prod -- "$@"
