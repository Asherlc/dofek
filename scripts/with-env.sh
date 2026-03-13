#!/bin/bash
# Decrypt .env via SOPS and run a command with the decrypted env vars.
# Usage: ./scripts/with-env.sh tsx src/index.ts sync --full-sync
export SOPS_AGE_KEY_FILE="${SOPS_AGE_KEY_FILE:-${XDG_CONFIG_HOME:-$HOME/.config}/sops/age/keys.txt}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
exec sops exec-env "$REPO_ROOT/.env" "$*"
