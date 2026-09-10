import { randomBytes } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildActivitySensorSummaryRowsTableSql } from "./clickhouse-activity-sensor-summary.ts";
import { buildActivitySummaryRowsTableSql } from "./clickhouse-activity-summary.ts";
import { buildPostgresFitnessActivityRawTableStatement } from "./clickhouse-raw-tables.ts";
import { readModelSql, renderDbtModelSql } from "./read-model-sql-test-helpers.ts";

type ClickHouseClient = ReturnType<typeof createClient>;

const userId = "00000000-0000-0000-0000-000000000001";
const groupId = "00000000-0000-0000-0000-000000000100";
const pelotonId = "00000000-0000-0000-0000-000000000101";
const whoopId = "00000000-0000-0000-0000-000000000102";
const routeId = "00000000-0000-0000-0000-000000000103";
const priorGroupId = "00000000-0000-0000-0000-000000000104";
const movedGroupId = "00000000-0000-0000-0000-000000000105";
const providerAPointIds = [
  "00000000-0000-0000-0000-000000000201",
  "00000000-0000-0000-0000-000000000202",
] as const;
const providerBPointIds = [
  "00000000-0000-0000-0000-000000000203",
  "00000000-0000-0000-0000-000000000204",
  "00000000-0000-0000-0000-000000000205",
] as const;
const representatives = [routeId, whoopId, pelotonId] as const;

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
      const expectedCanonicalType = representativeId === pelotonId ? "cardio" : "cycling";
      expect(summary).toMatchObject({
        activity_id: groupId,
        canonical_type: expectedCanonicalType,
        provider_type: "commuting",
        avg_hr: 110,
        elevation_gain_m: 10,
        elevation_loss_m: 5,
        sample_count: 7,
        is_deleted: 0,
      });
      expect(summary.total_distance).toBeGreaterThan(100);
      expect(summary.centroid_lat).toBeCloseTo(37.805, 3);
      expect(summary.centroid_lng).toBeCloseTo(-122.275, 3);

      const representativeResult = await activeClient.query({
        query: `SELECT toString(primary_activity_id) AS primary_activity_id
          FROM ${database}.deduped_activities FINAL
          WHERE activity_id = toUUID('${groupId}') AND is_deleted = 0`,
        format: "JSONEachRow",
      });
      expect(await representativeResult.json()).toEqual([
        { primary_activity_id: representativeId },
      ]);

      const payloadSummary = { ...summary, canonical_type: "representative-owned" };
      populatedFieldSets.push(
        Object.entries(payloadSummary)
          .filter(([, value]) => value !== null)
          .map(([field]) => field)
          .sort(),
      );
      payloadSnapshots.push(JSON.stringify(payloadSummary));
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
      `INSERT INTO ${database}.deduped_activities
        (activity_id, provider_id, user_id, primary_activity_id, canonical_type, provider_type,
         modality, name, started_at, ended_at, source_synced_at, member_activity_ids,
         refresh_version, is_deleted, refreshed_at)
        VALUES
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

  it("tombstones prior group sensor sample keys when a member moves", async () => {
    const activeClient = requireClient(client);
    await seedFixture(activeClient, database, routeId);
    await activeClient.command({
      query: `INSERT INTO ${database}.activity_sensor_sample ${renderModel("activity_sensor_sample.sql", database, false)}`,
    });
    await runStatements(activeClient, [
      `INSERT INTO ${database}.deduped_activities
        (activity_id, provider_id, user_id, primary_activity_id, canonical_type, provider_type,
         modality, name, started_at, ended_at, source_synced_at, member_activity_ids,
         refresh_version, is_deleted, refreshed_at)
        VALUES
        ('${groupId}', 'route-provider', '${userId}', '${routeId}', 'cycling', '', NULL,
         'Recorded Route', toDateTime64('2026-09-03 14:00:00', 6, 'UTC'),
         toDateTime64('2026-09-03 15:00:00', 6, 'UTC'),
         toDateTime64('2026-09-03 17:00:00', 9, 'UTC'), ['${pelotonId}', '${routeId}'], 9000000000000000000, 0,
         toDateTime64('2026-09-03 17:00:00', 9, 'UTC')),
        ('${movedGroupId}', 'whoop', '${userId}', '${whoopId}', 'cycling', 'commuting', NULL,
         'WHOOP Activity', toDateTime64('2026-09-03 14:00:00', 6, 'UTC'),
         toDateTime64('2026-09-03 15:00:00', 6, 'UTC'),
         toDateTime64('2026-09-03 17:00:00', 9, 'UTC'), ['${whoopId}'], 9000000000000000000, 0,
         toDateTime64('2026-09-03 17:00:00', 9, 'UTC'))`,
      `INSERT INTO ${database}.activity_sensor_sample ${renderModel("activity_sensor_sample.sql", database, true, [groupId, whoopId])}`,
    ]);

    const result = await activeClient.query({
      query: `SELECT toString(sensor.activity_id) AS activity_id, is_deleted, count() AS row_count
        FROM ${database}.activity_sensor_sample AS sensor FINAL
        WHERE sensor.activity_id IN (toUUID('${groupId}'), toUUID('${movedGroupId}'))
        GROUP BY activity_id, is_deleted
        ORDER BY activity_id`,
      format: "JSONEachRow",
    });

    expect(
      z
        .array(
          z.object({
            activity_id: z.string(),
            is_deleted: z.coerce.number(),
            row_count: z.coerce.number(),
          }),
        )
        .parse(await result.json<unknown>()),
    ).toEqual([
      { activity_id: groupId, is_deleted: 0, row_count: 5 },
      { activity_id: groupId, is_deleted: 1, row_count: 2 },
      { activity_id: movedGroupId, is_deleted: 0, row_count: 3 },
    ]);
  }, 180_000);

  it("tombstones a retired GPS provider track when a better source appears", async () => {
    const activeClient = requireClient(client);
    await seedFixture(activeClient, database, routeId);
    await runStatements(activeClient, [
      `TRUNCATE TABLE ${database}.metric_stream_freshness`,
      `INSERT INTO ${database}.metric_stream_freshness
        (id, activity_id, user_id, recorded_at, provider_id, channel, point,
         ingested_at, version, is_deleted) VALUES
        ('${providerAPointIds[0]}', '${routeId}', '${userId}', toDateTime64('2026-09-03 14:10:00', 9, 'UTC'), 'provider-a', 'location', tuple(-122.50, 37.70), toDateTime64('2026-09-03 16:02:00', 9, 'UTC'), 1, 0),
        ('${providerAPointIds[1]}', '${routeId}', '${userId}', toDateTime64('2026-09-03 14:20:00', 9, 'UTC'), 'provider-a', 'location', tuple(-122.40, 37.80), toDateTime64('2026-09-03 16:02:00', 9, 'UTC'), 1, 0)`,
      `INSERT INTO ${database}.activity_location_sample ${renderModel("activity_location_sample.sql", database, false)}`,
      `INSERT INTO ${database}.metric_stream_freshness
        (id, activity_id, user_id, recorded_at, provider_id, channel, point,
         ingested_at, version, is_deleted) VALUES
        ('${providerBPointIds[0]}', '${routeId}', '${userId}', toDateTime64('2026-09-03 14:10:00', 9, 'UTC'), 'provider-b', 'location', tuple(-122.301, 37.901), toDateTime64('2026-09-03 17:02:00', 9, 'UTC'), 1, 0),
        ('${providerBPointIds[1]}', '${routeId}', '${userId}', toDateTime64('2026-09-03 14:20:00', 9, 'UTC'), 'provider-b', 'location', tuple(-122.300, 37.900), toDateTime64('2026-09-03 17:02:00', 9, 'UTC'), 1, 0),
        ('${providerBPointIds[2]}', '${routeId}', '${userId}', toDateTime64('2026-09-03 14:30:00', 9, 'UTC'), 'provider-b', 'location', tuple(-122.299, 37.899), toDateTime64('2026-09-03 17:02:00', 9, 'UTC'), 1, 0)`,
      `INSERT INTO ${database}.activity_location_sample ${renderModel("activity_location_sample.sql", database, true, [groupId])}`,
      `INSERT INTO ${database}.activity_location_summary_rows ${renderModel("activity_location_summary_rows.sql", database, true, [groupId])}`,
    ]);

    const pointResult = await activeClient.query({
      query: `SELECT toString(source_metric_stream_id) AS source_metric_stream_id, is_deleted
        FROM ${database}.activity_location_sample FINAL
        ORDER BY source_metric_stream_id`,
      format: "JSONEachRow",
    });
    expect(
      z
        .array(
          z.object({
            source_metric_stream_id: z.string(),
            is_deleted: z.coerce.number(),
          }),
        )
        .parse(await pointResult.json<unknown>()),
    ).toEqual([
      ...providerAPointIds.map((source_metric_stream_id) => ({
        source_metric_stream_id,
        is_deleted: 1,
      })),
      ...providerBPointIds.map((source_metric_stream_id) => ({
        source_metric_stream_id,
        is_deleted: 0,
      })),
    ]);

    const summaryResult = await activeClient.query({
      query: `SELECT total_distance, centroid_lat, centroid_lng
        FROM ${database}.activity_location_summary_rows FINAL
        WHERE activity_id = toUUID('${groupId}') AND is_deleted = 0`,
      format: "JSONEachRow",
    });
    expect(
      z
        .tuple([
          z.object({
            total_distance: z.coerce.number(),
            centroid_lat: z.coerce.number(),
            centroid_lng: z.coerce.number(),
          }),
        ])
        .parse(await summaryResult.json<unknown>())[0],
    ).toMatchObject({
      centroid_lat: expect.closeTo(37.9, 3),
      centroid_lng: expect.closeTo(-122.3, 3),
      total_distance: expect.closeTo(283, -1),
    });
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
  const heartRateOwner = representativeId === routeId ? whoopId : representativeId;
  const altitudeOwner = representativeId;
  await runStatements(client, [
    `DROP DATABASE IF EXISTS ${database} SYNC`,
    `CREATE DATABASE ${database}`,
    createSourceActivitySql(database),
    createProviderPrioritySql(database),
    createDevicePrioritySql(database),
    createActivitySourceRecordsSql(database),
    createDedupedActivitiesSql(database),
    createDedupedActivityMembersSql(database),
    createDedupedSensorSql(database),
    createMetricStreamSql(database),
    createActivitySensorSampleSql(database),
    createActivityLocationSampleSql(database),
    buildActivitySensorSummaryRowsTableSql().replaceAll("analytics.", `${database}.`),
    createActivityLocationSummarySql(database),
    buildActivitySummaryRowsTableSql().replaceAll("analytics.", `${database}.`),
    `INSERT INTO ${database}.source_activity
      (id, group_id, provider_id, user_id, external_id, canonical_type, provider_type,
       started_at, ended_at, name, source_name, created_at, _peerdb_is_deleted,
       _peerdb_version, _peerdb_synced_at)
      VALUES
      ('${pelotonId}', '${groupId}', 'peloton', '${userId}', 'peloton-commute', 'cardio', '',
       toDateTime64('2026-09-03 14:00:00', 6, 'UTC'), toDateTime64('2026-09-03 15:00:00', 6, 'UTC'),
       'Peloton Ride', 'Peloton', toDateTime64('2026-09-03 16:00:00', 6, 'UTC'), 0, 1,
       toDateTime64('2026-09-03 16:00:00', 9, 'UTC')),
      ('${whoopId}', '${groupId}', 'whoop', '${userId}', 'whoop-commute', 'cycling', ' commuting ',
       toDateTime64('2026-09-03 14:00:00', 6, 'UTC'), toDateTime64('2026-09-03 15:00:00', 6, 'UTC'),
       'Bike Commute', 'WHOOP', toDateTime64('2026-09-03 16:00:00', 6, 'UTC'), 0, 1,
       toDateTime64('2026-09-03 16:00:00', 9, 'UTC')),
      ('${routeId}', '${groupId}', 'route-provider', '${userId}', 'route-commute', 'cycling', '',
       toDateTime64('2026-09-03 14:00:00', 6, 'UTC'), toDateTime64('2026-09-03 15:00:00', 6, 'UTC'),
       'Recorded Route', 'Route Provider', toDateTime64('2026-09-03 16:00:00', 6, 'UTC'), 0, 1,
       toDateTime64('2026-09-03 16:00:00', 9, 'UTC'))`,
    `INSERT INTO ${database}.provider_priority VALUES
      ('peloton', 1, 0, 1), ('whoop', 20, 0, 1), ('route-provider', 50, 0, 1)`,
    `INSERT INTO ${database}.deduped_activity_members VALUES
      ('${groupId}', '${userId}', toDateTime64('2026-09-03 14:00:00', 6, 'UTC'), toDateTime64('2026-09-03 15:00:00', 6, 'UTC'), toDateTime64('2026-09-03 16:00:00', 9, 'UTC'), '${pelotonId}', 1, 0, toDateTime64('2026-09-03 16:00:00', 9, 'UTC')),
      ('${groupId}', '${userId}', toDateTime64('2026-09-03 14:00:00', 6, 'UTC'), toDateTime64('2026-09-03 15:00:00', 6, 'UTC'), toDateTime64('2026-09-03 16:00:00', 9, 'UTC'), '${whoopId}', 1, 0, toDateTime64('2026-09-03 16:00:00', 9, 'UTC')),
      ('${groupId}', '${userId}', toDateTime64('2026-09-03 14:00:00', 6, 'UTC'), toDateTime64('2026-09-03 15:00:00', 6, 'UTC'), toDateTime64('2026-09-03 16:00:00', 9, 'UTC'), '${routeId}', 1, 0, toDateTime64('2026-09-03 16:00:00', 9, 'UTC'))`,
    `INSERT INTO ${database}.deduped_sensor
      (user_id, recorded_at, recorded_date, channel, scalar, source_activity_id,
       is_deleted, refreshed_at) VALUES
      ('${userId}', toDateTime64('2026-09-03 14:10:00', 9, 'UTC'), toDate('2026-09-03'), 'heart_rate', 100, '${heartRateOwner}', 0, toDateTime64('2026-09-03 16:01:00', 9, 'UTC')),
      ('${userId}', toDateTime64('2026-09-03 14:20:00', 9, 'UTC'), toDate('2026-09-03'), 'heart_rate', 120, '${heartRateOwner}', 0, toDateTime64('2026-09-03 16:01:00', 9, 'UTC')),
      ('${userId}', toDateTime64('2026-09-03 14:30:00', 9, 'UTC'), toDate('2026-09-03'), 'altitude', 10, '${altitudeOwner}', 0, toDateTime64('2026-09-03 16:01:00', 9, 'UTC')),
      ('${userId}', toDateTime64('2026-09-03 14:31:00', 9, 'UTC'), toDate('2026-09-03'), 'altitude', 20, '${altitudeOwner}', 0, toDateTime64('2026-09-03 16:01:00', 9, 'UTC')),
      ('${userId}', toDateTime64('2026-09-03 14:32:00', 9, 'UTC'), toDate('2026-09-03'), 'altitude', 15, '${altitudeOwner}', 0, toDateTime64('2026-09-03 16:01:00', 9, 'UTC')),
      ('${userId}', toDateTime64('2026-09-03 14:33:00', 9, 'UTC'), toDate('2026-09-03'), 'altitude', 15, '${altitudeOwner}', 0, toDateTime64('2026-09-03 16:01:00', 9, 'UTC')),
      ('${userId}', toDateTime64('2026-09-03 14:40:00', 9, 'UTC'), toDate('2026-09-03'), 'heart_rate', 110, NULL, 0, toDateTime64('2026-09-03 16:01:00', 9, 'UTC'))`,
    `INSERT INTO ${database}.metric_stream_freshness
      (id, activity_id, user_id, recorded_at, provider_id, channel, point,
       ingested_at, version, is_deleted) VALUES
      (generateUUIDv4(), '${routeId}', '${userId}', toDateTime64('2026-09-03 14:10:00', 9, 'UTC'), 'route-provider', 'location', tuple(-122.28, 37.80), toDateTime64('2026-09-03 16:02:00', 9, 'UTC'), 1, 0),
      (generateUUIDv4(), '${routeId}', '${userId}', toDateTime64('2026-09-03 14:20:00', 9, 'UTC'), 'route-provider', 'location', tuple(-122.27, 37.81), toDateTime64('2026-09-03 16:02:00', 9, 'UTC'), 1, 0)`,
    `INSERT INTO ${database}.activity_source_records ${renderModel("activity_source_records.sql", database, false)}`,
    `INSERT INTO ${database}.deduped_activities ${renderModel("deduped_activities.sql", database, false)}`,
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
    .replaceAll("{{ source('postgres_fitness', 'activity') }}", `${database}.source_activity`)
    .replaceAll(
      "{{ source('postgres_fitness', 'provider_priority') }}",
      `${database}.provider_priority`,
    )
    .replaceAll(
      "{{ source('postgres_fitness', 'device_priority') }}",
      `${database}.device_priority`,
    )
    .replaceAll("{{ activity_source_mass_tombstone_min_existing }}", "10")
    .replaceAll("{{ activity_source_mass_tombstone_ratio }}", "0.95")
    .replaceAll(
      "{{ source('ingest', 'metric_stream_freshness') }}",
      `${database}.metric_stream_freshness`,
    )
    .concat("\nSETTINGS join_use_nulls = 1, enable_materialized_cte = 1, max_threads = 1");
}

function createSourceActivitySql(database: string): string {
  return buildPostgresFitnessActivityRawTableStatement({
    tableName: `${database}.source_activity`,
    ifNotExists: false,
  });
}

function createDedupedActivitiesSql(database: string): string {
  return `CREATE TABLE ${database}.deduped_activities (
    activity_id UUID, provider_id String, user_id UUID, primary_activity_id UUID,
    canonical_type String, provider_type String, modality Nullable(String),
    started_at DateTime64(6, 'UTC'), ended_at Nullable(DateTime64(6, 'UTC')),
    source_name Nullable(String), name Nullable(String), notes Nullable(String), timezone Nullable(String),
    start_utc_offset_minutes Nullable(Int16), end_utc_offset_minutes Nullable(Int16),
    local_time_source LowCardinality(String), raw Nullable(String),
    source_synced_at DateTime64(9, 'UTC'), source_providers Array(String),
    source_external_ids Array(Map(String, String)),
    absent_source_external_ids Array(Map(String, String)), member_activity_ids Array(UUID),
    refresh_version UInt64, is_deleted UInt8, refreshed_at DateTime64(9, 'UTC'))
    ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (user_id, activity_id)`;
}

function createActivitySourceRecordsSql(database: string): string {
  return `CREATE TABLE ${database}.activity_source_records (
    activity_id UUID, group_id Nullable(UUID), provider_id Nullable(String), user_id Nullable(UUID),
    external_id Nullable(String), canonical_type Nullable(String), provider_type Nullable(String),
    modality Nullable(String), started_at Nullable(DateTime64(6, 'UTC')),
    ended_at Nullable(DateTime64(6, 'UTC')), source_name Nullable(String), name Nullable(String),
    notes Nullable(String), timezone Nullable(String), start_utc_offset_minutes Nullable(Int16),
    end_utc_offset_minutes Nullable(Int16), local_time_source LowCardinality(String),
    raw Nullable(String), source_synced_at Nullable(DateTime64(9, 'UTC')), priority Nullable(Int32),
    refresh_version UInt64, is_deleted UInt8, refreshed_at DateTime64(9, 'UTC'))
    ENGINE = ReplacingMergeTree(refresh_version) ORDER BY activity_id`;
}

function createProviderPrioritySql(database: string): string {
  return `CREATE TABLE ${database}.provider_priority (
    provider_id String, priority Int32, _peerdb_is_deleted Int8, _peerdb_version Int64)
    ENGINE = ReplacingMergeTree(_peerdb_version) ORDER BY provider_id`;
}

function createDevicePrioritySql(database: string): string {
  return `CREATE TABLE ${database}.device_priority (
    provider_id String, source_name_pattern String, priority Nullable(Int32),
    _peerdb_is_deleted Int8, _peerdb_version Int64)
    ENGINE = ReplacingMergeTree(_peerdb_version) ORDER BY (provider_id, source_name_pattern)`;
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
    scalar Nullable(Float64), provider_id Nullable(String), member_activity_id Nullable(UUID),
    device_id Nullable(String), source_external_id Nullable(String), source_type Nullable(String),
    measurement_kind LowCardinality(String), source_metric_stream_id Nullable(UUID),
    source_activity_id Nullable(UUID), provider_priority Int32, is_deleted UInt8,
    refreshed_at DateTime64(9, 'UTC')) ENGINE = ReplacingMergeTree
    ORDER BY (user_id, recorded_date, channel, recorded_at)`;
}

function createMetricStreamSql(database: string): string {
  return `CREATE TABLE ${database}.metric_stream_freshness (
    id UUID, activity_id Nullable(UUID), user_id UUID, recorded_at DateTime64(9, 'UTC'),
    provider_id String, channel String, point Point, external_id Nullable(String),
    device_id Nullable(String), source_type Nullable(String), metadata String,
    ingested_at DateTime64(9, 'UTC'),
    version UInt64, is_deleted UInt8) ENGINE = MergeTree ORDER BY id`;
}

function createActivitySensorSampleSql(database: string): string {
  return `CREATE TABLE ${database}.activity_sensor_sample (
    activity_id UUID, user_id UUID, recorded_at DateTime64(9, 'UTC'), recorded_date Date,
    channel String, scalar Nullable(Float64), provider_id Nullable(String),
    member_activity_id Nullable(UUID), device_id Nullable(String),
    source_external_id Nullable(String), source_type Nullable(String),
    source_metric_stream_id Nullable(UUID), measurement_kind LowCardinality(String),
    refresh_version UInt64, is_deleted UInt8,
    refreshed_at DateTime64(9, 'UTC')) ENGINE = ReplacingMergeTree(refresh_version)
    ORDER BY (user_id, activity_id, recorded_date, channel, recorded_at)`;
}

function createActivityLocationSampleSql(database: string): string {
  return `CREATE TABLE ${database}.activity_location_sample (
    activity_id UUID, user_id UUID, recorded_at DateTime64(9, 'UTC'), recorded_date Date,
    source_metric_stream_id UUID, member_activity_id Nullable(UUID),
    provider_id Nullable(String), source_external_id Nullable(String),
    device_id Nullable(String), source_type Nullable(String),
    measurement_kind LowCardinality(String), lat Nullable(Float32), lng Nullable(Float32),
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
