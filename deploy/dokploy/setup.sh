#!/bin/bash
# Set up Dokploy project, apps, compose stack, and domains via the tRPC API.
# Replaces the broken Terraform Dokploy provider.
#
# Reads all config from terraform.tfvars (gitignored) or environment variables.
# Usage: ./setup.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# --- Read config from terraform.tfvars or environment ---
get_var() {
  local key="$1"
  local tfvars_file="$SCRIPT_DIR/terraform.tfvars"
  if [ ! -f "$tfvars_file" ]; then
    echo ""
    return 0
  fi
  grep "^${key} " "$tfvars_file" | head -1 | sed 's/.*= "//;s/"$//'
}

DOKPLOY_HOST="${DOKPLOY_HOST:-$(get_var dokploy_host)}"
API_KEY="${DOKPLOY_API_KEY:-$(get_var dokploy_api_key)}"
DOMAIN="dofek.asherlc.com"
OTA_DOMAIN="ota.dofek.asherlc.com"
GHCR_IMAGE="ghcr.io/asherlc/dofek:latest"

if [ -z "${DOKPLOY_HOST}" ]; then
  echo "Error: DOKPLOY_HOST is not set. Export DOKPLOY_HOST or define dokploy_host in $SCRIPT_DIR/terraform.tfvars." >&2
  exit 1
fi

if [ -z "${API_KEY}" ]; then
  echo "Error: DOKPLOY_API_KEY is not set. Export DOKPLOY_API_KEY or define dokploy_api_key in $SCRIPT_DIR/terraform.tfvars." >&2
  exit 1
fi

POSTGRES_PASSWORD="$(get_var postgres_password)"
AXIOM_API_TOKEN="$(get_var axiom_api_token)"
SENTRY_OTLP_LOGS_ENDPOINT="$(get_var sentry_otlp_logs_endpoint)"
GHCR_TOKEN="$(get_var ghcr_token)"
R2_ENDPOINT="$(get_var r2_endpoint)"
R2_ACCESS_KEY_ID="$(get_var r2_access_key_id)"
R2_SECRET_ACCESS_KEY="$(get_var r2_secret_access_key)"
EXPO_APP_ID="$(get_var expo_app_id)"
EXPO_ACCESS_TOKEN="$(get_var expo_access_token)"
OTA_JWT_SECRET="$(get_var ota_jwt_secret)"
OTA_PUBLIC_KEY_B64="$(get_var ota_public_key_b64)"
OTA_PRIVATE_KEY_B64="$(get_var ota_private_key_b64)"

# --- Helper ---
dokploy() {
  local endpoint="$1"
  shift
  curl -fsSL "${DOKPLOY_HOST}/api/trpc/${endpoint}" \
    -H "x-api-key: ${API_KEY}" \
    -H "Content-Type: application/json" \
    "$@"
}

echo "=== Dokploy Setup ==="

# --- 1. Create project ---
echo "Creating project..."
PROJECT_RESULT=$(dokploy "project.create" -d '{"json":{"name":"dofek","description":"Health data pipeline"}}')
PROJECT_ID=$(echo "$PROJECT_RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['data']['json']['project']['projectId'])")
ENV_ID=$(echo "$PROJECT_RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['data']['json']['environment']['environmentId'])")
echo "  Project: $PROJECT_ID"
echo "  Environment: $ENV_ID"

# --- 2. Create GHCR registry ---
echo "Creating GHCR registry..."
REG_RESULT=$(dokploy "registry.create" -d "{\"json\":{\"registryName\":\"GHCR\",\"registryType\":\"cloud\",\"registryUrl\":\"ghcr.io\",\"username\":\"asherlc\",\"password\":\"${GHCR_TOKEN}\",\"imagePrefix\":\"ghcr.io/asherlc\"}}")
REG_ID=$(echo "$REG_RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['data']['json']['registryId'])")
echo "  Registry: $REG_ID"

# --- 3. Build shared env vars ---
APP_ENV_LINES=$(sed -n '/^app_env = {$/,/^}$/p' "$SCRIPT_DIR/terraform.tfvars" | grep '=' | grep -v '^app_env' | grep -v '^}' | sed 's/^  //;s/ = /=/;s/^"//;s/"$//' || true)

build_env() {
  local service_name="$1"
  local extra_env="$2"
  local env_str=""

  env_str+="DATABASE_URL=postgres://health:${POSTGRES_PASSWORD}@db:5432/health\n"
  env_str+="REDIS_URL=redis://redis:6379\n"
  env_str+="NODE_ENV=production\n"
  env_str+="PUBLIC_URL=https://${DOMAIN}\n"
  env_str+="OTEL_SERVICE_NAME=${service_name}\n"
  env_str+="OTEL_EXPORTER_OTLP_ENDPOINT=http://collector:4318\n"
  env_str+="OTEL_EXPORTER_OTLP_LOGS_ENDPOINT=http://collector:4318/v1/logs\n"

  while IFS='=' read -r key value; do
    [ -z "$key" ] && continue
    value="${value#\"}"
    value="${value%\"}"
    env_str+="${key}=${value}\n"
  done <<< "$APP_ENV_LINES"

  if [ -n "$extra_env" ]; then
    env_str+="$extra_env"
  fi

  printf '%b' "$env_str"
}

# --- 4. Create web application ---
echo "Creating web application..."
WEB_ENV=$(build_env "dofek-web" "PORT=3000\nJOB_FILES_DIR=/app/job-files\n")

WEB_RESULT=$(dokploy "application.create" -d "{\"json\":{\"name\":\"dofek-web\",\"environmentId\":\"${ENV_ID}\"}}")
WEB_ID=$(echo "$WEB_RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['data']['json']['applicationId'])")
echo "  Web app: $WEB_ID"

echo "  Configuring web app..."
dokploy "application.update" -d "{\"json\":{\"applicationId\":\"${WEB_ID}\",\"sourceType\":\"docker\",\"dockerImage\":\"${GHCR_IMAGE}\"}}" > /dev/null
dokploy "application.update" -d "{\"json\":{\"applicationId\":\"${WEB_ID}\",\"command\":\"./entrypoint.sh web\"}}" > /dev/null
dokploy "application.update" -d "{\"json\":{\"applicationId\":\"${WEB_ID}\",\"registryId\":\"${REG_ID}\"}}" > /dev/null
python3 -c "
import json, sys
env = sys.stdin.read()
payload = json.dumps({'json': {'applicationId': '${WEB_ID}', 'env': env}})
sys.stdout.write(payload)
" <<< "$WEB_ENV" | dokploy "application.update" -d @- > /dev/null

# --- 5. Create worker application ---
echo "Creating worker application..."
WORKER_ENV=$(build_env "dofek-worker" "")

WORKER_RESULT=$(dokploy "application.create" -d "{\"json\":{\"name\":\"dofek-worker\",\"environmentId\":\"${ENV_ID}\"}}")
WORKER_ID=$(echo "$WORKER_RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['data']['json']['applicationId'])")
echo "  Worker app: $WORKER_ID"

echo "  Configuring worker app..."
dokploy "application.update" -d "{\"json\":{\"applicationId\":\"${WORKER_ID}\",\"sourceType\":\"docker\",\"dockerImage\":\"${GHCR_IMAGE}\"}}" > /dev/null
dokploy "application.update" -d "{\"json\":{\"applicationId\":\"${WORKER_ID}\",\"command\":\"./entrypoint.sh worker\"}}" > /dev/null
dokploy "application.update" -d "{\"json\":{\"applicationId\":\"${WORKER_ID}\",\"registryId\":\"${REG_ID}\"}}" > /dev/null
python3 -c "
import json, sys
env = sys.stdin.read()
payload = json.dumps({'json': {'applicationId': '${WORKER_ID}', 'env': env}})
sys.stdout.write(payload)
" <<< "$WORKER_ENV" | dokploy "application.update" -d @- > /dev/null

# --- 6. Create infra compose stack ---
echo "Creating infra compose stack..."

COMPOSE_CONTENT=$(cat "$SCRIPT_DIR/infra-compose.yml" \
  | sed "s/\${postgres_password}/${POSTGRES_PASSWORD}/g" \
  | sed "s/\${axiom_api_token}/${AXIOM_API_TOKEN}/g" \
  | sed "s|\${sentry_otlp_logs_endpoint}|${SENTRY_OTLP_LOGS_ENDPOINT}|g" \
  | sed "s|\${r2_endpoint}|${R2_ENDPOINT}|g" \
  | sed "s/\${r2_access_key_id}/${R2_ACCESS_KEY_ID}/g" \
  | sed "s|\${r2_secret_access_key}|${R2_SECRET_ACCESS_KEY}|g" \
  | sed "s/\${expo_app_id}/${EXPO_APP_ID}/g" \
  | sed "s/\${expo_access_token}/${EXPO_ACCESS_TOKEN}/g" \
  | sed "s/\${ota_jwt_secret}/${OTA_JWT_SECRET}/g" \
  | sed "s|\${ota_public_key_b64}|${OTA_PUBLIC_KEY_B64}|g" \
  | sed "s|\${ota_private_key_b64}|${OTA_PRIVATE_KEY_B64}|g" \
  | sed "s/\${ota_domain}/${OTA_DOMAIN}/g" \
  | sed '/^%{/d' \
  | grep -v '^$' \
)
# Remove lines with empty volume specs (Terraform conditionals leave empty paths)
COMPOSE_CONTENT=$(echo "$COMPOSE_CONTENT" | grep -v '^\s*- :/')

COMPOSE_ESCAPED=$(echo "$COMPOSE_CONTENT" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read()))")

COMPOSE_RESULT=$(dokploy "compose.create" -d "{\"json\":{\"name\":\"dofek-infra\",\"environmentId\":\"${ENV_ID}\"}}")
COMPOSE_ID=$(echo "$COMPOSE_RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['data']['json']['composeId'])")
echo "  Compose: $COMPOSE_ID"

echo "  Setting compose file content..."
dokploy "compose.update" -d "{\"json\":{\"composeId\":\"${COMPOSE_ID}\",\"sourceType\":\"raw\",\"composeFile\":${COMPOSE_ESCAPED}}}" > /dev/null

# --- 7. Create domains ---
echo "Creating domains..."
for host in "$DOMAIN" "dofek.fit" "www.dofek.fit" "dofek.live" "www.dofek.live"; do
  echo "  Domain: $host -> web:3000"
  dokploy "domain.create" -d "{\"json\":{\"applicationId\":\"${WEB_ID}\",\"host\":\"${host}\",\"port\":3000,\"https\":true,\"certificateType\":\"letsencrypt\"}}" > /dev/null || echo "    (may already exist)"
done

echo "  Domain: $OTA_DOMAIN -> ota:3000"
dokploy "domain.create" -d "{\"json\":{\"composeId\":\"${COMPOSE_ID}\",\"host\":\"${OTA_DOMAIN}\",\"port\":3000,\"https\":true,\"certificateType\":\"letsencrypt\",\"serviceName\":\"ota\"}}" > /dev/null || echo "    (may already exist)"

# --- 8. Configure Dokploy dashboard domain ---
echo "Setting Dokploy dashboard domain..."
dokploy "settings.assignDomainServer" -d "{\"json\":{\"host\":\"dokploy.asherlc.com\",\"certificateType\":\"letsencrypt\",\"letsEncryptEmail\":\"asherlc@asherlc.com\",\"https\":true}}" > /dev/null

# --- 9. Deploy ---
echo ""
echo "Deploying infra compose stack..."
dokploy "compose.deploy" -d "{\"json\":{\"composeId\":\"${COMPOSE_ID}\"}}" > /dev/null &

echo "Deploying web application..."
dokploy "application.deploy" -d "{\"json\":{\"applicationId\":\"${WEB_ID}\"}}" > /dev/null &

echo "Deploying worker application..."
dokploy "application.deploy" -d "{\"json\":{\"applicationId\":\"${WORKER_ID}\"}}" > /dev/null &

wait
echo ""
echo "=== Setup Complete ==="
echo ""
echo "Resource IDs (save these for CI):"
echo "  PROJECT_ID=$PROJECT_ID"
echo "  WEB_APP_ID=$WEB_ID"
echo "  WORKER_APP_ID=$WORKER_ID"
echo "  COMPOSE_ID=$COMPOSE_ID"
echo "  REGISTRY_ID=$REG_ID"
echo ""
echo "Next steps:"
echo "  1. Check deployment status at ${DOKPLOY_HOST}/dashboard/projects"
echo "  2. Update DNS to point at new server IP"
echo "  3. Add DOKPLOY_HOST, DOKPLOY_API_KEY, DOKPLOY_WEB_APP_ID, DOKPLOY_WORKER_APP_ID to Infisical"
echo "  4. Migrate database from old server"
