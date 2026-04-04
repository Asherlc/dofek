#!/bin/bash
# Fetch secrets from Infisical and run a command with them injected as env vars.
# Usage: ./scripts/with-env.sh tsx src/index.ts sync --full-sync
#
# Requires: infisical CLI installed and authenticated (run `infisical login` first)
exec infisical run --env=prod -- "$@"
