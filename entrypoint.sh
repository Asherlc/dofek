#!/bin/sh
set -e

# Load non-secret config from committed .env as lowest-priority defaults.
# Only sets vars that aren't already provided by the container environment.
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
NODE="node --experimental-transform-types --enable-source-maps --disable-warning=ExperimentalWarning --import ./src/opentelemetry-hook.mjs --import ./src/instrumentation.ts"
DBT_SAFE_MODELS="sensor_scalar_sample deduped_sensor activity_source_records activity_duplicate_matches activity_duplicate_groups deduped_activities deduped_activity_members sleep_heart_rate_sample resting_heart_rate_sleep_window daily_sleep daily_recovery_inputs daily_recovery activity_sensor_sample activity_location_sample activity_sensor_summary_rows activity_location_summary_rows activity_summary_rows activity_vo2max_estimate provider_stats daily_activity_load daily_strain healthspan_activity_zone_minutes weekly_healthspan"

case "${1:-sync}" in
  web)
    exec $NODE packages/server/src/index.ts
    ;;
  sync)
    $NODE src/db/run-migrate.ts
    dbt build --project-dir analytics --profiles-dir analytics --threads 1 --select $DBT_SAFE_MODELS
    exec $NODE src/index.ts sync
    ;;
  worker)
    $NODE src/db/run-migrate.ts
    exec $NODE src/jobs/worker.ts
    ;;
  migrate)
    exec $NODE src/db/run-migrate.ts
    ;;
  analytics)
    exec dbt build --project-dir analytics --profiles-dir analytics --threads 1 --select $DBT_SAFE_MODELS
    ;;
  analytics-worker)
    interval_seconds="${ANALYTICS_BUILD_INTERVAL_SECONDS:-900}"
    retry_delay_seconds="${ANALYTICS_BUILD_RETRY_DELAY_SECONDS:-300}"
    startup_delay_seconds="${ANALYTICS_BUILD_STARTUP_DELAY_SECONDS:-120}"
    case "$startup_delay_seconds" in
      '' | *[!0-9]*)
        echo "analytics-worker: ANALYTICS_BUILD_STARTUP_DELAY_SECONDS must be a non-negative integer, got '$startup_delay_seconds'" >&2
        exit 1
        ;;
    esac
    if [ "$startup_delay_seconds" -gt 0 ]; then
      echo "analytics-worker: waiting ${startup_delay_seconds}s before first dbt build"
      sleep "$startup_delay_seconds"
    fi
    while true; do
      if dbt build --project-dir analytics --profiles-dir analytics --threads 1 --select $DBT_SAFE_MODELS; then
        sleep "$interval_seconds"
      else
        status="$?"
        echo "analytics-worker: dbt build failed with exit status $status; retrying in ${retry_delay_seconds}s" >&2
        sleep "$retry_delay_seconds"
      fi
    done
    ;;
  cdc-health)
    interval_seconds="${CDC_HEALTH_INTERVAL_SECONDS:-300}"
    case "$interval_seconds" in
      '' | 0 | *[!0-9]*)
        echo "cdc-health: CDC_HEALTH_INTERVAL_SECONDS must be a positive integer, got '$interval_seconds'" >&2
        exit 1
        ;;
    esac
    while true; do
      if $NODE scripts/check-clickhouse-cdc.ts; then
        sleep "$interval_seconds"
      else
        status="$?"
        echo "cdc-health: check failed with exit status $status; retrying in ${interval_seconds}s" >&2
        sleep "$interval_seconds"
      fi
    done
    ;;
  seed)
    exec $NODE scripts/seed-dev-db.ts
    ;;
  review-seed-clickhouse)
    exec $NODE scripts/seed-review-clickhouse.ts
    ;;
  *)
    echo "Unknown mode: $1 (expected 'web', 'sync', 'worker', 'migrate', 'analytics', 'analytics-worker', 'cdc-health', 'seed', or 'review-seed-clickhouse')" >&2
    exit 1
    ;;
esac
