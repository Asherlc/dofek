#!/bin/sh
set -e

# tsx is required because workspace package exports resolve to .ts source files
TSX="node_modules/.bin/tsx"

case "${1:-sync}" in
  web)
    exec "$TSX" web/dist/server/server/index.js
    ;;
  sync)
    exec "$TSX" dist/index.js sync
    ;;
  *)
    echo "Unknown mode: $1 (expected 'web' or 'sync')" >&2
    exit 1
    ;;
esac
