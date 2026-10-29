import { spawn } from "node:child_process";
import type { createClient } from "@clickhouse/client";
import { buildIngestMetricStreamCreateTableSql } from "../metric-stream/clickhouse-table.ts";
import {
  buildPostgresFitnessProviderFieldPriorityRawTableStatement,
  buildPostgresFitnessRawTableStatements,
} from "./clickhouse-raw-tables.ts";
import { TEST_USER_ID } from "./schema/core.ts";

type NativeClickHouseClient = ReturnType<typeof createClient>;
const wahooActivityId = "2a7c6fa3-32f1-4ae5-9c99-b981c31e289b";
const pelotonActivityId = "761483e6-0000-4000-8000-000000000001";
const namedZoneActivityId = "894ce621-0000-4000-8000-000000000001";
const unrelatedActivityId = "9f99f9a7-0000-4000-8000-000000000001";

export const activityIntegrityFixtureIds = {
  wahooActivityId,
  pelotonActivityId,
  namedZoneActivityId,
  unrelatedActivityId,
};
export async function seedProductionDbtFixture(
  client: NativeClickHouseClient,
  database: string,
): Promise<void> {
  const statements = [
    `DROP DATABASE IF EXISTS ${database} SYNC`,
    `CREATE DATABASE ${database}`,
    buildPostgresFitnessProviderFieldPriorityRawTableStatement().replaceAll(
      "postgres_fitness.",
      `${database}.`,
    ),
    ...buildPostgresFitnessRawTableStatements()
      .filter((statement) =>
        /^CREATE TABLE IF NOT EXISTS postgres_fitness\.sensor_(provider|device)_priority \(/.test(
          statement,
        ),
      )
      .map((statement) => statement.replaceAll("postgres_fitness.", `${database}.`)),
    `CREATE TABLE ${database}.activity (
      id UUID,
      provider_id String,
      user_id UUID,
      external_id String,
      canonical_type String,
      provider_type String,
      modality Nullable(String),
      started_at DateTime64(6, 'UTC'),
      ended_at Nullable(DateTime64(6, 'UTC')),
      source_name Nullable(String),
      name Nullable(String),
      notes Nullable(String),
      timezone Nullable(String),
      start_utc_offset_minutes Nullable(Int16),
      end_utc_offset_minutes Nullable(Int16),
      local_time_source String,
      rejected_provider_timezone Nullable(String),
      rejected_provider_start_utc_offset_minutes Nullable(Int64),
      rejected_provider_end_utc_offset_minutes Nullable(Int64),
      raw String,
      provider_absent_at Nullable(DateTime64(6, 'UTC')),
      deleted_at Nullable(DateTime64(6, 'UTC')),
      _peerdb_is_deleted UInt8,
      _peerdb_synced_at DateTime64(9, 'UTC'),
      _peerdb_version UInt64,
      group_id UUID,
      created_at DateTime64(6, 'UTC')
    ) ENGINE = ReplacingMergeTree(_peerdb_version) ORDER BY id`,
    `CREATE TABLE ${database}.provider_priority (
      provider_id String,
      priority Int16,
      _peerdb_is_deleted UInt8
    ) ENGINE = ReplacingMergeTree() ORDER BY provider_id`,
    `CREATE TABLE ${database}.device_priority (
      provider_id String,
      source_name_pattern String,
      priority Int16,
      _peerdb_is_deleted UInt8
    ) ENGINE = ReplacingMergeTree() ORDER BY (provider_id, source_name_pattern)`,
    `CREATE TABLE ${database}.deduped_sensor (
      user_id UUID,
      recorded_at DateTime64(6, 'UTC'),
      recorded_date Date,
      channel String,
      scalar Nullable(Float64),
      provider_id Nullable(String),
      member_activity_id Nullable(UUID),
      device_id Nullable(String),
      source_external_id Nullable(String),
      source_type Nullable(String),
      source_metric_stream_id Nullable(UUID),
      measurement_kind LowCardinality(String),
      source_activity_id Nullable(UUID),
      refresh_version UInt64,
      is_deleted UInt8,
      refreshed_at DateTime64(9, 'UTC')
    ) ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY (user_id, channel, recorded_date, recorded_at)`,
    buildIngestMetricStreamCreateTableSql().replaceAll(
      "ingest.metric_stream",
      `${database}.metric_stream`,
    ),
    `CREATE TABLE ${database}.metric_stream_day_change (
      user_id UUID,
      provider_id String,
      recorded_date Date,
      changed_at SimpleAggregateFunction(max, DateTime64(9, 'UTC'))
    ) ENGINE = AggregatingMergeTree ORDER BY (user_id, provider_id, recorded_date)`,
    `CREATE TABLE ${database}.activity_location_summary_rows (
      activity_id UUID,
      user_id UUID,
      total_distance Nullable(Float64),
      centroid_lat Nullable(Float64),
      centroid_lng Nullable(Float64),
      refresh_version UInt64,
      is_deleted UInt8,
      refreshed_at DateTime64(9, 'UTC')
    ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (user_id, activity_id)`,
    `CREATE TABLE ${database}.body_measurement_sample (
      user_id UUID,
      channel String,
      _peerdb_synced_at DateTime64(9, 'UTC')
    ) ENGINE = ReplacingMergeTree() ORDER BY user_id`,
    `CREATE TABLE ${database}.body_measurement (
      user_id UUID,
      recorded_at DateTime64(6, 'UTC'),
      weight_kg Nullable(Float64),
      is_deleted UInt8
    ) ENGINE = ReplacingMergeTree() ORDER BY (user_id, recorded_at)`,
    `CREATE TABLE ${database}.user_profile (
      id UUID,
      _peerdb_synced_at DateTime64(9, 'UTC')
    ) ENGINE = ReplacingMergeTree() ORDER BY id`,
    `CREATE TABLE ${database}.user_profile_current (
      id UUID,
      max_hr Nullable(Int32)
    ) ENGINE = MergeTree ORDER BY id`,
    `CREATE TABLE ${database}.resting_heart_rate_sleep_window (
      user_id UUID,
      ended_at Nullable(DateTime64(6, 'UTC')),
      resting_hr Nullable(Int32),
      is_deleted UInt8,
      refreshed_at DateTime64(9, 'UTC')
    ) ENGINE = ReplacingMergeTree() ORDER BY (user_id, ended_at)
      SETTINGS allow_nullable_key = 1`,
    `INSERT INTO ${database}.deduped_sensor VALUES
      (
        '${TEST_USER_ID}', toDateTime64('2026-09-01 15:10:00', 6, 'UTC'),
        toDate('2026-09-01'), 'heart_rate', 150, 'wahoo', '${wahooActivityId}',
        NULL, 'heart-rate-1', 'activity', '10000000-0000-0000-0000-000000000001',
        'direct', '${wahooActivityId}', 1, 0,
        toDateTime64('2026-09-02 17:00:00', 9, 'UTC')
      ),
      (
        '${TEST_USER_ID}', toDateTime64('2026-09-01 15:15:00', 6, 'UTC'),
        toDate('2026-09-01'), 'heart_rate', 145, 'peloton', '${pelotonActivityId}',
        NULL, 'heart-rate-2', 'activity', '10000000-0000-0000-0000-000000000002',
        'direct', '${pelotonActivityId}', 1, 0,
        toDateTime64('2026-09-02 17:00:00', 9, 'UTC')
      )`,
    `INSERT INTO ${database}.activity VALUES
      (
        '${wahooActivityId}', 'wahoo', '${TEST_USER_ID}', 'wahoo-ride', 'other',
        'workout', NULL, toDateTime64('2026-09-01 14:50:00', 6, 'UTC'),
        toDateTime64('2026-09-01 15:30:00', 6, 'UTC'), NULL, 'Wahoo ride', NULL,
        NULL, NULL, NULL, 'unknown', NULL, NULL, NULL, '{}', NULL, NULL, 0,
        toDateTime64('2026-09-02 17:00:00', 9, 'UTC'), 1, '${wahooActivityId}',
        toDateTime64('2026-09-02 17:00:00', 6, 'UTC')
      ),
      (
        '${pelotonActivityId}', 'peloton', '${TEST_USER_ID}', 'peloton-ride', 'cycling',
        'cycling', 'indoor', toDateTime64('2026-09-01 14:55:54', 6, 'UTC'),
        toDateTime64('2026-09-01 15:25:54', 6, 'UTC'), NULL, 'Peloton ride', NULL,
        'Etc/GMT+4', -300, -300, 'provider_timezone', NULL, NULL, NULL, '{}', NULL, NULL, 0,
        toDateTime64('2026-09-02 17:00:00', 9, 'UTC'), 1, '${pelotonActivityId}',
        toDateTime64('2026-09-02 17:00:00', 6, 'UTC')
      ),
      (
        '${namedZoneActivityId}', 'wahoo', '${TEST_USER_ID}', 'named-zone-ride', 'cycling',
        'cycling', NULL, toDateTime64('2026-09-01 15:00:00', 6, 'UTC'),
        toDateTime64('2026-09-01 15:30:00', 6, 'UTC'), NULL, 'Named zone ride', NULL,
        'America/New_York', -420, -420, 'provider_timezone', NULL, NULL, NULL, '{}', NULL, NULL, 0,
        toDateTime64('2026-09-02 17:00:00', 9, 'UTC'), 1, '${pelotonActivityId}',
        toDateTime64('2026-09-02 17:00:00', 6, 'UTC')
      ),
      (
        '${unrelatedActivityId}', 'wahoo', '${TEST_USER_ID}', 'unrelated-ride', 'cycling',
        'cycling', NULL, toDateTime64('2026-08-01 16:00:00', 6, 'UTC'),
        toDateTime64('2026-08-01 17:00:00', 6, 'UTC'), NULL, 'Unrelated ride', NULL,
        'America/New_York', -240, -240, 'provider_timezone', NULL, NULL, NULL, '{}', NULL, NULL, 0,
        toDateTime64('2026-09-02 17:00:00', 9, 'UTC'), 1, '${unrelatedActivityId}',
        toDateTime64('2026-09-02 17:00:00', 6, 'UTC')
      )`,
  ];
  for (const statement of statements) await client.command({ query: statement });
}

/** Build current upstream prerequisite tables; never replay production migrations. */
export async function bootstrapActivityIntegrityIdentityModels(): Promise<void> {
  const code = await new Promise<number>((resolveExit, reject) => {
    const child = spawn(
      "uv",
      [
        "run",
        "--project",
        "analytics",
        "dbt",
        "build",
        "--project-dir",
        "analytics",
        "--profiles-dir",
        "analytics",
        "--threads",
        "1",
        "--select",
        "activity_source_records activity_duplicate_matches activity_duplicate_groups deduped_activities deduped_activity_members",
      ],
      {
        env: {
          ...process.env,
          UV_PROJECT_ENVIRONMENT: process.env.UV_PROJECT_ENVIRONMENT ?? "../.venv-analytics",
        },
        stdio: "inherit",
      },
    );
    child.once("error", reject);
    child.once("close", (value) => resolveExit(value ?? 1));
  });
  if (code !== 0) throw new Error(`Identity fixture dbt bootstrap failed with exit code ${code}`);
}
