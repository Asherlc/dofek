#!/bin/sh
set -e

# ── Fetch secrets from Infisical (if configured) ──────────────────────
# Secrets from Infisical override baked-in .env defaults but NOT
# Docker/Compose environment vars (which are already in the process env).
if [ -n "${INFISICAL_TOKEN:-}" ] && command -v infisical >/dev/null 2>&1; then
  INFISICAL_SECRETS=$(infisical export \
    --env=prod \
    --format=dotenv \
    --projectId="54712f56-98a9-4531-9e97-0b588d2e5a88" \
    2>/dev/null) && {
    echo "[entrypoint] Loaded secrets from Infisical" >&2
    while IFS='=' read -r key value; do
      case "$key" in ''|\#*) continue ;; esac
      eval "if [ -z \"\${$key+x}\" ]; then export $key=\"$value\"; fi"
    done <<EOF
$INFISICAL_SECRETS
EOF
  } || {
    echo "[entrypoint] WARNING: Failed to fetch secrets from Infisical, continuing with existing env" >&2
  }
fi

# Load non-secret config from committed .env as lowest-priority defaults.
# Only sets vars that aren't already provided by Docker/Compose or Infisical.
if [ -f .env ]; then
  while IFS='=' read -r key value; do
    case "$key" in ''|\#*) continue ;; esac
    eval "if [ -z \"\${$key+x}\" ]; then export $key=\"$value\"; fi"
  done < .env
fi

# Node 22+ natively handles TypeScript — transform-types also rewrites .ts imports
NODE="node --experimental-transform-types --enable-source-maps --disable-warning=ExperimentalWarning --import @opentelemetry/instrumentation/hook.mjs --import ./src/instrumentation.ts"

case "${1:-sync}" in
  web)
    $NODE src/db/run-migrate.ts
    exec $NODE packages/server/src/index.ts
    ;;
  sync)
    $NODE src/db/run-migrate.ts
    exec $NODE src/index.ts sync
    ;;
  worker)
    $NODE src/db/run-migrate.ts
    exec $NODE src/jobs/worker.ts
    ;;
  migrate)
    exec $NODE src/db/run-migrate.ts
    ;;
  seed)
    exec $NODE scripts/seed-dev-db.ts
    ;;
  *)
    echo "Unknown mode: $1 (expected 'web', 'sync', 'worker', 'migrate', or 'seed')" >&2
    exit 1
    ;;
esac
