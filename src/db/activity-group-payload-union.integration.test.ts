import { randomBytes } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildActivitySensorSummaryRowsTableSql } from "./clickhouse-activity-sensor-summary.ts";
import { buildActivitySummaryRowsTableSql } from "./clickhouse-activity-summary.ts";
import { readModelSql, renderDbtModelSql } from "./read-model-sql-test-helpers.ts";

type ClickHouseClient = ReturnType<typeof createClient>;

const userId = "00000000-0000-0000-0000-000000000001";
const groupId = "00000000-0000-0000-0000-000000000100";
const pelotonId = "00000000-0000-0000-0000-000000000101";
const whoopId = "00000000-0000-0000-0000-000000000102";
const routeId = "00000000-0000-0000-0000-000000000103";
const priorGroupId = "00000000-0000-0000-0000-000000000104";
const representatives = [pelotonId, whoopId, routeId] as const;

const summarySchema = z.object({
  activity_id: z.string(),
  canonical_type: z.string(),
  provider_type: z.string(),
  avg_hr: z.coerce.number(),
  elevation_gain_m: z.coerce.number(),
  elevation_loss_m: z.coerce.number(),
  total_distance: z.coerce.number(),
  centroid_lat: z.coerce.number(),
  centroid_lng: z.coerce.number(),
  sample_count: z.coerce.number(),
  is_deleted: z.coerce.number(),
});

describe("stable activity group payload union", () => {
  let client: ClickHouseClient | undefined;
  const database = `analytics_activity_group_union_${randomBytes(6).toString("hex")}`;

  beforeAll(async () => {
    client = createClient({ url: requireClickHouseUrl(), request_timeout: 120_000 });
    await waitForClickHouse(client);
  }, 120_000);

  afterAll(async () => {
    if (client) {
      await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
      await client.close();
    }
  });

  it("hydrates HR, GPS, and elevation from disjoint members for every representative", async () => {
    const activeClient = requireClient(client);
    const populatedFieldSets: string[][] = [];
    const payloadSnapshots: string[] = [];

    for (const representativeId of representatives) {
      await seedFixture(activeClient, database, representativeId);
      await buildHydration(activeClient, database);

      const result = await activeClient.query({
        query: `SELECT
          toString(activity_id) AS activity_id,
          canonical_type,
          provider_type,
          avg_hr,
          elevation_gain_m,
          elevation_loss_m,
          total_distance,
          centroid_lat,
          centroid_lng,
          sample_count,
          is_deleted
        FROM ${database}.activity_summary_rows AS activity_summary_rows FINAL
        WHERE activity_summary_rows.activity_id = toUUID('${groupId}')`,
        format: "JSONEachRow",
      });
      const rows = z.array(summarySchema).parse(await result.json<unknown>());
      expect(rows).toHaveLength(1);
      const summary = summarySchema.parse(rows[0]);
      expect(summary).toMatchObject({
        activity_id: groupId,
        canonical_type: "cycling",
        provider_type: "commuting",
        avg_hr: 110,
        elevation_gain_m: 10,
        elevation_loss_m: 5,
        sample_count: 6,
        is_deleted: 0,
      });
      expect(summary.total_distance).toBeGreaterThan(100);
      expect(summary.centroid_lat).toBeCloseTo(37.805, 3);
      expect(summary.centroid_lng).toBeCloseTo(-122.275, 3);

      populatedFieldSets.push(
        Object.entries(summary)
          .filter(([, value]) => value !== null)
          .map(([field]) => field)
          .sort(),
      );
      payloadSnapshots.push(JSON.stringify(summary));
    }

    expect(new Set(populatedFieldSets.map((fields) => fields.join(",")))).toHaveLength(1);
    expect(new Set(payloadSnapshots)).toHaveLength(1);
  }, 180_000);

  it("maps scoped member refreshes to the stable key and tombstones prior member summaries", async () => {
    const activeClient = requireClient(client);
    await seedFixture(activeClient, database, whoopId);
    await runStatements(activeClient, [
      `INSERT INTO ${database}.activity_sensor_sample ${renderModel("activity_sensor_sample.sql", database, false)}`,
      `INSERT INTO ${database}.activity_location_sample ${renderModel("activity_location_sample.sql", database, false)}`,
      `INSERT INTO ${database}.deduped_activities VALUES
        ('${priorGroupId}', 'peloton', '${userId}', '${pelotonId}', 'cardio', '', NULL,
         'Peloton Ride', toDateTime64('2026-09-03 14:00:00', 6, 'UTC'),
         toDateTime64('2026-09-03 15:00:00', 6, 'UTC'),
         toDateTime64('2026-09-03 16:00:00', 9, 'UTC'), ['${pelotonId}'], 2, 1,
         toDateTime64('2026-09-03 16:04:00', 9, 'UTC'))`,
      `INSERT INTO ${database}.activity_sensor_summary_rows
        (activity_id, user_id, sample_count, source_refresh_version, refresh_version, is_deleted, refreshed_at)
        VALUES ('${priorGroupId}', '${userId}', 0, 1, 1, 0, toDateTime64('2026-09-03 16:03:00', 9, 'UTC'))`,
      `INSERT INTO ${database}.activity_location_summary_rows VALUES
        ('${priorGroupId}', '${userId}', NULL, NULL, NULL, 1, 0, toDateTime64('2026-09-03 16:03:00', 9, 'UTC'))`,
      `INSERT INTO ${database}.activity_summary_rows
        (activity_id, user_id, canonical_type, started_at, refresh_version, is_deleted, refreshed_at)
        VALUES ('${priorGroupId}', '${userId}', 'cardio',
          toDateTime64('2026-09-03 14:00:00', 6, 'UTC'), 1, 0,
          toDateTime64('2026-09-03 16:03:00', 9, 'UTC'))`,
      `INSERT INTO ${database}.activity_sensor_summary_rows ${renderModel("activity_sensor_summary_rows.sql", database, true, [pelotonId])}`,
      `INSERT INTO ${database}.activity_location_summary_rows ${renderModel("activity_location_summary_rows.sql", database, true, [pelotonId])}`,
      `INSERT INTO ${database}.activity_summary_rows ${renderModel("activity_summary_rows.sql", database, true, [pelotonId])}`,
    ]);

    const result = await activeClient.query({
      query: `SELECT 'sensor' AS payload, toString(activity_id) AS activity_id, is_deleted
        FROM ${database}.activity_sensor_summary_rows FINAL
        UNION ALL
        SELECT 'location' AS payload, toString(activity_id) AS activity_id, is_deleted
        FROM ${database}.activity_location_summary_rows FINAL
        UNION ALL
        SELECT 'summary' AS payload, toString(activity_id) AS activity_id, is_deleted
        FROM ${database}.activity_summary_rows FINAL
        ORDER BY payload, activity_id`,
      format: "JSONEachRow",
    });

    const lifecycleRows = z
      .array(
        z.object({
          payload: z.string(),
          activity_id: z.string(),
          is_deleted: z.coerce.number(),
        }),
      )
      .parse(await result.json<unknown>())
      .sort((left, right) =>
        `${left.payload}:${left.activity_id}`.localeCompare(
          `${right.payload}:${right.activity_id}`,
        ),
      );

    expect(lifecycleRows).toEqual([
      { payload: "location", activity_id: groupId, is_deleted: 0 },
      { payload: "location", activity_id: priorGroupId, is_deleted: 1 },
      { payload: "sensor", activity_id: groupId, is_deleted: 0 },
      { payload: "sensor", activity_id: priorGroupId, is_deleted: 1 },
      { payload: "summary", activity_id: groupId, is_deleted: 0 },
      { payload: "summary", activity_id: priorGroupId, is_deleted: 1 },
    ]);
  }, 180_000);
});

function requireClickHouseUrl(): string {
  const url = process.env.CLICKHOUSE_URL?.trim();
  if (!url) throw new Error("CLICKHOUSE_URL is required for activity payload union tests");
  return url;
}

function requireClient(client: ClickHouseClient | undefined): ClickHouseClient {
  if (!client) throw new Error("ClickHouse client was not initialized");
  return client;
}

async function waitForClickHouse(client: ClickHouseClient): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await client.query({ query: "SELECT 1", format: "JSONEachRow" });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("ClickHouse did not become ready");
}

async function runStatements(
  client: ClickHouseClient,
  statements: readonly string[],
): Promise<void> {
  for (const statement of statements) await client.command({ query: statement });
}

async function seedFixture(
  client: ClickHouseClient,
  database: string,
  representativeId: string,
): Promise<void> {
  const representativeProvider =
    representativeId === pelotonId
      ? "peloton"
      : representativeId === whoopId
        ? "whoop"
        : "route-provider";
  const representativeName =
    representativeId === pelotonId
      ? "Peloton Ride"
      : representativeId === whoopId
        ? "WHOOP Activity"
        : "Recorded Route";
  await runStatements(client, [
    `DROP DATABASE IF EXISTS ${database} SYNC`,
    `CREATE DATABASE ${database}`,
    createSourceActivitySql(database),
    createDedupedActivitiesSql(database),
    createDedupedActivityMembersSql(database),
    createDedupedSensorSql(database),
    createMetricStreamSql(database),
    createActivitySensorSampleSql(database),
    createActivityLocationSampleSql(database),
    buildActivitySensorSummaryRowsTableSql().replaceAll("analytics.", `${database}.`),
    createActivityLocationSummarySql(database),
    buildActivitySummaryRowsTableSql().replaceAll("analytics.", `${database}.`),
    `INSERT INTO ${database}.source_activity VALUES
      ('${pelotonId}', '${groupId}', '${userId}', 'peloton', 'cardio', '', toDateTime64('2026-09-03 14:00:00', 6, 'UTC'), toDateTime64('2026-09-03 15:00:00', 6, 'UTC'), NULL, NULL, 0, toDateTime64('2026-09-03 16:00:00', 9, 'UTC')),
      ('${whoopId}', '${groupId}', '${userId}', 'whoop', 'cycling', 'commuting', toDateTime64('2026-09-03 14:00:00', 6, 'UTC'), toDateTime64('2026-09-03 15:00:00', 6, 'UTC'), NULL, NULL, 0, toDateTime64('2026-09-03 16:00:00', 9, 'UTC')),
      ('${routeId}', '${groupId}', '${userId}', 'route-provider', 'cycling', '', toDateTime64('2026-09-03 14:00:00', 6, 'UTC'), toDateTime64('2026-09-03 15:00:00', 6, 'UTC'), NULL, NULL, 0, toDateTime64('2026-09-03 16:00:00', 9, 'UTC'))`,
    `INSERT INTO ${database}.deduped_activities VALUES
      ('${groupId}', '${representativeProvider}', '${userId}', '${representativeId}', 'cycling', 'commuting', NULL, '${representativeName}', toDateTime64('2026-09-03 14:00:00', 6, 'UTC'), toDateTime64('2026-09-03 15:00:00', 6, 'UTC'), toDateTime64('2026-09-03 16:00:00', 9, 'UTC'), ['${pelotonId}', '${whoopId}', '${routeId}'], 1, 0, toDateTime64('2026-09-03 16:00:00', 9, 'UTC'))`,
    `INSERT INTO ${database}.deduped_activity_members VALUES
      ('${groupId}', '${userId}', toDateTime64('2026-09-03 14:00:00', 6, 'UTC'), toDateTime64('2026-09-03 15:00:00', 6, 'UTC'), toDateTime64('2026-09-03 16:00:00', 9, 'UTC'), '${pelotonId}', 1, 0, toDateTime64('2026-09-03 16:00:00', 9, 'UTC')),
      ('${groupId}', '${userId}', toDateTime64('2026-09-03 14:00:00', 6, 'UTC'), toDateTime64('2026-09-03 15:00:00', 6, 'UTC'), toDateTime64('2026-09-03 16:00:00', 9, 'UTC'), '${whoopId}', 1, 0, toDateTime64('2026-09-03 16:00:00', 9, 'UTC')),
      ('${groupId}', '${userId}', toDateTime64('2026-09-03 14:00:00', 6, 'UTC'), toDateTime64('2026-09-03 15:00:00', 6, 'UTC'), toDateTime64('2026-09-03 16:00:00', 9, 'UTC'), '${routeId}', 1, 0, toDateTime64('2026-09-03 16:00:00', 9, 'UTC'))`,
    `INSERT INTO ${database}.deduped_sensor VALUES
      ('${userId}', toDateTime64('2026-09-03 14:10:00', 9, 'UTC'), toDate('2026-09-03'), 'heart_rate', 100, '${whoopId}', 0, toDateTime64('2026-09-03 16:01:00', 9, 'UTC')),
      ('${userId}', toDateTime64('2026-09-03 14:20:00', 9, 'UTC'), toDate('2026-09-03'), 'heart_rate', 120, '${whoopId}', 0, toDateTime64('2026-09-03 16:01:00', 9, 'UTC')),
      ('${userId}', toDateTime64('2026-09-03 14:30:00', 9, 'UTC'), toDate('2026-09-03'), 'altitude', 10, '${routeId}', 0, toDateTime64('2026-09-03 16:01:00', 9, 'UTC')),
      ('${userId}', toDateTime64('2026-09-03 14:31:00', 9, 'UTC'), toDate('2026-09-03'), 'altitude', 20, '${routeId}', 0, toDateTime64('2026-09-03 16:01:00', 9, 'UTC')),
      ('${userId}', toDateTime64('2026-09-03 14:32:00', 9, 'UTC'), toDate('2026-09-03'), 'altitude', 15, '${routeId}', 0, toDateTime64('2026-09-03 16:01:00', 9, 'UTC')),
      ('${userId}', toDateTime64('2026-09-03 14:33:00', 9, 'UTC'), toDate('2026-09-03'), 'altitude', 15, '${routeId}', 0, toDateTime64('2026-09-03 16:01:00', 9, 'UTC'))`,
    `INSERT INTO ${database}.metric_stream_freshness VALUES
      (generateUUIDv4(), '${routeId}', '${userId}', toDateTime64('2026-09-03 14:10:00', 9, 'UTC'), 'route-provider', 'location', tuple(-122.28, 37.80), toDateTime64('2026-09-03 16:02:00', 9, 'UTC'), 1, 0),
      (generateUUIDv4(), '${routeId}', '${userId}', toDateTime64('2026-09-03 14:20:00', 9, 'UTC'), 'route-provider', 'location', tuple(-122.27, 37.81), toDateTime64('2026-09-03 16:02:00', 9, 'UTC'), 1, 0)`,
  ]);
}

async function buildHydration(client: ClickHouseClient, database: string): Promise<void> {
  await runStatements(client, [
    `INSERT INTO ${database}.activity_sensor_sample ${renderModel("activity_sensor_sample.sql", database, false)}`,
    `INSERT INTO ${database}.activity_location_sample ${renderModel("activity_location_sample.sql", database, false)}`,
    `INSERT INTO ${database}.activity_sensor_summary_rows ${renderModel("activity_sensor_summary_rows.sql", database, true)}`,
    `INSERT INTO ${database}.activity_location_summary_rows ${renderModel("activity_location_summary_rows.sql", database, true)}`,
    `INSERT INTO ${database}.activity_summary_rows ${renderModel("activity_summary_rows.sql", database, true)}`,
  ]);
}

function renderModel(
  file: string,
  database: string,
  incremental: boolean,
  scopedActivityIds?: readonly string[],
): string {
  return renderDbtModelSql(readModelSql(file), {
    isIncremental: incremental,
    activityRefreshScoped: scopedActivityIds != null,
  })
    .replaceAll("{{ initial_lookback_days }}", "365")
    .replaceAll('{{ var("activity_refresh_user_id") }}', userId)
    .replaceAll(
      "{{ activity_refresh_ids() }}",
      `CAST([${(scopedActivityIds ?? []).map((id) => `'${id}'`).join(", ")}], 'Array(UUID)')`,
    )
    .replaceAll("{{ this }}", `${database}.${file.replace(".sql", "")}`)
    .replace(/\{\{ ref\('([^']+)'\) \}\}/g, `${database}.$1`)
    .replace("{{ source('postgres_fitness', 'activity') }}", `${database}.source_activity`)
    .replace(
      "{{ source('ingest', 'metric_stream_freshness') }}",
      `${database}.metric_stream_freshness`,
    )
    .concat("\nSETTINGS join_use_nulls = 1, enable_materialized_cte = 1, max_threads = 1");
}

function createSourceActivitySql(database: string): string {
  return `CREATE TABLE ${database}.source_activity (
    id UUID, group_id UUID, user_id UUID, provider_id String, canonical_type String,
    provider_type String, started_at DateTime64(6, 'UTC'), ended_at Nullable(DateTime64(6, 'UTC')),
    provider_absent_at Nullable(DateTime64(6, 'UTC')), deleted_at Nullable(DateTime64(6, 'UTC')),
    _peerdb_is_deleted UInt8,
    _peerdb_synced_at DateTime64(9, 'UTC'))
    ENGINE = ReplacingMergeTree(_peerdb_synced_at) ORDER BY id`;
}

function createDedupedActivitiesSql(database: string): string {
  return `CREATE TABLE ${database}.deduped_activities (
    activity_id UUID, provider_id String, user_id UUID, primary_activity_id UUID,
    canonical_type String, provider_type String, modality Nullable(String), name Nullable(String),
    started_at DateTime64(6, 'UTC'), ended_at Nullable(DateTime64(6, 'UTC')),
    source_synced_at DateTime64(9, 'UTC'), member_activity_ids Array(UUID),
    refresh_version UInt64, is_deleted UInt8, refreshed_at DateTime64(9, 'UTC'))
    ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (user_id, activity_id)`;
}

function createDedupedActivityMembersSql(database: string): string {
  return `CREATE TABLE ${database}.deduped_activity_members (
    activity_id UUID, user_id UUID, started_at DateTime64(6, 'UTC'),
    ended_at Nullable(DateTime64(6, 'UTC')), source_synced_at DateTime64(9, 'UTC'),
    member_activity_id UUID, refresh_version UInt64, is_deleted UInt8,
    refreshed_at DateTime64(9, 'UTC'))
    ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (user_id, member_activity_id)`;
}

function createDedupedSensorSql(database: string): string {
  return `CREATE TABLE ${database}.deduped_sensor (
    user_id UUID, recorded_at DateTime64(9, 'UTC'), recorded_date Date, channel String,
    scalar Nullable(Float64), source_activity_id Nullable(UUID), is_deleted UInt8,
    refreshed_at DateTime64(9, 'UTC')) ENGINE = MergeTree
    ORDER BY (user_id, recorded_date, channel, recorded_at)`;
}

function createMetricStreamSql(database: string): string {
  return `CREATE TABLE ${database}.metric_stream_freshness (
    id UUID, activity_id Nullable(UUID), user_id UUID, recorded_at DateTime64(9, 'UTC'),
    provider_id String, channel String, point Point, ingested_at DateTime64(9, 'UTC'),
    version UInt64, is_deleted UInt8) ENGINE = MergeTree ORDER BY id`;
}

function createActivitySensorSampleSql(database: string): string {
  return `CREATE TABLE ${database}.activity_sensor_sample (
    activity_id UUID, user_id UUID, recorded_at DateTime64(9, 'UTC'), recorded_date Date,
    channel String, scalar Nullable(Float64), refresh_version UInt64, is_deleted UInt8,
    refreshed_at DateTime64(9, 'UTC')) ENGINE = ReplacingMergeTree(refresh_version)
    ORDER BY (user_id, activity_id, recorded_date, channel, recorded_at)`;
}

function createActivityLocationSampleSql(database: string): string {
  return `CREATE TABLE ${database}.activity_location_sample (
    activity_id UUID, user_id UUID, recorded_at DateTime64(9, 'UTC'), recorded_date Date,
    source_metric_stream_id UUID, lat Nullable(Float32), lng Nullable(Float32),
    refresh_version UInt64, is_deleted UInt8, source_refreshed_at DateTime64(9, 'UTC'),
    refreshed_at DateTime64(9, 'UTC')) ENGINE = ReplacingMergeTree(refresh_version)
    ORDER BY (user_id, activity_id, recorded_date, recorded_at, source_metric_stream_id)`;
}

function createActivityLocationSummarySql(database: string): string {
  return `CREATE TABLE ${database}.activity_location_summary_rows (
    activity_id UUID, user_id UUID, total_distance Nullable(Float64),
    centroid_lat Nullable(Float64), centroid_lng Nullable(Float64), refresh_version UInt64,
    is_deleted UInt8, refreshed_at DateTime64(9, 'UTC'))
    ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (user_id, activity_id)`;
}
