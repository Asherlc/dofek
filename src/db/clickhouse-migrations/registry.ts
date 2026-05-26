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
];

export const clickHouseMigrationFileNames = [
  "0001_clickhouse_analytics_schema_cleanup.ts",
  "0002_clickhouse_postgres_bridge_and_activity_read_models.ts",
  "0004_reenable_materialized_metric_stream.ts",
  "0005_backfill_materialized_metric_stream.ts",
  "0006_backfill_native_metric_stream.ts",
  "0007_remaining_postgres_views_to_clickhouse.ts",
  "0007_repair_legacy_metric_stream_engine.ts",
  "0008_complete_provider_stats_raw_mirrors.ts",
  "0009_drop_derived_resting_heart_rate_read_model.ts",
  "0010_include_standalone_deduped_sensor_samples.ts",
  "0011_activity_trend_daily_read_model.ts",
  "0012_repair_metric_stream_backfill.ts",
  "0013_metric_stream_location_point.ts",
  "0014_resting_heart_rate_sleep_window_materialized_view.ts",
  "0015_activity_summary_centroids.ts",
  "0016_reduce_metric_stream_refresh_load.ts",
  "0017_body_measurement_sample_projection.ts",
  "0018_sensor_priority_raw_tables.ts",
  "0019_non_sensor_read_models_as_views.ts",
  "0020_incremental_deduped_sensor.ts",
  "0021_incremental_resting_heart_rate.ts",
  "0022_incremental_activity_summary.ts",
  "0023_incremental_activity_vo2max_estimate.ts",
] as const;

export function clickHouseMigrations(postgresConnectionString: string): ClickHouseMigration[] {
  return migrationFactories.map((createMigration) => createMigration(postgresConnectionString));
}
