#!/bin/sh
set -e

# Node 22+ natively handles TypeScript — transform-types also rewrites .ts imports
NODE="node --experimental-transform-types --disable-warning=ExperimentalWarning"

case "${1:-sync}" in
  web)
    exec $NODE packages/server/src/index.ts
    ;;
  sync)
    exec $NODE src/index.ts sync
    ;;
  *)
    echo "Unknown mode: $1 (expected 'web' or 'sync')" >&2
    exit 1
    ;;
esac
