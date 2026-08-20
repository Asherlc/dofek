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

# Node 22+ supports TypeScript with --experimental-strip-types
NODE="node --experimental-strip-types --enable-source-maps --disable-warning=ExperimentalWarning --import ./src/opentelemetry-hook.mjs --import ./src/instrumentation.ts"
DBT_ACTIVITY_MODELS="sensor_scalar_sample deduped_sensor activity_source_records activity_duplicate_matches activity_duplicate_groups deduped_activities deduped_activity_members activity_sensor_sample activity_location_sample activity_sensor_summary_rows activity_location_summary_rows activity_stream_points activity_heart_rate_zones activity_summary_rows hiking_activity body_measurement activity_vo2max_estimate activity_aerobic_efficiency activity_polarization_zones activity_power_curve cycling_activity daily_cycling provider_metric_stream_daily provider_change_watermark provider_stats"
DBT_SLEEP_DASHBOARD_MODELS="sleep_heart_rate_window sleep_heart_rate_sample resting_heart_rate_sleep_window daily_sleep daily_recovery_inputs daily_recovery daily_endurance_load weekly_endurance_ramp_rate weekly_training_monotony daily_activity_load daily_strain daily_body_measurement healthspan_activity_zone_minutes weekly_healthspan"
DBT_E2E_MICROBATCH_VARS='{"sensor_scalar_sample_begin":"2026-01-01","deduped_sensor_begin":"2026-01-01","activity_sensor_sample_begin":"2026-01-01","activity_location_sample_begin":"2026-01-01"}'

run_dbt_safe_builds() {
  $NODE scripts/run-analytics-build.ts &&
  $NODE scripts/warm-query-cache.ts
}

run_dbt_e2e_builds() {
  dbt build --project-dir analytics --profiles-dir analytics --threads 1 --vars "$DBT_E2E_MICROBATCH_VARS" --select "$DBT_ACTIVITY_MODELS" &&
  dbt build --project-dir analytics --profiles-dir analytics --threads 1 --vars "$DBT_E2E_MICROBATCH_VARS" --select "$DBT_SLEEP_DASHBOARD_MODELS"
}

case "${1:-sync}" in
  web)
    exec $NODE packages/server/src/index.ts
    ;;
  sync)
    $NODE src/db/run-migrate.ts
    run_dbt_safe_builds
    exec $NODE src/index.ts sync
    ;;
  worker)
    $NODE src/db/run-migrate.ts
    exec $NODE src/jobs/worker.ts
    ;;
  migrate)
    exec $NODE src/db/run-migrate.ts
    ;;
  provider-connection-cutover)
    exec $NODE scripts/backfill-provider-connections.ts
    ;;
  analytics)
    run_dbt_safe_builds
    ;;
  analytics-e2e)
    run_dbt_e2e_builds
    ;;
  analytics-worker)
    exec $NODE scripts/run-analytics-worker.ts
    ;;
  cdc-health)
    interval_seconds="${CDC_HEALTH_INTERVAL_SECONDS:-300}"
    case "$interval_seconds" in
      '' | 0 | *[!0-9]*)
        echo "cdc-health: CDC_HEALTH_INTERVAL_SECONDS must be a positive integer, got '$interval_seconds'" >&2
        exit 1
        ;;
    esac
    $NODE scripts/cdc-health-state.ts initialize
    while true; do
      if $NODE scripts/check-clickhouse-cdc.ts; then
        $NODE scripts/cdc-health-state.ts success
        sleep "$interval_seconds"
      else
        status="$?"
        $NODE scripts/cdc-health-state.ts failure
        echo "cdc-health: check failed with exit status $status; retrying in ${interval_seconds}s" >&2
        sleep "$interval_seconds"
      fi
    done
    ;;
  processing-reconciliation)
    while true; do
      if $NODE scripts/reconcile-pending-processing.ts; then
        :
      else
        status="$?"
        echo "processing-reconciliation: reconciliation failed with exit status $status; retrying in 300s" >&2
      fi
      sleep 300
    done
    ;;
  metric-stream-clickhouse-sink)
    exec $NODE src/index.ts metric-stream-clickhouse-sink
    ;;
  seed)
    exec $NODE scripts/seed-dev-db.ts
    ;;
  review-seed-clickhouse)
    exec $NODE scripts/seed-review-clickhouse.ts
    ;;
  *)
    echo "Unknown mode: $1 (expected 'web', 'sync', 'worker', 'migrate', 'provider-connection-cutover', 'analytics', 'analytics-e2e', 'analytics-worker', 'cdc-health', 'processing-reconciliation', 'metric-stream-clickhouse-sink', 'seed', or 'review-seed-clickhouse')" >&2
    exit 1
    ;;
esac
