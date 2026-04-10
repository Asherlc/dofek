#!/bin/bash
# Upgrade PostgreSQL major version for the dofek-db container.
#
# Performs a pg_dump/pg_restore migration:
#   1. Pre-flight checks (container running, disk space, current version)
#   2. Full database dump from the running PG container
#   3. Stop db + backup containers
#   4. Move old data directory aside (for rollback)
#   5. Start fresh PG18 container (compose redeploy happens externally)
#   6. Restore dump into the new PG container
#   7. Update TimescaleDB extension
#   8. Verify restore
#
# Run on the production server via SSH:
#   ssh root@<server> 'bash -s' < deploy/dokploy/upgrade-pg.sh
#
# Rollback:
#   If anything fails after step 4, restore the old data directory:
#     mv <data_dir>.pre-pg18-upgrade <data_dir>
#   Then restart the old containers.
set -euo pipefail

# --- Configuration ---
DB_CONTAINER="dofek-db"
BACKUP_CONTAINER="dofek-db-backup"
DB_USER="health"
DB_NAME="health"
DUMP_PATH="/mnt/HC_Volume_105369354/pg-upgrade-dump.custom"
MIN_DISK_MB=8000  # require at least 8 GB free on block storage

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
log "Database size: ${DB_SIZE}"

# 5. Check block storage disk space
AVAIL_MB=$(df -m /mnt/HC_Volume_105369354 | tail -1 | awk '{print $4}')
log "Available disk on block storage: ${AVAIL_MB} MB"
if [ "$AVAIL_MB" -lt "$MIN_DISK_MB" ]; then
  fail "Not enough disk space. Need at least ${MIN_DISK_MB} MB, have ${AVAIL_MB} MB."
fi

# 6. Find the data directory (host path)
DATA_DIR=$(docker exec "$DB_CONTAINER" df /var/lib/postgresql/data | tail -1 | awk '{print $NF}')
log "Data directory filesystem mount: ${DATA_DIR}"

# 7. Record baseline counts for verification
log "Recording baseline counts..."
BASELINE_TABLES=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT count(*) FROM pg_tables WHERE schemaname IN ('fitness','public','drizzle');")
BASELINE_ACTIVITIES=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT count(*) FROM fitness.activity;")
BASELINE_MIGRATIONS=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT count(*) FROM drizzle.__drizzle_migrations;")
log "  Tables: ${BASELINE_TABLES}, Activities: ${BASELINE_ACTIVITIES}, Migrations: ${BASELINE_MIGRATIONS}"

echo ""
log "Pre-flight checks passed."
echo ""
echo "This will:"
echo "  1. Dump the database to ${DUMP_PATH}"
echo "  2. Stop ${DB_CONTAINER} and ${BACKUP_CONTAINER}"
echo "  3. Move old data directory aside for rollback"
echo "  4. Wait for PG18 container to come up (redeploy externally)"
echo "  5. Restore the dump into the new container"
echo ""
if [ "${1:-}" != "--yes" ]; then
  read -rp "Continue? (y/N) " confirm
  if [[ ! "$confirm" =~ ^[Yy]$ ]]; then
    log "Aborted."
    exit 0
  fi
fi

# --- Step 1: Dump ---
echo ""
log "Step 1/7: Dumping database to block storage..."
docker exec "$DB_CONTAINER" pg_dump -U "$DB_USER" -Fc -v "$DB_NAME" > "$DUMP_PATH" 2>/dev/null
DUMP_SIZE=$(du -h "$DUMP_PATH" | cut -f1)
log "Dump complete: ${DUMP_PATH} (${DUMP_SIZE})"

# --- Step 2: Stop containers ---
echo ""
log "Step 2/7: Stopping containers..."
docker stop "$BACKUP_CONTAINER" 2>/dev/null || warn "${BACKUP_CONTAINER} was not running"
docker stop "$DB_CONTAINER"
log "Containers stopped."

# --- Step 3: Move old data directory ---
echo ""
log "Step 3/7: Moving old data directory aside..."

# The PG data is on block storage, find the actual path
# Docker volume mounts the block storage path into the container
PG_DATA_HOST=$(docker inspect "$DB_CONTAINER" --format='{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Source}}{{end}}{{end}}')

if [ -z "$PG_DATA_HOST" ]; then
  # Container is stopped, check the compose volume
  # The data is on block storage at the Docker volume's _data dir
  PG_DATA_HOST=$(docker volume inspect compose-copy-1080p-array-h8xws3_db_data --format='{{.Mountpoint}}' 2>/dev/null || true)
fi

if [ -z "$PG_DATA_HOST" ]; then
  fail "Could not determine data directory. Check docker inspect manually."
fi

BACKUP_DIR="${PG_DATA_HOST}.pre-pg18-upgrade"
if [ -d "$BACKUP_DIR" ]; then
  fail "Backup directory ${BACKUP_DIR} already exists. Previous upgrade incomplete?"
fi

log "Moving ${PG_DATA_HOST} -> ${BACKUP_DIR}"
mv "$PG_DATA_HOST" "$BACKUP_DIR"
mkdir -p "$PG_DATA_HOST"
log "Old data preserved at ${BACKUP_DIR}"

# --- Step 4: Wait for PG18 container ---
echo ""
log "Step 4/7: Waiting for PG18 container..."
echo ""
echo "  The compose stack needs to be redeployed with the PG18 image."
echo "  This can happen via:"
echo "    - CI deploying the infra compose after merge"
echo "    - Manual Dokploy API call"
echo "    - Dokploy dashboard"
echo ""
echo "  Waiting for ${DB_CONTAINER} to come up with PG18..."

WAITED=0
MAX_WAIT=600
while true; do
  if docker inspect --format='{{.State.Running}}' "$DB_CONTAINER" 2>/dev/null | grep -q true; then
    if docker exec "$DB_CONTAINER" pg_isready -U "$DB_USER" -d "$DB_NAME" &>/dev/null; then
      break
    fi
  fi
  sleep 5
  WAITED=$((WAITED + 5))
  if [ "$WAITED" -ge "$MAX_WAIT" ]; then
    fail "Timed out waiting for ${DB_CONTAINER} after ${MAX_WAIT}s."
  fi
  if [ $((WAITED % 30)) -eq 0 ]; then
    echo "  Still waiting... (${WAITED}s)"
  fi
done

NEW_PG_VERSION=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc "SHOW server_version;")
log "New container is up. PostgreSQL version: ${NEW_PG_VERSION}"

# --- Step 5: Pre-restore + Restore ---
echo ""
log "Step 5/7: Restoring database..."

# TimescaleDB extension was auto-created by initdb, run pre_restore to disable background workers
docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -c "SELECT timescaledb_pre_restore();"

# Copy dump into container and restore
docker cp "$DUMP_PATH" "${DB_CONTAINER}:/tmp/health.dump"

# Restore: --no-owner (same user), --verbose, no --clean (fresh DB)
# Some "already exists" errors for timescaledb objects are expected
docker exec "$DB_CONTAINER" pg_restore -U "$DB_USER" -d "$DB_NAME" \
  --no-owner \
  --verbose \
  /tmp/health.dump 2>&1 | tail -30 || warn "pg_restore exited non-zero (expected for TSDB objects)"

# Clean up dump inside container
docker exec "$DB_CONTAINER" rm -f /tmp/health.dump
log "Restore complete."

# --- Step 6: Post-restore ---
echo ""
log "Step 6/7: Post-restore finalization..."

# Re-enable TSDB background workers
docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -c "SELECT timescaledb_post_restore();"

# Update extension (no-op if already at same version, but safe practice)
docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -c "ALTER EXTENSION timescaledb UPDATE;"

NEW_TSDB_VERSION=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT extversion FROM pg_extension WHERE extname = 'timescaledb';")
log "TimescaleDB version: ${NEW_TSDB_VERSION}"

# Rebuild query planner statistics
log "Running ANALYZE..."
docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -c "ANALYZE;"

# --- Step 7: Verification ---
echo ""
log "Step 7/7: Verification..."

POST_TABLES=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT count(*) FROM pg_tables WHERE schemaname IN ('fitness','public','drizzle');")
POST_ACTIVITIES=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT count(*) FROM fitness.activity;")
POST_MIGRATIONS=$(docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -tAc \
  "SELECT count(*) FROM drizzle.__drizzle_migrations;")

log "  Tables:     before=${BASELINE_TABLES}  after=${POST_TABLES}"
log "  Activities:  before=${BASELINE_ACTIVITIES}  after=${POST_ACTIVITIES}"
log "  Migrations: before=${BASELINE_MIGRATIONS}  after=${POST_MIGRATIONS}"

# Verify counts match
TABLES_OK=true
if [ "$(echo "$BASELINE_TABLES" | tr -d ' ')" != "$(echo "$POST_TABLES" | tr -d ' ')" ]; then
  warn "Table count mismatch!"
  TABLES_OK=false
fi
if [ "$(echo "$BASELINE_ACTIVITIES" | tr -d ' ')" != "$(echo "$POST_ACTIVITIES" | tr -d ' ')" ]; then
  warn "Activity count mismatch!"
  TABLES_OK=false
fi
if [ "$(echo "$BASELINE_MIGRATIONS" | tr -d ' ')" != "$(echo "$POST_MIGRATIONS" | tr -d ' ')" ]; then
  warn "Migration count mismatch!"
  TABLES_OK=false
fi

if [ "$TABLES_OK" = true ]; then
  log "All counts match."
fi

# Check hypertables
docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -c \
  "SELECT hypertable_schema, hypertable_name, compression_state FROM timescaledb_information.hypertables;"

# Check continuous aggregates
docker exec "$DB_CONTAINER" psql -U "$DB_USER" -d "$DB_NAME" -c \
  "SELECT view_name, materialized_only, compression_enabled FROM timescaledb_information.continuous_aggregates;"

# Start backup container
log "Starting backup container..."
docker start "$BACKUP_CONTAINER" 2>/dev/null || warn "Could not start ${BACKUP_CONTAINER} — will start on next compose deploy"

echo ""
log "=== Upgrade Complete ==="
echo ""
echo "Summary:"
echo "  PostgreSQL: ${CURRENT_PG_VERSION} -> ${NEW_PG_VERSION}"
echo "  TimescaleDB: ${CURRENT_TSDB_VERSION} -> ${NEW_TSDB_VERSION}"
echo "  Tables: ${POST_TABLES}"
echo "  Activities: ${POST_ACTIVITIES}"
echo ""
echo "Next steps:"
echo "  1. Restart app containers (web + worker) via Dokploy"
echo "  2. Verify the web app works"
echo "  3. Clean up old data when confident:"
echo "     rm -rf ${BACKUP_DIR}"
echo "     rm ${DUMP_PATH}"
