import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildActivitySummaryRowsTableSql } from "./clickhouse-activity-summary.ts";

const canonicalActivityId = "00000000-0000-0000-0000-000000000111";
const memberActivityId = "00000000-0000-0000-0000-000000000222";
const testUserId = "00000000-0000-0000-0000-000000000001";

type ClickHouseClient = ReturnType<typeof createClient>;

interface ActivitySummaryRow {
  activity_id: string;
  activity_type: string;
  avg_hr: number | null;
  is_deleted: number;
  name: string | null;
  total_distance: number | null;
}

describe("activity_summary_rows canonical activity ids", () => {
  let client: ClickHouseClient | undefined;
  const targetSchema = `analytics_activity_summary_test_${randomBytes(6).toString("hex")}`;

  beforeAll(async () => {
    client = createClient({
      url: requireClickHouseUrl(),
      request_timeout: 120_000,
    });
    await waitForClickHouse(client);
  }, 120_000);

  afterAll(async () => {
    if (client) {
      await client.command({ query: `DROP DATABASE IF EXISTS ${targetSchema} SYNC` });
      await client.close();
    }
  });

  it("rekeys raw member summary changes to the canonical activity", async () => {
    const activeClient = requireClient(client);
    await seedDuplicateActivitySummaryFixture(activeClient, targetSchema);

    await activeClient.command({
      query: `INSERT INTO ${targetSchema}.activity_summary_rows
${renderActivitySummaryRowsSelectSql(targetSchema)}`,
    });

    const visibleRowsResult = await activeClient.query({
      query: `SELECT
          toString(activity_id) AS activity_id,
          coalesce(activity_type, '') AS activity_type,
          name,
          avg_hr,
          total_distance,
          is_deleted
        FROM ${targetSchema}.activity_summary_rows FINAL
        WHERE is_deleted = 0
        ORDER BY activity_id`,
      format: "JSONEachRow",
    });
    const visibleRows = await visibleRowsResult.json<ActivitySummaryRow>();

    expect(visibleRows).toEqual([
      {
        activity_id: canonicalActivityId,
        activity_type: "mountain_biking",
        avg_hr: 150,
        is_deleted: 0,
        name: "Lunch Mountain Bike Ride",
        total_distance: 25000,
      },
    ]);

    const rowStateResult = await activeClient.query({
      query: `SELECT
          toString(activity_id) AS activity_id,
          coalesce(activity_type, '') AS activity_type,
          name,
          avg_hr,
          total_distance,
          is_deleted
        FROM ${targetSchema}.activity_summary_rows FINAL
        ORDER BY activity_id`,
      format: "JSONEachRow",
    });
    const rowStates = await rowStateResult.json<ActivitySummaryRow>();

    expect(
      rowStates.map((row) => ({ activityId: row.activity_id, deleted: row.is_deleted })),
    ).toEqual([
      { activityId: canonicalActivityId, deleted: 0 },
      { activityId: memberActivityId, deleted: 1 },
    ]);
  }, 180_000);

  it("refreshes the canonical summary when only the dedupe mapping changed", async () => {
    const activeClient = requireClient(client);
    await seedDedupeMappingRefreshFixture(activeClient, targetSchema);

    await activeClient.command({
      query: `INSERT INTO ${targetSchema}.activity_summary_rows
${renderActivitySummaryRowsSelectSql(targetSchema)}`,
    });

    const visibleRowsResult = await activeClient.query({
      query: `SELECT
          toString(activity_id) AS activity_id,
          coalesce(activity_type, '') AS activity_type,
          name,
          avg_hr,
          total_distance,
          is_deleted
        FROM ${targetSchema}.activity_summary_rows FINAL
        WHERE is_deleted = 0
        ORDER BY activity_id`,
      format: "JSONEachRow",
    });
    const visibleRows = await visibleRowsResult.json<ActivitySummaryRow>();

    expect(visibleRows).toEqual([
      {
        activity_id: canonicalActivityId,
        activity_type: "mountain_biking",
        avg_hr: 150,
        is_deleted: 0,
        name: "Lunch Mountain Bike Ride",
        total_distance: 25000,
      },
    ]);
  }, 180_000);
});

function requireClickHouseUrl(): string {
  const url = process.env.CLICKHOUSE_URL?.trim();
  if (!url) {
    throw new Error("CLICKHOUSE_URL is required for activity summary integration tests");
  }
  return url;
}

function requireClient(client: ClickHouseClient | undefined): ClickHouseClient {
  if (!client) {
    throw new Error("ClickHouse client was not initialized");
  }
  return client;
}

async function waitForClickHouse(client: ClickHouseClient): Promise<void> {
  let lastError: unknown;
  for (let attemptIndex = 0; attemptIndex < 60; attemptIndex += 1) {
    try {
      await client.query({ query: "SELECT 1", format: "JSONEachRow" });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolveAfterDelay) => setTimeout(resolveAfterDelay, 1_000));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("ClickHouse did not become ready");
}

function readProjectFile(relativePath: string): string {
  return readFileSync(join(import.meta.dirname, "../..", relativePath), "utf8");
}

function renderActivitySummaryRowsSelectSql(targetSchema: string): string {
  return readProjectFile("analytics/models/read_models/activity_summary_rows.sql")
    .replace(/{{ config\([\s\S]*?\) }}\s*/, "")
    .replace(/\{% set initial_lookback_days = var\('initial_lookback_days', 120\) %\}/g, "")
    .replace(
      /\{% if is_incremental\(\) %}\(count\(\) = 0\)\{% else %}1\{% endif %}/g,
      "(count() = 0)",
    )
    .replace(
      /FROM \{% if is_incremental\(\) %}{{ this }}\{% else %}\(SELECT CAST\(null, 'Nullable\(DateTime64\(9, ''UTC''\)\)'\) AS refreshed_at\)\{% endif %}/g,
      `FROM ${targetSchema}.activity_summary_rows`,
    )
    .replace(/\{% if is_incremental\(\) %}\s*([\s\S]*?)\s*\{% else %}[\s\S]*?\{% endif %}/g, "$1")
    .replace(/{{ initial_lookback_days }}/g, "120")
    .replace(/{{ this }}/g, `${targetSchema}.activity_summary_rows`)
    .replace(/{{ ref\('deduped_activities'\) }}/g, `${targetSchema}.deduped_activities`)
    .replace(/{{ ref\('deduped_activity_members'\) }}/g, `${targetSchema}.deduped_activity_members`)
    .replace(
      /{{ ref\('activity_sensor_summary_rows'\) }}/g,
      `${targetSchema}.activity_sensor_summary_rows`,
    )
    .replace(
      /{{ ref\('activity_location_summary_rows'\) }}/g,
      `${targetSchema}.activity_location_summary_rows`,
    )
    .replace(/{{ source\('postgres_fitness', 'activity'\) }}/g, `${targetSchema}.source_activity`)
    .concat("\nSETTINGS join_use_nulls = 1, max_threads = 1");
}

async function runStatements(client: ClickHouseClient, statements: string[]): Promise<void> {
  for (const statement of statements) {
    await client.command({ query: statement });
  }
}

async function seedDuplicateActivitySummaryFixture(
  client: ClickHouseClient,
  targetSchema: string,
): Promise<void> {
  await runStatements(client, [
    `DROP DATABASE IF EXISTS ${targetSchema} SYNC`,
    `CREATE DATABASE ${targetSchema}`,
    createActivityTableSql(targetSchema),
    createDedupedActivitiesTableSql(targetSchema),
    createDedupedActivityMembersTableSql(targetSchema),
    createActivitySensorSummaryRowsTableSql(targetSchema),
    createActivityLocationSummaryRowsTableSql(targetSchema),
    buildActivitySummaryRowsTableSql().replaceAll("analytics.", `${targetSchema}.`),
    insertChangedRawMemberActivitySql(targetSchema),
    insertDedupedActivitiesSql(targetSchema),
    insertDedupedActivityMembersSql(targetSchema),
    insertCanonicalSensorSummarySql(targetSchema),
    insertDirtyRawMemberSensorSummarySql(targetSchema),
    insertCanonicalLocationSummarySql(targetSchema),
    insertStaleRawActivitySummarySql(targetSchema),
  ]);
}

async function seedDedupeMappingRefreshFixture(
  client: ClickHouseClient,
  targetSchema: string,
): Promise<void> {
  await runStatements(client, [
    `DROP DATABASE IF EXISTS ${targetSchema} SYNC`,
    `CREATE DATABASE ${targetSchema}`,
    createActivityTableSql(targetSchema),
    createDedupedActivitiesTableSql(targetSchema),
    createDedupedActivityMembersTableSql(targetSchema),
    createActivitySensorSummaryRowsTableSql(targetSchema),
    createActivityLocationSummaryRowsTableSql(targetSchema),
    buildActivitySummaryRowsTableSql().replaceAll("analytics.", `${targetSchema}.`),
    insertUnchangedRawMemberActivitySql(targetSchema),
    insertDedupedActivitiesSql(targetSchema),
    insertDedupedActivityMembersSql(targetSchema),
    insertCanonicalSensorSummarySql(targetSchema),
    insertCanonicalLocationSummarySql(targetSchema),
    insertStaleRawActivitySummarySql(targetSchema),
  ]);
}

function createActivityTableSql(targetSchema: string): string {
  return `CREATE TABLE ${targetSchema}.source_activity (
  id UUID,
  user_id UUID,
  started_at DateTime64(6, 'UTC'),
  ended_at Nullable(DateTime64(6, 'UTC')),
  _peerdb_synced_at DateTime64(9, 'UTC')
)
ENGINE = ReplacingMergeTree(_peerdb_synced_at)
ORDER BY id`;
}

function createDedupedActivitiesTableSql(targetSchema: string): string {
  return `CREATE TABLE ${targetSchema}.deduped_activities (
  activity_id UUID,
  provider_id String,
  user_id UUID,
  primary_activity_id UUID,
  activity_type String,
  name Nullable(String),
  started_at DateTime64(6, 'UTC'),
  ended_at Nullable(DateTime64(6, 'UTC')),
  source_name Nullable(String),
  notes Nullable(String),
  timezone Nullable(String),
  raw Nullable(String),
  source_synced_at DateTime64(9, 'UTC'),
  source_providers Array(String),
  source_external_ids Array(Map(String, String)),
  absent_source_external_ids Array(Map(String, String)),
  member_activity_ids Array(UUID),
  refresh_version UInt64,
  is_deleted UInt8,
  refreshed_at DateTime64(9, 'UTC')
)
ENGINE = ReplacingMergeTree(refresh_version)
ORDER BY (user_id, activity_id)`;
}

function createDedupedActivityMembersTableSql(targetSchema: string): string {
  return `CREATE TABLE ${targetSchema}.deduped_activity_members (
  activity_id UUID,
  user_id UUID,
  started_at DateTime64(6, 'UTC'),
  ended_at Nullable(DateTime64(6, 'UTC')),
  source_synced_at DateTime64(9, 'UTC'),
  member_activity_id UUID,
  refresh_version UInt64,
  is_deleted UInt8,
  refreshed_at DateTime64(9, 'UTC')
)
ENGINE = ReplacingMergeTree(refresh_version)
ORDER BY (user_id, member_activity_id)`;
}

function createActivitySensorSummaryRowsTableSql(targetSchema: string): string {
  return `CREATE TABLE ${targetSchema}.activity_sensor_summary_rows (
  activity_id UUID,
  user_id UUID,
  avg_hr Nullable(Float64),
  max_hr Nullable(Int16),
  min_hr Nullable(Int16),
  avg_power Nullable(Float64),
  max_power Nullable(Int16),
  avg_speed Nullable(Float64),
  max_speed Nullable(Float64),
  avg_cadence Nullable(Float64),
  elevation_gain_legacy Nullable(Float64),
  avg_left_balance Nullable(Float64),
  avg_left_torque_eff Nullable(Float64),
  avg_right_torque_eff Nullable(Float64),
  avg_left_pedal_smooth Nullable(Float64),
  avg_right_pedal_smooth Nullable(Float64),
  elevation_gain_m Nullable(Float64),
  elevation_loss_m Nullable(Float64),
  avg_stance_time Nullable(Float64),
  avg_vertical_osc Nullable(Float64),
  avg_ground_contact_time Nullable(Float64),
  avg_stride_length Nullable(Float64),
  sample_count Nullable(UInt64),
  hr_sample_count Nullable(UInt64),
  power_sample_count Nullable(UInt64),
  first_sample_at Nullable(DateTime64(6, 'UTC')),
  last_sample_at Nullable(DateTime64(6, 'UTC')),
  best_twenty_minute_power Nullable(Float64),
  normalized_power Nullable(Float64),
  smoothed_avg_power Nullable(Float64),
  climbing_elevation_gain_m Nullable(Float64),
  climbing_seconds Nullable(Int32),
  refresh_version UInt64,
  is_deleted UInt8,
  refreshed_at DateTime64(9, 'UTC')
)
ENGINE = ReplacingMergeTree(refresh_version)
ORDER BY (user_id, activity_id)`;
}

function createActivityLocationSummaryRowsTableSql(targetSchema: string): string {
  return `CREATE TABLE ${targetSchema}.activity_location_summary_rows (
  activity_id UUID,
  user_id UUID,
  total_distance Nullable(Float64),
  centroid_lat Nullable(Float64),
  centroid_lng Nullable(Float64),
  refresh_version UInt64,
  is_deleted UInt8,
  refreshed_at DateTime64(9, 'UTC')
)
ENGINE = ReplacingMergeTree(refresh_version)
ORDER BY (user_id, activity_id)`;
}

function insertChangedRawMemberActivitySql(targetSchema: string): string {
  return `INSERT INTO ${targetSchema}.source_activity VALUES
  ('${memberActivityId}', '${testUserId}', toDateTime64('2026-05-31 18:08:51', 6, 'UTC'), toDateTime64('2026-05-31 19:42:38', 6, 'UTC'), toDateTime64('2026-06-01 00:10:00', 9, 'UTC'))`;
}

function insertUnchangedRawMemberActivitySql(targetSchema: string): string {
  return `INSERT INTO ${targetSchema}.source_activity VALUES
  ('${memberActivityId}', '${testUserId}', toDateTime64('2026-05-31 18:08:51', 6, 'UTC'), toDateTime64('2026-05-31 19:42:38', 6, 'UTC'), toDateTime64('2026-05-31 23:30:00', 9, 'UTC'))`;
}

function insertDedupedActivitiesSql(targetSchema: string): string {
  return `INSERT INTO ${targetSchema}.deduped_activities VALUES
  ('${canonicalActivityId}', 'garmin', '${testUserId}', '${canonicalActivityId}', 'mountain_biking', 'Lunch Mountain Bike Ride', toDateTime64('2026-05-31 18:08:51', 6, 'UTC'), toDateTime64('2026-05-31 19:42:38', 6, 'UTC'), 'Garmin Edge', NULL, 'America/Los_Angeles', NULL, toDateTime64('2026-06-01 00:10:00', 9, 'UTC'), ['garmin', 'wahoo'], [], [], ['${canonicalActivityId}', '${memberActivityId}'], 400, 0, toDateTime64('2026-06-01 00:10:00', 9, 'UTC'))`;
}

function insertDedupedActivityMembersSql(targetSchema: string): string {
  return `INSERT INTO ${targetSchema}.deduped_activity_members VALUES
  ('${canonicalActivityId}', '${testUserId}', toDateTime64('2026-05-31 18:08:51', 6, 'UTC'), toDateTime64('2026-05-31 19:42:38', 6, 'UTC'), toDateTime64('2026-06-01 00:10:00', 9, 'UTC'), '${canonicalActivityId}', 400, 0, toDateTime64('2026-06-01 00:10:00', 9, 'UTC')),
  ('${canonicalActivityId}', '${testUserId}', toDateTime64('2026-05-31 18:08:51', 6, 'UTC'), toDateTime64('2026-05-31 19:42:38', 6, 'UTC'), toDateTime64('2026-06-01 00:10:00', 9, 'UTC'), '${memberActivityId}', 400, 0, toDateTime64('2026-06-01 00:10:00', 9, 'UTC'))`;
}

function insertCanonicalSensorSummarySql(targetSchema: string): string {
  return `INSERT INTO ${targetSchema}.activity_sensor_summary_rows VALUES
  ('${canonicalActivityId}', '${testUserId}', 150.0, 180, 90, 220.0, 500, 8.0, 16.0, 85.0, NULL, NULL, NULL, NULL, NULL, NULL, 100.0, 40.0, NULL, NULL, NULL, NULL, 1200, 1200, 600, toDateTime64('2026-05-31 18:08:51', 6, 'UTC'), toDateTime64('2026-05-31 19:42:38', 6, 'UTC'), NULL, NULL, NULL, NULL, NULL, 200, 0, toDateTime64('2026-05-31 23:30:00', 9, 'UTC'))`;
}

function insertDirtyRawMemberSensorSummarySql(targetSchema: string): string {
  return `INSERT INTO ${targetSchema}.activity_sensor_summary_rows VALUES
  ('${memberActivityId}', '${testUserId}', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 300, 0, toDateTime64('2026-06-01 00:10:00', 9, 'UTC'))`;
}

function insertCanonicalLocationSummarySql(targetSchema: string): string {
  return `INSERT INTO ${targetSchema}.activity_location_summary_rows VALUES
  ('${canonicalActivityId}', '${testUserId}', 25000.0, 37.1, -122.1, 200, 0, toDateTime64('2026-05-31 23:30:00', 9, 'UTC'))`;
}

function insertStaleRawActivitySummarySql(targetSchema: string): string {
  return `INSERT INTO ${targetSchema}.activity_summary_rows VALUES
  ('${memberActivityId}', '${testUserId}', 'cycling', NULL, toDateTime64('2026-05-31 18:08:51', 6, 'UTC'), toDateTime64('2026-05-31 19:42:38', 6, 'UTC'), NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, 0, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 100, 0, toDateTime64('2026-06-01 00:00:00', 9, 'UTC'))`;
}
