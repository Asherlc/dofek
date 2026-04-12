#!/bin/bash
# Make a user an admin by email.
# Usage: ./scripts/make-admin.sh user@example.com
#
# Requires: SSH access to the production server (key must be in ssh-agent)
# Set SERVER_IP env var to override the default.
set -euo pipefail

if [ $# -ne 1 ]; then
  echo "Usage: $0 <email>" >&2
  exit 1
fi

EMAIL="$1"
SERVER_IP="${SERVER_IP:-$(infisical secrets get SERVER_HOST --env=prod --plain 2>/dev/null)}"

if [ -z "$SERVER_IP" ]; then
  echo "Error: could not resolve SERVER_IP (set it or log in to Infisical)" >&2
  exit 1
fi
DB_CONTAINERS=$(ssh "root@$SERVER_IP" "docker ps -q -f 'name=^/dofek-db\$'")

if [ -z "$DB_CONTAINERS" ]; then
  echo "Error: could not find dofek-db container on $SERVER_IP" >&2
  exit 1
fi

DB_CONTAINER_COUNT=$(printf '%s\n' "$DB_CONTAINERS" | wc -l | tr -d ' ')
if [ "$DB_CONTAINER_COUNT" -ne 1 ]; then
  echo "Error: expected exactly one dofek-db container on $SERVER_IP, found $DB_CONTAINER_COUNT" >&2
  exit 1
fi

DB_CONTAINER="$DB_CONTAINERS"

RESULT=$(ssh "root@$SERVER_IP" 'sh -s' -- "$DB_CONTAINER" "$EMAIL" <<'QUERY'
docker exec -i "$1" psql -U health -d health -v "email=$2" -tA <<'SQL'
UPDATE fitness.user_profile SET is_admin = true, updated_at = NOW() WHERE email = :'email' RETURNING email;
SQL
QUERY
)

if [ -z "$RESULT" ]; then
  echo "Error: no user found with email '$EMAIL'" >&2
  exit 1
fi

echo "Done: $RESULT is now an admin"
