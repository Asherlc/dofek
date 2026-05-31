#!/usr/bin/env bash
# Resumable Postgres → ClickHouse metric_stream bulk loader.
#
# Distributes metric_stream into 5-minute checkpoint windows matching
# analytics.metric_stream_backfill_chunks (same table used by the
# ClickHouse migration code). Each window is COPY-piped via docker exec
# and checkpointed on success — safe to Ctrl+C and rerun.
#
# Usage on A1 host (save as ~/backfill.sh, chmod +x, then sudo):
#   sudo ./resume-metric-stream-backfill.sh
#
# Config via env vars:
#   BACKFILL_CHUNK_HOURS   Window size in hours  (default: 6)
#   BACKFILL_MAX_RETRIES   Retries per chunk     (default: 5)
#   BACKFILL_LOG           Log file path         (default: /tmp/backfill-*.log)
#   BACKFILL_START         Override start cursor (ISO-8601, optional)
#   BACKFILL_END           Override end bound    (ISO-8601, optional)
#   BACKFILL_DRY_RUN       Print what would load (default: 0)
#   BACKFILL_VERIFY        Verify row counts     (default: 0, off because FINAL is slow)
set -euo pipefail

CHUNK_HOURS="${BACKFILL_CHUNK_HOURS:-6}"
MAX_RETRIES="${BACKFILL_MAX_RETRIES:-5}"
START_OVERRIDE="${BACKFILL_START:-}"
END_OVERRIDE="${BACKFILL_END:-}"
DRY_RUN="${BACKFILL_DRY_RUN:-0}"
DO_VERIFY="${BACKFILL_VERIFY:-0}"
LOG_FILE="${BACKFILL_LOG:-/tmp/backfill-$(date +%Y%m%d-%H%M%S).log}"

exec > >(tee -a "$LOG_FILE") 2>&1

# ---------------------------------------------------------------------------
log()  { echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] $*"; }
error() { log "ERROR: $*"; }
warn()  { log "WARN:  $*"; }

die() { error "$*"; exit 1; }

find_container() {
  docker ps --filter "name=${1}" --format '{{.Names}}' | head -1
}

# Run a SQL query in Postgres, return results to stdout.
pg_q() {
  local pgc="$1" sql="$2"
  docker exec -i "$pgc" bash -lc "
    psql -U \"\${POSTGRES_USER}\" -d \"\${POSTGRES_DB}\" -tA 2>/dev/null
  " <<< "$sql"
}

# Run a SQL query in ClickHouse, return results to stdout.
ch_q() {
  local chc="$1" sql="$2"
  docker exec -i "$chc" clickhouse-client --format TabSeparated 2>/dev/null \
    <<< "$sql"
}

# COPY a time window from Postgres, insert into ClickHouse via temp file.
# Direct pipe from docker exec → clickhouse-client fails on ClickHouse 26.x
# (Code 48: async inserts with both inlined and external data not supported),
# so we write to a temp file first and pass it via stdin redirect.
load_window() {
  local pgc="$1" chc="$2" start="$3" end="$4"
  local tmpfile="/tmp/backfill-$$-${start}.csv"

  docker exec "$pgc" bash -lc "
    psql -U \"\${POSTGRES_USER}\" -d \"\${POSTGRES_DB}\" -c \"
      COPY (
        SELECT
          id,
          TO_CHAR(recorded_at AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS recorded_at,
          user_id,
          provider_id,
          external_id,
          device_id,
          source_type,
          channel,
          activity_id,
          scalar,
          encode(ST_AsBinary(point), 'hex') AS point
        FROM fitness.metric_stream
        WHERE recorded_at >= '${start}' AND recorded_at < '${end}'
      ) TO STDOUT WITH (FORMAT CSV, HEADER)
    \"
  " > "$tmpfile" 2>&1

  docker exec -i "$chc" clickhouse-client -q "INSERT INTO postgres_fitness.metric_stream (id, recorded_at, user_id, provider_id, external_id, device_id, source_type, channel, activity_id, scalar, point) FORMAT CSVWithNames" < "$tmpfile" 2>&1

  rm -f "$tmpfile"
}

advance_cursor() {
  # Advance an ISO-8601 timestamp by CHUNK_HOURS hours.
  local cursor="$1"
  if [[ "$(uname)" == "Darwin" ]]; then
    date -u -v "+${CHUNK_HOURS}H" -j -f "%Y-%m-%dT%H:%M:%S" "${cursor:0:19}" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null
  else
    date -u -d "$cursor + ${CHUNK_HOURS} hours" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null
  fi
}

normalize_ts() {
  if [[ "$(uname)" == "Darwin" ]]; then
    date -u -j -f "%Y-%m-%dT%H:%M:%S" "${1:0:19}" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null
  else
    date -u -d "$1" '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null
  fi
}

ts_lt() {
  [[ "$1" < "$2" ]]
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
main() {
  log "=== Metric Stream Backfill ==="
  log "Chunk: ${CHUNK_HOURS}h | Max retries: ${MAX_RETRIES}"
  log "Verify: ${DO_VERIFY} | Log: ${LOG_FILE}"

  PG_CONTAINER=$(find_container "dofek_db")
  CH_CONTAINER=$(find_container "dofek_clickhouse")

  [[ -n "$PG_CONTAINER" ]] || die "Postgres container not found"
  [[ -n "$CH_CONTAINER" ]] || die "ClickHouse container not found"
  log "Postgres: ${PG_CONTAINER}"
  log "ClickHouse: ${CH_CONTAINER}"

  # Ensure checkpoint table exists
  ch_q "$CH_CONTAINER" "
    CREATE TABLE IF NOT EXISTS analytics.metric_stream_backfill_chunks (
      lower_bound DateTime64(6, 'UTC'),
      upper_bound DateTime64(6, 'UTC'),
      completed_at DateTime DEFAULT now()
    )
    ENGINE = MergeTree
    ORDER BY (lower_bound, upper_bound)
  " > /dev/null

  # Determine time range
  if [[ -n "$START_OVERRIDE" ]]; then
    pg_min=$(normalize_ts "$START_OVERRIDE") || die "Invalid BACKFILL_START: ${START_OVERRIDE}"
    log "Override start: ${pg_min}"
  else
    pg_min=$(pg_q "$PG_CONTAINER" "
      SELECT to_char(min(recorded_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')
      FROM fitness.metric_stream
    ")
    log "Earliest row: ${pg_min}"
  fi

  if [[ -n "$END_OVERRIDE" ]]; then
    pg_max=$(normalize_ts "$END_OVERRIDE") || die "Invalid BACKFILL_END: ${END_OVERRIDE}"
    log "Override end: ${pg_max}"
  else
    pg_max=$(pg_q "$PG_CONTAINER" "
      SELECT to_char(max(recorded_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS\"Z\"')
      FROM fitness.metric_stream
    ")
    log "Latest row: ${pg_max}"
  fi

  [[ -n "$pg_min" && -n "$pg_max" ]] || die "Could not determine Postgres data range"

  # Load completed ranges into associative array for O(1) lookup.
  local -A completed=()
  local lb ub
  while IFS=$'\t' read -r lb ub; do
    completed["${lb}|${ub}"]=1
  done < <(ch_q "$CH_CONTAINER" "
    SELECT toString(lower_bound), toString(upper_bound)
    FROM analytics.metric_stream_backfill_chunks
    ORDER BY lower_bound ASC, upper_bound ASC
  ")
  log "Completed ranges cached: ${#completed[@]}"

  # Iterate through time windows
  local cursor="$pg_min"
  local loaded=0 skipped=0 errors=0 windows=0

  while ts_lt "$cursor" "$pg_max"; do
    chunk_end=$(advance_cursor "$cursor") || break
    if ts_lt "$pg_max" "$chunk_end"; then
      chunk_end="$pg_max"
    fi

    windows=$((windows + 1))

    # Skip if checkpointed
    if [[ -n "${completed["${cursor}|${chunk_end}"]:-}" ]]; then
      skipped=$((skipped + 1))
      if (( skipped % 1000 == 0 )); then
        log "Skipped ${skipped} windows; at ${cursor}"
      fi
      cursor="$chunk_end"
      continue
    fi

    log "Loading [${windows}] ${cursor} → ${chunk_end}"

    if [[ "$DRY_RUN" -eq 1 ]]; then
      cursor="$chunk_end"
      continue
    fi

    local ok=0
    for attempt in $(seq 1 "$MAX_RETRIES"); do
      if load_window "$PG_CONTAINER" "$CH_CONTAINER" "$cursor" "$chunk_end"; then
        if [[ "$DO_VERIFY" -eq 1 ]]; then
          local pg_count ch_count
          pg_count=$(pg_q "$PG_CONTAINER" "
            SELECT count(*) FROM fitness.metric_stream
            WHERE recorded_at >= '${cursor}' AND recorded_at < '${chunk_end}'
          " | tr -d '[:space:]')
          ch_count=$(ch_q "$CH_CONTAINER" "
            SELECT count()
            FROM postgres_fitness.metric_stream FINAL
            WHERE recorded_at >= toDateTime64('${cursor}', 6, 'UTC')
              AND recorded_at < toDateTime64('${chunk_end}', 6, 'UTC')
          " | tr -d '[:space:]')
          if [[ "${pg_count:-0}" -ne "${ch_count:-0}" ]]; then
            warn "Row mismatch PG=${pg_count} CH=${ch_count} (attempt ${attempt}/${MAX_RETRIES})"
            sleep "$((2 ** attempt))"
            continue
          fi
        fi
        ok=1
        break
      fi
      warn "Pipe failed (attempt ${attempt}/${MAX_RETRIES})"
      sleep "$((2 ** attempt * 2))"
    done

    if [[ "$ok" -eq 1 ]]; then
      ch_q "$CH_CONTAINER" "
        INSERT INTO analytics.metric_stream_backfill_chunks (lower_bound, upper_bound)
        VALUES (toDateTime64('${cursor%Z}', 6, 'UTC'), toDateTime64('${chunk_end%Z}', 6, 'UTC'))
      " > /dev/null
      loaded=$((loaded + 1))
      if (( loaded % 200 == 0 )); then
        log "Loaded ${loaded} windows; cursor at ${chunk_end}"
      fi
    else
      error "Failed ${cursor} → ${chunk_end} after ${MAX_RETRIES} attempts"
      errors=$((errors + 1))
    fi

    cursor="$chunk_end"
  done

  log "=== Done ==="
  log "Windows: ${windows} | Loaded: ${loaded} | Skipped: ${skipped} | Errors: ${errors}"
  [[ "$errors" -eq 0 ]] || exit 1
}

main "$@"
