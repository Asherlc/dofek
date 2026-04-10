#!/bin/bash
# Upgrade PostgreSQL major version for the dofek-db container.
#
# Performs a pg_dump/pg_restore migration:
#   1. Pre-flight checks (container running, disk space, current version)
#   2. Full database dump from the running PG container
#   3. Stop db + backup containers
#   4. Move old data directory aside (for rollback)
#   5. Redeploy compose stack (Dokploy pulls new image, creates fresh data dir)
#   6. Restore dump into the new PG container
#   7. Update TimescaleDB extension
#   8. Verify restore
#
# Run on the production server via SSH:
#   ssh root@<server> 'bash -s' < deploy/dokploy/upgrade-pg.sh
#
# Requirements:
#   - Docker CLI access
#   - The infra-compose.yml must already be updated with the new PG image tag
#   - The compose stack must already be redeployed via Dokploy (or will be
#     triggered manually after this script moves the old data aside)
#
# Rollback:
#   If anything fails after step 4, restore the old data directory:
#     mv <data_dir>.pre-pg-upgrade <data_dir>
#   Then restart the old containers.
set -euo pipefail

# --- Configuration ---
DB_CONTAINER="dofek-db"
BACKUP_CONTAINER="dofek-db-backup"
DB_USER="health"
DB_NAME="health"
DUMP_PATH="/tmp/dofek-health-pg-upgrade.dump"
MIN_DISK_MB=5000  # require at least 5 GB free for the dump

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[$(date '+%H:%M:%S')]${NC} $*"; }
warn() { echo -e "${YELLOW}[$(date '+%H:%M:%S')] WARNING:${NC} $*"; }
fail() { echo -e "${RED}[$(date '+%H:%M:%S')] FATAL:${NC} $*" >&2; exit 1; }

# --- Pre-flight checks ---
log "=== PostgreSQL Major Version Upgrade ==="
echo ""

# 1. Verify container is running
log "Checking ${DB_CONTAINER} is running..."
if ! docker inspect --format='{{.State.Running}}' "$DB_CONTAINER" 2>/dev/null | grep -q true; then
  fail "${DB_CONTAINER} is not running. Cannot proceed."
fi

# 2. Get current PG version
CURRENT_PG_VERSION=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc "SHOW server_version;")
log "Current PostgreSQL version: ${CURRENT_PG_VERSION}"

# 3. Get current TimescaleDB version
CURRENT_TSDB_VERSION=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT extversion FROM pg_extension WHERE extname = 'timescaledb';" 2>/dev/null || echo "not installed")
log "Current TimescaleDB version: ${CURRENT_TSDB_VERSION}"

# 4. Check database size
DB_SIZE=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT pg_size_pretty(pg_database_size('${DB_NAME}'));")
DB_SIZE_MB=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT pg_database_size('${DB_NAME}') / 1024 / 1024;")
log "Database size: ${DB_SIZE}"

# 5. Check disk space
AVAIL_MB=$(df -m /tmp | tail -1 | awk '{print $4}')
log "Available disk space in /tmp: ${AVAIL_MB} MB"
if [ "$AVAIL_MB" -lt "$MIN_DISK_MB" ]; then
  fail "Not enough disk space. Need at least ${MIN_DISK_MB} MB, have ${AVAIL_MB} MB."
fi
if [ "$AVAIL_MB" -lt $((DB_SIZE_MB * 2)) ]; then
  warn "Disk space (${AVAIL_MB} MB) is less than 2x database size (${DB_SIZE_MB} MB). Proceeding but tight on space."
fi

# 6. Find the data directory (host path)
DATA_DIR=$(docker inspect "$DB_CONTAINER" --format='{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Source}}{{end}}{{end}}')
if [ -z "$DATA_DIR" ]; then
  fail "Could not determine data directory mount for ${DB_CONTAINER}."
fi
log "Data directory: ${DATA_DIR}"

echo ""
log "Pre-flight checks passed."
echo ""
echo "This will:"
echo "  1. Dump the database to ${DUMP_PATH}"
echo "  2. Stop ${DB_CONTAINER} and ${BACKUP_CONTAINER}"
echo "  3. Move ${DATA_DIR} to ${DATA_DIR}.pre-pg-upgrade"
echo "  4. Wait for you to redeploy the compose stack via Dokploy"
echo "  5. Restore the dump into the new container"
echo ""
read -rp "Continue? (y/N) " confirm
if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
  log "Aborted."
  exit 0
fi

# --- Step 1: Dump ---
echo ""
log "Step 1/6: Dumping database..."
docker exec "$DB_CONTAINER" pg_dump -U "$DB_USER" -Fc -v "$DB_NAME" > "$DUMP_PATH"
DUMP_SIZE=$(du -h "$DUMP_PATH" | cut -f1)
log "Dump complete: ${DUMP_PATH} (${DUMP_SIZE})"

# Verify dump is valid
log "Verifying dump file..."
if ! docker exec "$DB_CONTAINER" pg_restore -l /dev/stdin < "$DUMP_PATH" > /dev/null 2>&1; then
  # pg_restore -l from outside the container
  if ! command -v pg_restore &>/dev/null; then
    warn "Cannot verify dump (pg_restore not available on host). Checking file header instead."
    if ! file "$DUMP_PATH" | grep -qi "PostgreSQL"; then
      fail "Dump file does not look like a valid PostgreSQL dump."
    fi
  else
    pg_restore -l "$DUMP_PATH" > /dev/null 2>&1 || fail "Dump verification failed. Aborting."
  fi
fi
log "Dump verified."

# --- Step 2: Stop containers ---
echo ""
log "Step 2/6: Stopping containers..."
docker stop "$BACKUP_CONTAINER" 2>/dev/null || warn "${BACKUP_CONTAINER} was not running"
docker stop "$DB_CONTAINER"
log "Containers stopped."

# --- Step 3: Move old data directory ---
echo ""
log "Step 3/6: Moving old data directory aside..."
BACKUP_DIR="${DATA_DIR}.pre-pg-upgrade"
if [ -d "$BACKUP_DIR" ]; then
  fail "Backup directory ${BACKUP_DIR} already exists. Previous upgrade incomplete?"
fi
mv "$DATA_DIR" "$BACKUP_DIR"
mkdir -p "$DATA_DIR"
log "Old data moved to ${BACKUP_DIR}"

# --- Step 4: Redeploy ---
echo ""
log "Step 4/6: Ready for compose stack redeploy."
echo ""
echo "  Redeploy the infra compose stack now via Dokploy."
echo "  This will pull the new PG image and initialize a fresh data directory."
echo ""
echo "  Waiting for ${DB_CONTAINER} to come up..."

# Wait for the new container to be healthy (user redeploys via Dokploy in another terminal)
WAITED=0
MAX_WAIT=600  # 10 minutes
while true; do
  if docker inspect --format='{{.State.Running}}' "$DB_CONTAINER" 2>/dev/null | grep -q true; then
    # Check if PG is ready
    if docker exec "$DB_CONTAINER" pg_isready -U "$DB_USER" -d "$DB_NAME" &>/dev/null; then
      break
    fi
  fi
  sleep 5
  WAITED=$((WAITED + 5))
  if [ "$WAITED" -ge "$MAX_WAIT" ]; then
    fail "Timed out waiting for ${DB_CONTAINER} to come up after ${MAX_WAIT}s."
  fi
  if [ $((WAITED % 30)) -eq 0 ]; then
    echo "  Still waiting... (${WAITED}s)"
  fi
done

NEW_PG_VERSION=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc "SHOW server_version;")
log "New container is up. PostgreSQL version: ${NEW_PG_VERSION}"

# --- Step 5: Restore ---
echo ""
log "Step 5/6: Restoring database..."

# Create TimescaleDB extension before restore (pg_restore needs it)
docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -c "CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;"

# Restore (--no-owner since we're using the same user, --clean to drop before create)
docker cp "$DUMP_PATH" "${DB_CONTAINER}:/tmp/health.dump"
docker exec "$DB_CONTAINER" pg_restore -U "$DB_USER" -d "$DB_NAME" \
  --no-owner \
  --clean \
  --if-exists \
  --exit-on-error \
  --verbose \
  /tmp/health.dump 2>&1 | tail -20

log "Restore complete."

# Clean up dump inside container
docker exec "$DB_CONTAINER" rm -f /tmp/health.dump

# --- Step 6: Post-restore ---
echo ""
log "Step 6/6: Post-restore checks..."

# Update TimescaleDB extension
docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -c "ALTER EXTENSION timescaledb UPDATE;"
NEW_TSDB_VERSION=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT extversion FROM pg_extension WHERE extname = 'timescaledb';")
log "TimescaleDB version: ${NEW_TSDB_VERSION}"

# Verify table count
TABLE_COUNT=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'fitness';")
log "Tables in fitness schema: ${TABLE_COUNT}"

# Verify a known table has data
ACTIVITY_COUNT=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT count(*) FROM fitness.activity;" 2>/dev/null || echo "0")
log "Rows in fitness.activity: ${ACTIVITY_COUNT}"

# ANALYZE to update statistics for the query planner
log "Running ANALYZE..."
docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -c "ANALYZE;"

# Restart backup container
log "Starting backup container..."
docker start "$BACKUP_CONTAINER" 2>/dev/null || warn "Could not start ${BACKUP_CONTAINER} — will start on next compose deploy"

echo ""
log "=== Upgrade Complete ==="
echo ""
echo "Summary:"
echo "  PostgreSQL: ${CURRENT_PG_VERSION} -> ${NEW_PG_VERSION}"
echo "  TimescaleDB: ${CURRENT_TSDB_VERSION} -> ${NEW_TSDB_VERSION}"
echo "  Tables: ${TABLE_COUNT}"
echo "  Activities: ${ACTIVITY_COUNT}"
echo ""
echo "Old data directory preserved at: ${BACKUP_DIR}"
echo "Once you've verified everything works, remove it:"
echo "  rm -rf ${BACKUP_DIR}"
echo ""
echo "Host dump file preserved at: ${DUMP_PATH}"
echo "Remove when no longer needed:"
echo "  rm ${DUMP_PATH}"
