#!/bin/sh
set -e

# Node 22+ natively handles TypeScript — transform-types also rewrites .ts imports
NODE="node --experimental-transform-types --enable-source-maps --disable-warning=ExperimentalWarning"

# If SOPS age key is available and .env exists, decrypt secrets into the environment
if { [ -n "$SOPS_AGE_KEY" ] || [ -n "$SOPS_AGE_KEY_FILE" ]; } && [ -f .env ]; then
  CMD="$NODE"
  case "${1:-sync}" in
    web)  CMD="$CMD packages/server/src/index.ts" ;;
    sync)   CMD="$CMD src/index.ts sync" ;;
    worker) CMD="$CMD src/jobs/worker.ts" ;;
    *)      echo "Unknown mode: $1 (expected 'web', 'sync', or 'worker')" >&2; exit 1 ;;
  esac
  exec sops exec-env .env "$CMD"
fi

# Fallback: run directly (env vars already set via docker env/env_file)
case "${1:-sync}" in
  web)
    exec $NODE packages/server/src/index.ts
    ;;
  sync)
    exec $NODE src/index.ts sync
    ;;
  worker)
    exec $NODE src/jobs/worker.ts
    ;;
  *)
    echo "Unknown mode: $1 (expected 'web', 'sync', or 'worker')" >&2
    exit 1
    ;;
esac
