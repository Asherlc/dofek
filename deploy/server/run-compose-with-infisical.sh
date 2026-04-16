#!/usr/bin/env bash
set -euo pipefail

INFISICAL_VERSION="${INFISICAL_VERSION:-0.159.13}"
INFISICAL_ENVIRONMENT="${INFISICAL_ENVIRONMENT:-prod}"

if [ "$#" -lt 2 ]; then
  echo "Usage: $0 <compose|rollout> <args...>" >&2
  exit 1
fi

if [ -z "${INFISICAL_TOKEN:-}" ]; then
  echo "ERROR: INFISICAL_TOKEN is required" >&2
  exit 1
fi

install_infisical_cli_if_missing() {
  if command -v infisical >/dev/null 2>&1; then
    return
  fi

  curl -1sLf "https://dl.cloudsmith.io/public/infisical/infisical-cli/setup.deb.sh" | bash
  apt-get update
  apt-get install -y "infisical=${INFISICAL_VERSION}"
}

validate_required_vars() {
  if [ -z "${REQUIRED_INFISICAL_VARS:-}" ]; then
    return
  fi

  local missing_vars=()
  local required_var
  for required_var in ${REQUIRED_INFISICAL_VARS}; do
    if ! grep -Eq "^${required_var}=.+" "${SECRET_ENV_FILE}"; then
      missing_vars+=("${required_var}")
    fi
  done

  if [ "${#missing_vars[@]}" -gt 0 ]; then
    echo "ERROR: missing required vars in Infisical ${INFISICAL_ENVIRONMENT}: ${missing_vars[*]}" >&2
    echo "Set them with: infisical secrets set --env=${INFISICAL_ENVIRONMENT} KEY=value" >&2
    exit 1
  fi
}

install_infisical_cli_if_missing

cd /opt/dofek
test -f .env.deploy || printf "IMAGE_TAG=latest\n" > .env.deploy

SECRET_ENV_FILE="$(mktemp /tmp/dofek-infisical.XXXXXX)"
cleanup() {
  rm -f "${SECRET_ENV_FILE}"
}
trap cleanup EXIT

INFISICAL_TOKEN="${INFISICAL_TOKEN}" infisical export --env="${INFISICAL_ENVIRONMENT}" --format=dotenv > "${SECRET_ENV_FILE}"
chmod 600 "${SECRET_ENV_FILE}"
validate_required_vars

MODE="$1"
shift

case "${MODE}" in
  compose)
    INFISICAL_ENV_FILE="${SECRET_ENV_FILE}" docker compose \
      --env-file "${SECRET_ENV_FILE}" \
      --env-file .env.deploy \
      -f docker-compose.deploy.yml \
      "$@"
    ;;
  rollout)
    INFISICAL_ENV_FILE="${SECRET_ENV_FILE}" docker rollout \
      --env-file "${SECRET_ENV_FILE}" \
      --env-file .env.deploy \
      -f docker-compose.deploy.yml \
      "$@"
    ;;
  *)
    echo "ERROR: unknown mode '${MODE}'. Use 'compose' or 'rollout'." >&2
    exit 1
    ;;
esac
