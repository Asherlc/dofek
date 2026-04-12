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
SERVER_IP="${SERVER_IP:-159.69.3.40}"
DB_CONTAINER=$(ssh "root@$SERVER_IP" "docker ps -q -f name=dofek-db")

if [ -z "$DB_CONTAINER" ]; then
  echo "Error: could not find dofek-db container on $SERVER_IP" >&2
  exit 1
fi

RESULT=$(ssh "root@$SERVER_IP" "docker exec $DB_CONTAINER psql -U health -d health -tAc \
  \"UPDATE fitness.user_profile SET is_admin = true WHERE email = '$EMAIL' RETURNING email;\"")

if [ -z "$RESULT" ]; then
  echo "Error: no user found with email '$EMAIL'" >&2
  exit 1
fi

echo "Done: $RESULT is now an admin"
