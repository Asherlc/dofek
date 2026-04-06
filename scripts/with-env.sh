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

# Fetch secrets from Infisical and export them
eval "$(infisical export --env=prod --format=dotenv-export)"

# Construct OTEL auth headers from Axiom API token (config concern, not a secret)
if [ -n "$AXIOM_API_TOKEN" ]; then
  export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer $AXIOM_API_TOKEN,X-Axiom-Dataset=dofek-logs"
  export OTEL_EXPORTER_OTLP_LOGS_HEADERS="Authorization=Bearer $AXIOM_API_TOKEN,X-Axiom-Dataset=dofek-logs"
fi

exec "$@"
