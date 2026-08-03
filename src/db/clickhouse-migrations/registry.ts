import { createMigration as createMigration0001 } from "./0001_clickhouse_analytics_schema_cleanup.ts";
import { createMigration as createMigration0002 } from "./0002_clickhouse_postgres_bridge_and_activity_read_models.ts";
import { createMigration as createMigration0004 } from "./0004_reenable_materialized_metric_stream.ts";
import { createMigration as createMigration0005 } from "./0005_backfill_materialized_metric_stream.ts";
import { createMigration as createMigration0006 } from "./0006_backfill_native_metric_stream.ts";
import { createMigration as createMigration0007RemainingViews } from "./0007_remaining_postgres_views_to_clickhouse.ts";
import { createMigration as createMigration0007RepairMetricStream } from "./0007_repair_legacy_metric_stream_engine.ts";
import { createMigration as createMigration0008 } from "./0008_complete_provider_stats_raw_mirrors.ts";
import { createMigration as createMigration0009 } from "./0009_drop_derived_resting_heart_rate_read_model.ts";
import { createMigration as createMigration0010 } from "./0010_include_standalone_deduped_sensor_samples.ts";
import { createMigration as createMigration0011 } from "./0011_activity_trend_daily_read_model.ts";
import { createMigration as createMigration0012 } from "./0012_repair_metric_stream_backfill.ts";
import { createMigration as createMigration0013 } from "./0013_metric_stream_location_point.ts";
import { createMigration as createMigration0014 } from "./0014_resting_heart_rate_sleep_window_materialized_view.ts";
import { createMigration as createMigration0015 } from "./0015_activity_summary_centroids.ts";
import { createMigration as createMigration0016 } from "./0016_reduce_metric_stream_refresh_load.ts";
import { createMigration as createMigration0017 } from "./0017_body_measurement_sample_projection.ts";
import { createMigration as createMigration0018 } from "./0018_sensor_priority_raw_tables.ts";
import { createMigration as createMigration0019 } from "./0019_non_sensor_read_models_as_views.ts";
import { createMigration as createMigration0020 } from "./0020_incremental_deduped_sensor.ts";
import { createMigration as createMigration0021 } from "./0021_incremental_resting_heart_rate.ts";
import { createMigration as createMigration0022 } from "./0022_incremental_activity_summary.ts";
import { createMigration as createMigration0023 } from "./0023_incremental_activity_vo2max_estimate.ts";
import { createMigration as createMigration0024 } from "./0024_create_dbt_serving_read_model_tables.ts";
import { createMigration as createMigration0025 } from "./0025_recreate_provider_stats_dbt_table.ts";
import { createMigration as createMigration0026 } from "./0026_create_dashboard_tables.ts";
import { createMigration as createMigration0027 } from "./0027_create_daily_sleep_table.ts";
import { createMigration as createMigration0028 } from "./0028_create_domain_dashboard_tables.ts";
import { createMigration as createMigration0029 } from "./0029_activity_provider_absence.ts";
import { createMigration as createMigration0030 } from "./0030_activity_mirror_order_key.ts";
import { createMigration as createMigration0031 } from "./0031_activity_user_soft_delete.ts";
import { createMigration as createMigration0032 } from "./0032_deduped_activities_absent_source_links.ts";
import { createMigration as createMigration0033 } from "./0033_recreate_deduped_activities_column_order.ts";
import { createMigration as createMigration0034 } from "./0034_move_metric_stream_to_ingest.ts";
import { createMigration as createMigration0035 } from "./0035_activity_summary_power_climbing_columns.ts";
import { createMigration as createMigration0036 } from "./0036_activity_sensor_summary_power_climbing_columns.ts";
import { createMigration as createMigration0037 } from "./0037_sleep_session_is_nap.ts";
import { createMigration as createMigration0038 } from "./0038_body_measurement_sample_synced_at_non_nullable.ts";
import { createMigration as createMigration0039 } from "./0039_create_daily_endurance_load_table.ts";
import { createMigration as createMigration0040 } from "./0040_create_weekly_endurance_training_tables.ts";
import { createMigration as createMigration0041 } from "./0041_drop_daily_metrics_cycling_distance.ts";
import { createMigration as createMigration0042 } from "./0042_recreate_activity_sensor_summary_column_order.ts";
import { createMigration as createMigration0043 } from "./0043_activity_stream_lifecycle_columns.ts";
import { createMigration as createMigration0045 } from "./0045_metric_stream_delete_acknowledgement.ts";
import { createMigration as createMigration0046 } from "./0046_provider_data_generation.ts";
import { createMigration as createMigration0047 } from "./0047_cover_provider_generation_projection.ts";
import { createMigration as createMigration0048 } from "./0048_provider_live_generation_projection.ts";
import { createMigration as createMigration0049 } from "./0049_daily_sleep_provenance.ts";
import { createMigration as createMigration0050 } from "./0050_repair_body_measurement_sample_ingest.ts";
import { createMigration as createMigration0051 } from "./0051_metric_stream_processing_acknowledgement.ts";
import { createMigration as createMigration0052 } from "./0052_processing_flow_markers.ts";
import { createMigration as createMigration0053 } from "./0053_daily_sleep_lifecycle.ts";
import { createMigration as createMigration0054 } from "./0054_activity_load_lifecycle.ts";
import { createMigration as createMigration0055 } from "./0055_provider_connection_catalog.ts";
import { createMigration as createMigration0056 } from "./0056_daily_body_measurement_lifecycle.ts";
import { createMigration as createMigration0057 } from "./0057_daily_recovery_lifecycle.ts";
import { createMigration as createMigration0058 } from "./0058_migrate_body_measurement_to_dbt.ts";
import { createMigration as createMigration0059 } from "./0059_provider_change_state.ts";
import { createMigration as createMigration0060 } from "./0060_heart_rate_day_change.ts";
import { createMigration as createMigration0061 } from "./0061_provider_current_state_projection.ts";
import { createMigration as createMigration0062 } from "./0062_daily_recovery_baseline_context.ts";
import { createMigration as createMigration0063 } from "./0063_record_local_time_context.ts";
import { createMigration as createMigration0064 } from "./0064_activity_summary_freshness.ts";
import { createMigration as createMigration0065 } from "./0065_sleep_staging_available.ts";
import { createMigration as createMigration0066 } from "./0066_daily_sleep_overlap_evidence.ts";
import { createMigration as createMigration0067 } from "./0067_repair_local_time_column_order.ts";
import { createMigration as createMigration0068 } from "./0068_provider_metric_stream_daily_counts.ts";
import { createMigration as createMigration0069 } from "./0069_canonical_activity_types.ts";
import type { ClickHouseMigration, ClickHouseMigrationFactory } from "./types.ts";

const migrationFactories: ClickHouseMigrationFactory[] = [
  createMigration0001,
  createMigration0002,
  createMigration0004,
  createMigration0005,
  createMigration0006,
  createMigration0007RemainingViews,
  createMigration0007RepairMetricStream,
  createMigration0008,
  createMigration0009,
  createMigration0010,
  createMigration0011,
  createMigration0012,
  createMigration0013,
  createMigration0014,
  createMigration0015,
  createMigration0016,
  createMigration0017,
  createMigration0018,
  createMigration0019,
  createMigration0020,
  createMigration0021,
  createMigration0022,
  createMigration0023,
  createMigration0024,
  createMigration0025,
  createMigration0026,
  createMigration0027,
  createMigration0028,
  createMigration0029,
  createMigration0030,
  createMigration0031,
  createMigration0032,
  createMigration0033,
  createMigration0034,
  createMigration0035,
  createMigration0036,
  createMigration0037,
  createMigration0038,
  createMigration0039,
  createMigration0040,
  createMigration0041,
  createMigration0042,
  createMigration0043,
  createMigration0045,
  createMigration0046,
  createMigration0047,
  createMigration0048,
  createMigration0049,
  createMigration0050,
  createMigration0051,
  createMigration0052,
  createMigration0053,
  createMigration0054,
  createMigration0055,
  createMigration0056,
  createMigration0057,
  createMigration0058,
  createMigration0059,
  createMigration0060,
  createMigration0061,
  createMigration0062,
  createMigration0063,
  createMigration0064,
  createMigration0065,
  createMigration0066,
  createMigration0067,
  createMigration0068,
  createMigration0069,
];

export function clickHouseMigrations(postgresConnectionString: string): ClickHouseMigration[] {
  const migrations = migrationFactories.map((createMigration) =>
    createMigration(postgresConnectionString),
  );
  validateClickHouseMigrations(migrations);
  return migrations;
}

function validateClickHouseMigrations(migrations: ClickHouseMigration[]): void {
  const seenMigrationIds = new Set<string>();
  let previousMigrationNumber = 0;

  for (const migration of migrations) {
    if (seenMigrationIds.has(migration.id)) {
      throw new Error(`Duplicate ClickHouse migration id: ${migration.id}`);
    }
    seenMigrationIds.add(migration.id);

    const migrationNumberMatch = migration.id.match(/^([0-9]{4})_/);
    if (!migrationNumberMatch) {
      throw new Error(
        `ClickHouse migration id must start with a four digit prefix: ${migration.id}`,
      );
    }

    const migrationNumber = Number(migrationNumberMatch[1]);
    if (migrationNumber < previousMigrationNumber) {
      throw new Error(`ClickHouse migration id is out of order: ${migration.id}`);
    }
    previousMigrationNumber = migrationNumber;
  }
}
