#!/bin/bash
# Decrypt .env via SOPS and run a command with the decrypted env vars.
# Usage: ./scripts/with-env.sh tsx src/index.ts sync --full-sync
export SOPS_AGE_KEY_FILE=~/.sops/key.txt
exec sops exec-env .env "$*"
