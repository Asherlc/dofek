#!/bin/sh
set -e

# ── Fetch secrets from Infisical (if configured) ──────────────────────
# Secrets from Infisical override baked-in .env defaults but NOT
# Docker/Compose environment vars (which are already in the process env).
# Uses JSON format to handle multi-line values (e.g. SSH keys, PEM certs).
if [ -n "${INFISICAL_TOKEN:-}" ] && command -v infisical >/dev/null 2>&1; then
  if INFISICAL_JSON=$(infisical export \
    --env="${INFISICAL_ENV:-prod}" \
    --format=json \
    --projectId="${INFISICAL_PROJECT_ID:-54712f56-98a9-4531-9e97-0b588d2e5a88}" \
    2>&1); then
    echo "[entrypoint] Loaded secrets from Infisical" >&2
    # Parse JSON array and export each key=value, skipping keys already set.
    # Node.js is available in the image — no extra dependencies needed.
    eval "$(echo "$INFISICAL_JSON" | node -e "
      const secrets = JSON.parse(require('fs').readFileSync(0, 'utf8'));
      for (const { key, value } of secrets) {
        if (!process.env[key]) {
          // Shell-escape the value: wrap in single quotes, escape embedded single quotes
          const escaped = value.replace(/'/g, \"'\\\\''\" );
          console.log('export ' + key + \"='\" + escaped + \"'\");
        }
      }
    ")"
  else
    echo "[entrypoint] WARNING: Failed to fetch secrets from Infisical, continuing with existing env" >&2
    echo "[entrypoint] Infisical output: $INFISICAL_JSON" >&2
  fi
fi

# Load non-secret config from committed .env as lowest-priority defaults.
# Only sets vars that aren't already provided by Docker/Compose or Infisical.
if [ -f .env ]; then
  while IFS='=' read -r key value; do
    case "$key" in ''|\#*) continue ;; esac
    # Skip lines without valid variable names (continuation lines, etc.)
    case "$key" in [!A-Za-z_]*|*[!A-Za-z0-9_]*) continue ;; esac
    # Strip surrounding single quotes
    case "$value" in \'*\') value="${value#\'}"; value="${value%\'}" ;; esac
    if ! printenv "$key" >/dev/null 2>&1; then
      export "$key=$value"
    fi
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
