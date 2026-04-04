#!/bin/sh
set -e

# Node 22+ natively handles TypeScript — transform-types also rewrites .ts imports
NODE="node --experimental-transform-types --enable-source-maps --disable-warning=ExperimentalWarning --import @opentelemetry/instrumentation/hook.mjs --import ./src/instrumentation.ts"

MIGRATE="$NODE src/db/run-migrate.ts"

# If SOPS age key is available and .env exists, decrypt secrets into the environment
if { [ -n "$SOPS_AGE_KEY" ] || [ -n "$SOPS_AGE_KEY_FILE" ]; } && [ -f .env ]; then
  case "${1:-sync}" in
    web)     CMD="$MIGRATE && exec $NODE packages/server/src/index.ts" ;;
    sync)    CMD="$MIGRATE && exec $NODE src/index.ts sync" ;;
    worker)  CMD="$MIGRATE && exec $NODE src/jobs/worker.ts" ;;
    migrate) CMD="$NODE src/db/run-migrate.ts" ;;
    seed)    CMD="exec $NODE scripts/seed-dev-db.ts" ;;
    *)       echo "Unknown mode: $1 (expected 'web', 'sync', 'worker', 'migrate', or 'seed')" >&2; exit 1 ;;
  esac
  exec sops exec-env .env "$CMD"
fi

# Fallback: run directly (env vars already set via docker env/env_file)
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
