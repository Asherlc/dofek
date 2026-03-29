#!/bin/sh
set -e

# Node 22+ natively handles TypeScript — transform-types also rewrites .ts imports
NODE="node --experimental-transform-types --enable-source-maps --disable-warning=ExperimentalWarning --import @opentelemetry/instrumentation/hook.mjs --import ./src/instrumentation.ts"

MIGRATE="$NODE src/db/run-migrate.ts"

# run_web_with_background_migrate: start Express immediately, run migrations in background.
# This avoids 502s during deploy — the server serves traffic while migrations run.
# If migrations fail, kill the server and exit so Docker restarts the container.
run_web_with_background_migrate() {
  SERVER_CMD="$1"

  # Start the server in the background
  $SERVER_CMD &
  SERVER_PID=$!

  # Forward signals to the server process
  trap 'kill $SERVER_PID 2>/dev/null; wait $SERVER_PID 2>/dev/null' EXIT INT TERM

  # Run migrations in the background — if they fail, kill the server
  $MIGRATE || {
    echo "[entrypoint] Migration failed, stopping server" >&2
    kill $SERVER_PID 2>/dev/null
    wait $SERVER_PID 2>/dev/null
    exit 1
  }

  # Wait for the server process (keeps the container running)
  wait $SERVER_PID
}

# If SOPS age key is available and .env exists, decrypt secrets into the environment
if { [ -n "$SOPS_AGE_KEY" ] || [ -n "$SOPS_AGE_KEY_FILE" ]; } && [ -f .env ]; then
  case "${1:-sync}" in
    web)     CMD="$(cat <<EOFCMD
$NODE packages/server/src/index.ts &
SERVER_PID=\$!
trap 'kill \$SERVER_PID 2>/dev/null; wait \$SERVER_PID 2>/dev/null' EXIT INT TERM
$MIGRATE || { echo '[entrypoint] Migration failed, stopping server' >&2; kill \$SERVER_PID 2>/dev/null; wait \$SERVER_PID 2>/dev/null; exit 1; }
wait \$SERVER_PID
EOFCMD
)" ;;
    sync)    CMD="$MIGRATE && exec $NODE src/index.ts sync" ;;
    worker)  CMD="$MIGRATE && exec $NODE src/jobs/worker.ts" ;;
    migrate) CMD="$NODE src/db/run-migrate.ts" ;;
    *)       echo "Unknown mode: $1 (expected 'web', 'sync', 'worker', or 'migrate')" >&2; exit 1 ;;
  esac
  exec sops exec-env .env "$CMD"
fi

# Fallback: run directly (env vars already set via docker env/env_file)
case "${1:-sync}" in
  web)
    run_web_with_background_migrate "$NODE packages/server/src/index.ts"
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
