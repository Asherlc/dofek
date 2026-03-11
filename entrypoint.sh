#!/bin/sh
set -e

# Node 22+ natively strips TypeScript types, needed for workspace .ts exports
NODE="node --experimental-strip-types --disable-warning=ExperimentalWarning"

case "${1:-sync}" in
  web)
    exec $NODE web/dist/server/server/index.js
    ;;
  sync)
    exec $NODE dist/index.js sync
    ;;
  *)
    echo "Unknown mode: $1 (expected 'web' or 'sync')" >&2
    exit 1
    ;;
esac
