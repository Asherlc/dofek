#!/bin/sh
set -e

# Node 22+ natively handles TypeScript — transform-types also rewrites .ts imports
NODE="node --experimental-transform-types --enable-source-maps --disable-warning=ExperimentalWarning --import @opentelemetry/instrumentation/hook.mjs --import ./src/instrumentation.ts"

MIGRATE="$NODE src/db/run-migrate.ts"

# If Infisical credentials are available, fetch secrets from Infisical and inject into env
if [ -n "$INFISICAL_TOKEN" ] || { [ -n "$INFISICAL_UNIVERSAL_AUTH_CLIENT_ID" ] && [ -n "$INFISICAL_UNIVERSAL_AUTH_CLIENT_SECRET" ]; }; then
  case "${1:-sync}" in
    web)     CMD="$MIGRATE && exec $NODE packages/server/src/index.ts" ;;
    sync)    CMD="$MIGRATE && exec $NODE src/index.ts sync" ;;
    worker)  CMD="$MIGRATE && exec $NODE src/jobs/worker.ts" ;;
    migrate) CMD="$NODE src/db/run-migrate.ts" ;;
    *)       echo "Unknown mode: $1 (expected 'web', 'sync', 'worker', or 'migrate')" >&2; exit 1 ;;
  esac
  exec infisical run --env=prod --projectId=54712f56-98a9-4531-9e97-0b588d2e5a88 -- sh -c "$CMD"
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
  *)
    echo "Unknown mode: $1 (expected 'web', 'sync', 'worker', or 'migrate')" >&2
    exit 1
    ;;
esac
