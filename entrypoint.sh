#!/bin/sh
set -e

# Load non-secret config from committed .env as defaults.
# Only sets vars that aren't already provided by Docker/Compose env_file.
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
