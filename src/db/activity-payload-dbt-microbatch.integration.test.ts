import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";

type ClickHouseClient = ReturnType<typeof createClient>;

const userId = "00000000-0000-0000-0000-000000001001";
const oldGroupId = "00000000-0000-0000-0000-000000001010";
const newGroupId = "00000000-0000-0000-0000-000000001011";
const unrelatedGroupId = "00000000-0000-0000-0000-000000001012";
const movedMemberId = "00000000-0000-0000-0000-000000001020";
const retainedMemberId = "00000000-0000-0000-0000-000000001021";
const unrelatedMemberId = "00000000-0000-0000-0000-000000001022";
const routeGroupId = "00000000-0000-0000-0000-000000001030";
const unrelatedRouteGroupId = "00000000-0000-0000-0000-000000001031";
const routeMemberId = "00000000-0000-0000-0000-000000001032";
const unrelatedRouteMemberId = "00000000-0000-0000-0000-000000001033";
const movedRouteGroupId = "00000000-0000-0000-0000-000000001034";
const retainedRouteMemberId = "00000000-0000-0000-0000-000000001035";
const tombstoneOnlyGroupId = "00000000-0000-0000-0000-000000001036";
const tombstoneOnlyMemberId = "00000000-0000-0000-0000-000000001037";
const providerAPointIds = [
  "00000000-0000-0000-0000-000000001040",
  "00000000-0000-0000-0000-000000001041",
  "00000000-0000-0000-0000-000000001042",
] as const;
const providerBPointIds = [
  "00000000-0000-0000-0000-000000001043",
  "00000000-0000-0000-0000-000000001044",
  "00000000-0000-0000-0000-000000001045",
  "00000000-0000-0000-0000-000000001046",
] as const;
const unrelatedPointId = "00000000-0000-0000-0000-000000001047";

const sampleRowSchema = z.object({
  activity_id: z.string(),
  scalar: z.coerce.number(),
  is_deleted: z.coerce.number(),
});

const sensorSummarySchema = z.object({
  activity_id: z.string(),
  avg_hr: z.coerce.number().nullable(),
  sample_count: z.coerce.number(),
  is_deleted: z.coerce.number(),
});

describe("activity payload dbt batch reconciliation", () => {
  let client: ClickHouseClient;
  let artifactDirectory: string;
  const database = `activity_payload_batch_${randomBytes(6).toString("hex")}`;

  beforeAll(async () => {
    const clickHouseUrl = process.env.CLICKHOUSE_URL?.trim();
    if (!clickHouseUrl) {
      throw new Error("CLICKHOUSE_URL is required for activity payload integration tests");
    }
    client = createClient({ url: clickHouseUrl, request_timeout: 120_000 });
    await client.query({ query: "SELECT 1", format: "JSONEachRow" });
    artifactDirectory = await mkdtemp(join(tmpdir(), "activity-payload-dbt-"));
  }, 120_000);

  afterAll(async () => {
    if (client) {
      await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
      await client.close();
    }
    if (artifactDirectory) {
      await rm(artifactDirectory, { recursive: true, force: true });
    }
  });

  it("reconciles only replayed sensor keys across dbt microbatches and group moves", async () => {
    await seedSensorFixture(client, database);

    await runDbtBatch(
      database,
      artifactDirectory,
      ["activity_sensor_sample", "activity_sensor_summary_rows"],
      "2026-09-04",
      "2026-09-05",
    );
    await expectSensorState(
      client,
      database,
      [{ activity_id: oldGroupId, scalar: 100, is_deleted: 0 }],
      [
        { activity_id: oldGroupId, avg_hr: 100, sample_count: 1, is_deleted: 0 },
        { activity_id: unrelatedGroupId, avg_hr: null, sample_count: 0, is_deleted: 1 },
      ],
    );

    await runDbtBatch(
      database,
      artifactDirectory,
      ["activity_sensor_sample", "activity_sensor_summary_rows"],
      "2026-09-05",
      "2026-09-06",
    );
    await expectSensorState(
      client,
      database,
      [
        { activity_id: oldGroupId, scalar: 100, is_deleted: 0 },
        { activity_id: unrelatedGroupId, scalar: 120, is_deleted: 0 },
      ],
      [
        { activity_id: oldGroupId, avg_hr: 100, sample_count: 1, is_deleted: 0 },
        { activity_id: unrelatedGroupId, avg_hr: 120, sample_count: 1, is_deleted: 0 },
      ],
    );

    await moveMemberAndReplaySensor(client, database);
    await runDbtBatch(
      database,
      artifactDirectory,
      ["activity_sensor_sample", "activity_sensor_summary_rows"],
      "2026-09-06",
      "2026-09-07",
    );
    await expectSensorState(
      client,
      database,
      [
        { activity_id: oldGroupId, scalar: 100, is_deleted: 1 },
        { activity_id: newGroupId, scalar: 100, is_deleted: 0 },
        { activity_id: unrelatedGroupId, scalar: 120, is_deleted: 0 },
      ],
      [
        { activity_id: oldGroupId, avg_hr: null, sample_count: 0, is_deleted: 1 },
        { activity_id: newGroupId, avg_hr: 100, sample_count: 1, is_deleted: 0 },
        { activity_id: unrelatedGroupId, avg_hr: 120, sample_count: 1, is_deleted: 0 },
      ],
    );

    const compiledSql = await readFile(
      join(
        artifactDirectory,
        "run",
        "dofek_analytics",
        "models",
        "read_models",
        "activity_sensor_sample",
        "activity_sensor_sample_2026-09-06.sql",
      ),
      "utf8",
    );
    expect(compiledSql).toContain("where refreshed_at >= '2026-09-06 00:00:00'");
    expect(compiledSql).toContain("and refreshed_at < '2026-09-07 00:00:00'");
    expect(compiledSql).toContain("INNER JOIN batch_sample_keys");
  }, 240_000);

  it("preserves unrelated routes, switches providers, and remaps routes across groups", async () => {
    await seedLocationFixture(client, database);

    await insertLocationPoints(client, database, [
      [
        providerAPointIds[0],
        "provider-a",
        -122.3,
        37.8,
        "2026-09-03 10:10:00",
        "2026-09-03 12:00:00",
      ],
      [
        providerAPointIds[1],
        "provider-a",
        -122.29,
        37.81,
        "2026-09-03 10:20:00",
        "2026-09-03 12:00:00",
      ],
      [
        providerAPointIds[2],
        "provider-a",
        -122.28,
        37.82,
        "2026-09-03 10:30:00",
        "2026-09-03 12:00:00",
      ],
    ]);
    await runDbtBatch(
      database,
      artifactDirectory,
      ["activity_location_sample", "activity_location_summary_rows", "activity_stream_points"],
      "2026-09-03",
      "2026-09-04",
    );
    await expectActiveLocationPointIds(client, database, routeGroupId, providerAPointIds);
    await expectLocationCentroid(client, database, routeGroupId, 37.81, -122.29);

    await insertLocationPoints(client, database, [
      [
        unrelatedPointId,
        "provider-z",
        -121.9,
        37.4,
        "2026-09-04 10:10:00",
        "2026-09-04 12:00:00",
        unrelatedRouteMemberId,
      ],
    ]);
    await runDbtBatch(
      database,
      artifactDirectory,
      ["activity_location_sample", "activity_location_summary_rows"],
      "2026-09-04",
      "2026-09-05",
    );
    await expectActiveLocationPointIds(client, database, routeGroupId, providerAPointIds);
    await expectLocationCentroid(client, database, routeGroupId, 37.81, -122.29);

    await insertLocationPoints(client, database, [
      [
        providerBPointIds[0],
        "provider-b",
        -122.1,
        37.9,
        "2026-09-03 10:10:00",
        "2026-09-05 12:00:00",
      ],
      [
        providerBPointIds[1],
        "provider-b",
        -122.09,
        37.91,
        "2026-09-03 10:20:00",
        "2026-09-05 12:00:00",
      ],
    ]);
    await runDbtBatch(
      database,
      artifactDirectory,
      ["activity_location_sample", "activity_location_summary_rows"],
      "2026-09-05",
      "2026-09-06",
    );
    await expectActiveLocationPointIds(client, database, routeGroupId, providerAPointIds);
    await expectLocationCentroid(client, database, routeGroupId, 37.81, -122.29);

    await insertLocationPoints(client, database, [
      [
        providerBPointIds[2],
        "provider-b",
        -122.08,
        37.92,
        "2026-09-03 10:30:00",
        "2026-09-06 12:00:00",
      ],
      [
        providerBPointIds[3],
        "provider-b",
        -122.07,
        37.93,
        "2026-09-03 10:40:00",
        "2026-09-06 12:00:00",
      ],
    ]);
    await runDbtBatch(
      database,
      artifactDirectory,
      ["activity_location_sample", "activity_location_summary_rows", "activity_stream_points"],
      "2026-09-06",
      "2026-09-07",
    );

    const pointResult = await client.query({
      query: `SELECT toString(source_metric_stream_id) AS source_metric_stream_id, is_deleted
        FROM ${database}.activity_location_sample FINAL
        WHERE activity_id = toUUID('${routeGroupId}')
        ORDER BY source_metric_stream_id`,
      format: "JSONEachRow",
    });
    expect(await pointResult.json()).toEqual([
      ...providerAPointIds.map((source_metric_stream_id) => ({
        source_metric_stream_id,
        is_deleted: 1,
      })),
      ...providerBPointIds.map((source_metric_stream_id) => ({
        source_metric_stream_id,
        is_deleted: 0,
      })),
    ]);
    await expectLocationCentroid(client, database, routeGroupId, 37.915, -122.085);
    const unchangedStreamVersion = await getLocationStreamVersion(
      client,
      database,
      unrelatedRouteGroupId,
    );

    await moveRouteMember(client, database);
    await runDbtBatch(
      database,
      artifactDirectory,
      ["activity_location_sample", "activity_location_summary_rows"],
      "2026-09-07",
      "2026-09-08",
    );

    const movedPointResult = await client.query({
      query: `SELECT toString(activity_id) AS activity_id,
          toString(source_metric_stream_id) AS source_metric_stream_id,
          is_deleted
        FROM ${database}.activity_location_sample FINAL
        WHERE toString(source_metric_stream_id) IN (${providerBPointIds
          .map((id) => `'${id}'`)
          .join(",")})
        ORDER BY activity_id, source_metric_stream_id`,
      format: "JSONEachRow",
    });
    expect(await movedPointResult.json()).toEqual([
      ...providerBPointIds.map((source_metric_stream_id) => ({
        activity_id: routeGroupId,
        source_metric_stream_id,
        is_deleted: 1,
      })),
      ...providerBPointIds.map((source_metric_stream_id) => ({
        activity_id: movedRouteGroupId,
        source_metric_stream_id,
        is_deleted: 0,
      })),
    ]);
    const pairedRefreshResult = await client.query({
      query: `SELECT toString(source_metric_stream_id) AS source_metric_stream_id,
          toUInt32(count()) AS mapping_count,
          toUInt32(uniqExact(refresh_version)) AS refresh_clock_count
        FROM ${database}.activity_location_sample FINAL
        WHERE toString(source_metric_stream_id) IN (${providerBPointIds
          .map((id) => `'${id}'`)
          .join(",")})
        GROUP BY source_metric_stream_id
        ORDER BY source_metric_stream_id`,
      format: "JSONEachRow",
    });
    expect(await pairedRefreshResult.json()).toEqual(
      providerBPointIds.map((source_metric_stream_id) => ({
        source_metric_stream_id,
        mapping_count: 2,
        refresh_clock_count: 1,
      })),
    );
    await expectHistoricalLocationMappingsNewerThanStream(client, database);
    await expectActiveLocationPointIds(client, database, routeGroupId, []);
    await expectActiveLocationPointIds(client, database, movedRouteGroupId, providerBPointIds);
    await expectNoActiveLocationSummary(client, database, routeGroupId);
    await expectLocationCentroid(client, database, movedRouteGroupId, 37.915, -122.085);

    await runDbtBatch(
      database,
      artifactDirectory,
      ["activity_stream_points"],
      "2026-09-07",
      "2026-09-08",
    );
    await expectLocationStreamState(client, database, [
      { activity_id: routeGroupId, point_count: 0, is_deleted: 1 },
      { activity_id: movedRouteGroupId, point_count: 4, is_deleted: 0 },
    ]);
    expect(await getLocationStreamVersion(client, database, unrelatedRouteGroupId)).toBe(
      unchangedStreamVersion,
    );

    const unchangedLocationVersion = await getLocationSampleVersion(
      client,
      database,
      movedRouteGroupId,
    );
    await setRouteGroupDeleted(client, database, true, 3);
    await runDbtBatch(
      database,
      artifactDirectory,
      ["activity_stream_points"],
      "2026-09-07",
      "2026-09-08",
    );
    await expectLocationStreamState(client, database, [
      { activity_id: routeGroupId, point_count: 0, is_deleted: 1 },
      { activity_id: movedRouteGroupId, point_count: 0, is_deleted: 1 },
    ]);
    const deletedStreamVersion = await getLocationStreamVersion(
      client,
      database,
      movedRouteGroupId,
    );
    await seedTombstoneOnlyCurrentGroup(client, database);
    const tombstoneOnlyPriorVersion = await getLocationStreamVersion(
      client,
      database,
      tombstoneOnlyGroupId,
    );

    await setRouteGroupDeleted(client, database, false, 4);
    await runDbtBatch(
      database,
      artifactDirectory,
      ["activity_stream_points"],
      "2026-09-07",
      "2026-09-08",
    );
    await expectLocationStreamState(client, database, [
      { activity_id: routeGroupId, point_count: 0, is_deleted: 1 },
      { activity_id: movedRouteGroupId, point_count: 4, is_deleted: 0 },
    ]);
    expect(await getLocationStreamVersion(client, database, movedRouteGroupId)).not.toBe(
      deletedStreamVersion,
    );
    expect(await getLocationSampleVersion(client, database, movedRouteGroupId)).toBe(
      unchangedLocationVersion,
    );
    expect(await getLocationStreamVersion(client, database, tombstoneOnlyGroupId)).not.toBe(
      tombstoneOnlyPriorVersion,
    );
    await expectDeletedLocationStream(client, database, tombstoneOnlyGroupId);
    expect(await getLocationStreamVersion(client, database, unrelatedRouteGroupId)).toBe(
      unchangedStreamVersion,
    );

    const priorOldGroupStreamVersion = await getLocationStreamVersion(
      client,
      database,
      routeGroupId,
    );
    const priorMovedGroupStreamVersion = await getLocationStreamVersion(
      client,
      database,
      movedRouteGroupId,
    );
    await runDbtBatch(
      database,
      artifactDirectory,
      ["activity_stream_points"],
      "2026-09-07",
      "2026-09-08",
      [routeMemberId, routeGroupId],
    );
    expect(await getLocationStreamVersion(client, database, routeGroupId)).not.toBe(
      priorOldGroupStreamVersion,
    );
    expect(await getLocationStreamVersion(client, database, movedRouteGroupId)).not.toBe(
      priorMovedGroupStreamVersion,
    );
    expect(await getLocationStreamVersion(client, database, unrelatedRouteGroupId)).toBe(
      unchangedStreamVersion,
    );

    const compiledSql = await readFile(
      join(
        artifactDirectory,
        "run",
        "dofek_analytics",
        "models",
        "read_models",
        "activity_location_sample.sql",
      ),
      "utf8",
    );
    expect(compiledSql).toContain("affected_groups AS MATERIALIZED");
    expect(compiledSql).not.toContain("where ingested_at >= '2026-09-06 00:00:00'");
  }, 240_000);
});

type LocationPointFixture = readonly [
  id: string,
  providerId: string,
  lng: number,
  lat: number,
  recordedAt: string,
  ingestedAt: string,
  memberId?: string,
];

async function seedLocationFixture(client: ClickHouseClient, database: string): Promise<void> {
  await runStatements(client, [
    `DROP DATABASE IF EXISTS ${database} SYNC`,
    `CREATE DATABASE ${database}`,
    createDedupedActivitiesSql(database),
    createDedupedActivityMembersSql(database),
    createMetricStreamSql(database),
    createActivitySensorSampleSql(database),
    `INSERT INTO ${database}.deduped_activities VALUES
      ('${routeGroupId}', '${userId}', toDateTime64('2026-09-03 10:00:00', 6, 'UTC'),
       toDateTime64('2026-09-03 11:00:00', 6, 'UTC'),
       toDateTime64('2026-09-03 12:00:00', 9, 'UTC'),
       ['${routeMemberId}', '${retainedRouteMemberId}'], 1, 0,
       toDateTime64('2026-09-03 12:00:00', 9, 'UTC')),
      ('${unrelatedRouteGroupId}', '${userId}', toDateTime64('2026-09-04 10:00:00', 6, 'UTC'),
       toDateTime64('2026-09-04 11:00:00', 6, 'UTC'),
       toDateTime64('2026-09-04 12:00:00', 9, 'UTC'), ['${unrelatedRouteMemberId}'], 1, 0,
       toDateTime64('2026-09-04 12:00:00', 9, 'UTC'))`,
    `INSERT INTO ${database}.deduped_activity_members VALUES
      ('${routeGroupId}', '${userId}', toDateTime64('2026-09-03 10:00:00', 6, 'UTC'),
       toDateTime64('2026-09-03 11:00:00', 6, 'UTC'),
       toDateTime64('2026-09-03 12:00:00', 9, 'UTC'), '${routeMemberId}', 1, 0,
       toDateTime64('2026-09-03 12:00:00', 9, 'UTC')),
      ('${routeGroupId}', '${userId}', toDateTime64('2026-09-03 10:00:00', 6, 'UTC'),
       toDateTime64('2026-09-03 11:00:00', 6, 'UTC'),
       toDateTime64('2026-09-03 12:00:00', 9, 'UTC'), '${retainedRouteMemberId}', 1, 0,
       toDateTime64('2026-09-03 12:00:00', 9, 'UTC')),
      ('${unrelatedRouteGroupId}', '${userId}', toDateTime64('2026-09-04 10:00:00', 6, 'UTC'),
       toDateTime64('2026-09-04 11:00:00', 6, 'UTC'),
       toDateTime64('2026-09-04 12:00:00', 9, 'UTC'), '${unrelatedRouteMemberId}', 1, 0,
       toDateTime64('2026-09-04 12:00:00', 9, 'UTC'))`,
  ]);
}

async function moveRouteMember(client: ClickHouseClient, database: string): Promise<void> {
  await runStatements(client, [
    `INSERT INTO ${database}.deduped_activities
      SELECT toUUID('${routeGroupId}'), toUUID('${userId}'),
        toDateTime64('2026-09-03 10:00:00', 6, 'UTC'),
        toNullable(toDateTime64('2026-09-03 11:00:00', 6, 'UTC')),
        move_refreshed_at, [toUUID('${retainedRouteMemberId}')], toUInt64(2), toUInt8(0),
        move_refreshed_at
      FROM (
        SELECT max(refreshed_at) + INTERVAL 1 MICROSECOND AS move_refreshed_at
        FROM ${database}.activity_location_sample
      )`,
    `INSERT INTO ${database}.deduped_activities
      SELECT toUUID('${movedRouteGroupId}'), toUUID('${userId}'),
        toDateTime64('2026-09-03 10:00:00', 6, 'UTC'),
        toNullable(toDateTime64('2026-09-03 11:00:00', 6, 'UTC')),
        move_refreshed_at, [toUUID('${routeMemberId}')], toUInt64(2), toUInt8(0),
        move_refreshed_at
      FROM (
        SELECT max(refreshed_at) + INTERVAL 1 MICROSECOND AS move_refreshed_at
        FROM ${database}.activity_location_sample
      )`,
    `INSERT INTO ${database}.deduped_activity_members
      SELECT toUUID('${movedRouteGroupId}'), toUUID('${userId}'),
        toDateTime64('2026-09-03 10:00:00', 6, 'UTC'),
        toNullable(toDateTime64('2026-09-03 11:00:00', 6, 'UTC')),
        move_refreshed_at, toUUID('${routeMemberId}'), toUInt64(2), toUInt8(0),
        move_refreshed_at
      FROM (
        SELECT max(refreshed_at) + INTERVAL 1 MICROSECOND AS move_refreshed_at
        FROM ${database}.activity_location_sample
      )`,
  ]);
}

async function setRouteGroupDeleted(
  client: ClickHouseClient,
  database: string,
  isDeleted: boolean,
  version: number,
): Promise<void> {
  await client.command({
    query: `INSERT INTO ${database}.deduped_activities
      SELECT activity_id, user_id, started_at, ended_at, source_synced_at, member_activity_ids,
        toUInt64(${version}), toUInt8(${isDeleted ? 1 : 0}),
        refreshed_at + INTERVAL 1 MICROSECOND
      FROM ${database}.deduped_activities FINAL
      WHERE activity_id = toUUID('${movedRouteGroupId}')`,
  });
}

async function seedTombstoneOnlyCurrentGroup(
  client: ClickHouseClient,
  database: string,
): Promise<void> {
  await runStatements(client, [
    `INSERT INTO ${database}.deduped_activities VALUES
      ('${tombstoneOnlyGroupId}', '${userId}',
       toDateTime64('2026-09-03 10:00:00', 6, 'UTC'),
       toDateTime64('2026-09-03 11:00:00', 6, 'UTC'),
       toDateTime64('2026-09-03 12:00:00', 9, 'UTC'), ['${tombstoneOnlyMemberId}'], 1, 0,
       toDateTime64('2026-09-03 12:00:00', 9, 'UTC'))`,
    `INSERT INTO ${database}.activity_stream_points
      SELECT toUUID('${userId}'), toUUID('${tombstoneOnlyGroupId}'),
        CAST([], 'Array(Tuple(DateTime64(6, ''UTC''), Nullable(Float64), Nullable(Float64), Nullable(Float64), Nullable(Float64), Nullable(Float64), Nullable(Float64), Nullable(Float64)))'),
        toUInt64(1), toUInt8(1), toDateTime64('2026-09-03 12:00:00', 9, 'UTC')`,
  ]);
}

async function insertLocationPoints(
  client: ClickHouseClient,
  database: string,
  points: readonly LocationPointFixture[],
): Promise<void> {
  const values = points.map(
    ([id, providerId, lng, lat, recordedAt, ingestedAt, memberId]) =>
      `('${id}', '${memberId ?? routeMemberId}', '${userId}',
      toDateTime64('${recordedAt}', 9, 'UTC'), '${providerId}', 'location', tuple(${lng}, ${lat}),
      toDateTime64('${ingestedAt}', 9, 'UTC'), 1, 0)`,
  );
  await client.command({
    query: `INSERT INTO ${database}.metric_stream VALUES ${values.join(",")}`,
  });
}

async function expectActiveLocationPointIds(
  client: ClickHouseClient,
  database: string,
  activityId: string,
  expectedPointIds: readonly string[],
): Promise<void> {
  const result = await client.query({
    query: `SELECT toString(source_metric_stream_id) AS source_metric_stream_id
      FROM ${database}.activity_location_sample FINAL
      WHERE activity_id = toUUID('${activityId}') AND is_deleted = 0
      ORDER BY source_metric_stream_id`,
    format: "JSONEachRow",
  });
  expect(await result.json()).toEqual(
    expectedPointIds.map((source_metric_stream_id) => ({ source_metric_stream_id })),
  );
}

async function expectLocationCentroid(
  client: ClickHouseClient,
  database: string,
  activityId: string,
  expectedLat: number,
  expectedLng: number,
): Promise<void> {
  const result = await client.query({
    query: `SELECT centroid_lat, centroid_lng
      FROM ${database}.activity_location_summary_rows FINAL
      WHERE activity_id = toUUID('${activityId}') AND is_deleted = 0`,
    format: "JSONEachRow",
  });
  const [summary] = z
    .array(z.object({ centroid_lat: z.coerce.number(), centroid_lng: z.coerce.number() }))
    .parse(await result.json());
  expect(summary?.centroid_lat).toBeCloseTo(expectedLat, 4);
  expect(summary?.centroid_lng).toBeCloseTo(expectedLng, 4);
}

async function expectNoActiveLocationSummary(
  client: ClickHouseClient,
  database: string,
  activityId: string,
): Promise<void> {
  const result = await client.query({
    query: `SELECT count() AS active_count
      FROM ${database}.activity_location_summary_rows FINAL
      WHERE activity_id = toUUID('${activityId}') AND is_deleted = 0`,
    format: "JSONEachRow",
  });
  expect(await result.json()).toEqual([{ active_count: 0 }]);
}

async function expectLocationStreamState(
  client: ClickHouseClient,
  database: string,
  expected: Array<{ activity_id: string; point_count: number; is_deleted: number }>,
): Promise<void> {
  const result = await client.query({
    query: `SELECT toString(activity_id) AS activity_id, length(points) AS point_count, is_deleted
      FROM ${database}.activity_stream_points FINAL
      WHERE toString(activity_id) IN ('${routeGroupId}', '${movedRouteGroupId}')
      ORDER BY activity_id`,
    format: "JSONEachRow",
  });
  expect(await result.json()).toEqual(expected);
}

async function getLocationStreamVersion(
  client: ClickHouseClient,
  database: string,
  activityId: string,
): Promise<string> {
  const result = await client.query({
    query: `SELECT toString(refresh_version) AS refresh_version
      FROM ${database}.activity_stream_points FINAL
      WHERE activity_id = toUUID('${activityId}')`,
    format: "JSONEachRow",
  });
  const [row] = z.array(z.object({ refresh_version: z.string() })).parse(await result.json());
  if (!row) throw new Error(`Missing stream row for activity ${activityId}`);
  return row.refresh_version;
}

async function getLocationSampleVersion(
  client: ClickHouseClient,
  database: string,
  activityId: string,
): Promise<string> {
  const result = await client.query({
    query: `SELECT toString(max(refresh_version)) AS refresh_version
      FROM ${database}.activity_location_sample
      WHERE activity_id = toUUID('${activityId}')`,
    format: "JSONEachRow",
  });
  const [row] = z.array(z.object({ refresh_version: z.string() })).parse(await result.json());
  if (!row) throw new Error(`Missing location sample rows for activity ${activityId}`);
  return row.refresh_version;
}

async function expectDeletedLocationStream(
  client: ClickHouseClient,
  database: string,
  activityId: string,
): Promise<void> {
  const result = await client.query({
    query: `SELECT length(points) AS point_count, is_deleted
      FROM ${database}.activity_stream_points FINAL
      WHERE activity_id = toUUID('${activityId}')`,
    format: "JSONEachRow",
  });
  expect(await result.json()).toEqual([{ point_count: 0, is_deleted: 1 }]);
}

async function expectHistoricalLocationMappingsNewerThanStream(
  client: ClickHouseClient,
  database: string,
): Promise<void> {
  const result = await client.query({
    query: `WITH prior_stream AS (
        SELECT refresh_version, refreshed_at
        FROM ${database}.activity_stream_points FINAL
        WHERE activity_id = toUUID('${routeGroupId}')
      )
      SELECT
        toUInt32(countIf(location.refresh_version > prior_stream.refresh_version))
          AS newer_mapping_count,
        toUInt32(countIf(location.refreshed_at < prior_stream.refreshed_at))
          AS historical_mapping_count
      FROM ${database}.activity_location_sample AS location FINAL
      CROSS JOIN prior_stream
      WHERE toString(location.source_metric_stream_id) IN (${providerBPointIds
        .map((id) => `'${id}'`)
        .join(",")})`,
    format: "JSONEachRow",
  });
  expect(await result.json()).toEqual([{ newer_mapping_count: 8, historical_mapping_count: 8 }]);
}

async function seedSensorFixture(client: ClickHouseClient, database: string): Promise<void> {
  await runStatements(client, [
    `DROP DATABASE IF EXISTS ${database} SYNC`,
    `CREATE DATABASE ${database}`,
    createDedupedActivitiesSql(database),
    createDedupedSensorSql(database),
    `INSERT INTO ${database}.deduped_activities VALUES
      ('${oldGroupId}', '${userId}', toDateTime64('2026-09-04 10:00:00', 6, 'UTC'),
       toDateTime64('2026-09-04 11:00:00', 6, 'UTC'),
       toDateTime64('2026-09-04 12:00:00', 9, 'UTC'),
       ['${movedMemberId}', '${retainedMemberId}'], 1, 0,
       toDateTime64('2026-09-04 12:00:00', 9, 'UTC')),
      ('${unrelatedGroupId}', '${userId}', toDateTime64('2026-09-05 10:00:00', 6, 'UTC'),
       toDateTime64('2026-09-05 11:00:00', 6, 'UTC'),
       toDateTime64('2026-09-05 12:00:00', 9, 'UTC'),
       ['${unrelatedMemberId}'], 1, 0,
       toDateTime64('2026-09-05 12:00:00', 9, 'UTC'))`,
    `INSERT INTO ${database}.deduped_sensor VALUES
      ('${userId}', toDateTime64('2026-09-04 10:30:00', 9, 'UTC'), toDate('2026-09-04'),
       'heart_rate', 100, '${movedMemberId}', 1, 0,
       toDateTime64('2026-09-04 12:00:00', 9, 'UTC')),
      ('${userId}', toDateTime64('2026-09-05 10:30:00', 9, 'UTC'), toDate('2026-09-05'),
       'heart_rate', 120, '${unrelatedMemberId}', 1, 0,
       toDateTime64('2026-09-05 12:00:00', 9, 'UTC'))`,
  ]);
}

async function moveMemberAndReplaySensor(
  client: ClickHouseClient,
  database: string,
): Promise<void> {
  await runStatements(client, [
    `INSERT INTO ${database}.deduped_activities VALUES
      ('${oldGroupId}', '${userId}', toDateTime64('2026-09-04 10:00:00', 6, 'UTC'),
       toDateTime64('2026-09-04 11:00:00', 6, 'UTC'),
       toDateTime64('2026-09-06 12:00:00', 9, 'UTC'),
       ['${retainedMemberId}'], 2, 0,
       toDateTime64('2026-09-06 12:00:00', 9, 'UTC')),
      ('${newGroupId}', '${userId}', toDateTime64('2026-09-04 10:00:00', 6, 'UTC'),
       toDateTime64('2026-09-04 11:00:00', 6, 'UTC'),
       toDateTime64('2026-09-06 12:00:00', 9, 'UTC'),
       ['${movedMemberId}'], 2, 0,
       toDateTime64('2026-09-06 12:00:00', 9, 'UTC'))`,
    `INSERT INTO ${database}.deduped_sensor VALUES
      ('${userId}', toDateTime64('2026-09-04 10:30:00', 9, 'UTC'), toDate('2026-09-04'),
       'heart_rate', 100, '${movedMemberId}', 2, 0,
       toDateTime64('2026-09-06 12:00:00', 9, 'UTC'))`,
  ]);
}

async function expectSensorState(
  client: ClickHouseClient,
  database: string,
  expectedSamples: z.infer<typeof sampleRowSchema>[],
  expectedSummaries: z.infer<typeof sensorSummarySchema>[],
): Promise<void> {
  const samplesResult = await client.query({
    query: `SELECT toString(activity_id) AS activity_id, scalar, is_deleted
      FROM ${database}.activity_sensor_sample FINAL
      ORDER BY activity_id`,
    format: "JSONEachRow",
  });
  const sampleRows = z.array(sampleRowSchema).parse(await samplesResult.json());
  const sampleVersionsResult = await client.query({
    query: `SELECT toString(activity_id) AS activity_id, scalar, refresh_version, is_deleted,
        toString(refreshed_at) AS refreshed_at
      FROM ${database}.activity_sensor_sample
      ORDER BY activity_id, refresh_version`,
    format: "JSONEachRow",
  });
  expect(sampleRows, JSON.stringify(await sampleVersionsResult.json())).toEqual(expectedSamples);

  const summariesResult = await client.query({
    query: `SELECT toString(activity_id) AS activity_id, avg_hr, sample_count, is_deleted
      FROM ${database}.activity_sensor_summary_rows FINAL
      ORDER BY activity_id`,
    format: "JSONEachRow",
  });
  expect(z.array(sensorSummarySchema).parse(await summariesResult.json())).toEqual(
    expectedSummaries,
  );
}

async function runDbtBatch(
  database: string,
  artifactDirectory: string,
  models: readonly string[],
  start: string,
  end: string,
  activityIds?: readonly string[],
): Promise<void> {
  const url = new URL(requireClickHouseUrl());
  const result = await runProcess(
    "uv",
    [
      "run",
      "--project",
      "analytics",
      "dbt",
      "run",
      "--project-dir",
      "analytics",
      "--profiles-dir",
      "analytics",
      "--threads",
      "1",
      "--no-use-colors",
      "--target-path",
      artifactDirectory,
      "--event-time-start",
      start,
      "--event-time-end",
      end,
      "--vars",
      JSON.stringify({
        activity_sensor_sample_begin: start,
        initial_lookback_days: 365,
        ...(activityIds
          ? {
              activity_refresh_user_id: userId,
              activity_refresh_activity_ids: activityIds,
            }
          : {}),
      }),
      "--select",
      models.join(" "),
    ],
    {
      ...process.env,
      DBT_TARGET: "dev",
      DBT_CLICKHOUSE_SCHEMA: database,
      DBT_ANALYTICS_SOURCE_SCHEMA: database,
      DBT_INGEST_SOURCE_SCHEMA: database,
      DBT_POSTGRES_FITNESS_SOURCE_SCHEMA: database,
      DBT_CLICKHOUSE_HOST: url.hostname,
      DBT_CLICKHOUSE_PORT: url.port,
      DBT_CLICKHOUSE_USER: decodeURIComponent(url.username),
      DBT_CLICKHOUSE_PASSWORD: decodeURIComponent(url.password),
      UV_PROJECT_ENVIRONMENT: "../.venv-analytics",
    },
  );
  expect(result.exitCode, result.stderr || result.stdout).toBe(0);
}

function runProcess(
  command: string,
  argumentsList: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argumentsList, {
      cwd: process.cwd(),
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolve({ exitCode: exitCode ?? 1, stdout, stderr });
    });
  });
}

async function runStatements(client: ClickHouseClient, statements: string[]): Promise<void> {
  for (const statement of statements) {
    await client.command({ query: statement });
  }
}

function createDedupedActivitiesSql(database: string): string {
  return `CREATE TABLE ${database}.deduped_activities (
    activity_id UUID,
    user_id UUID,
    started_at DateTime64(6, 'UTC'),
    ended_at Nullable(DateTime64(6, 'UTC')),
    source_synced_at DateTime64(9, 'UTC'),
    member_activity_ids Array(UUID),
    refresh_version UInt64,
    is_deleted UInt8,
    refreshed_at DateTime64(9, 'UTC')
  ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (user_id, activity_id)`;
}

function createDedupedSensorSql(database: string): string {
  return `CREATE TABLE ${database}.deduped_sensor (
    user_id UUID,
    recorded_at DateTime64(9, 'UTC'),
    recorded_date Date,
    channel String,
    scalar Nullable(Float64),
    source_activity_id Nullable(UUID),
    refresh_version UInt64,
    is_deleted UInt8,
    refreshed_at DateTime64(9, 'UTC')
  ) ENGINE = ReplacingMergeTree(refresh_version)
    ORDER BY (user_id, channel, recorded_date, recorded_at)`;
}

function createDedupedActivityMembersSql(database: string): string {
  return `CREATE TABLE ${database}.deduped_activity_members (
    activity_id UUID,
    user_id UUID,
    started_at DateTime64(6, 'UTC'),
    ended_at Nullable(DateTime64(6, 'UTC')),
    source_synced_at DateTime64(9, 'UTC'),
    member_activity_id UUID,
    refresh_version UInt64,
    is_deleted UInt8,
    refreshed_at DateTime64(9, 'UTC')
  ) ENGINE = ReplacingMergeTree(refresh_version)
    ORDER BY (user_id, member_activity_id)`;
}

function createMetricStreamSql(database: string): string {
  return `CREATE TABLE ${database}.metric_stream (
    id UUID,
    activity_id Nullable(UUID),
    user_id UUID,
    recorded_at DateTime64(9, 'UTC'),
    provider_id String,
    channel String,
    point Point,
    ingested_at DateTime64(9, 'UTC'),
    version UInt64,
    is_deleted UInt8
  ) ENGINE = MergeTree ORDER BY (id, version)`;
}

function createActivitySensorSampleSql(database: string): string {
  return `CREATE TABLE ${database}.activity_sensor_sample (
    activity_id UUID,
    user_id UUID,
    recorded_at DateTime64(9, 'UTC'),
    channel String,
    scalar Nullable(Float64),
    refresh_version UInt64,
    is_deleted UInt8,
    refreshed_at DateTime64(9, 'UTC')
  ) ENGINE = ReplacingMergeTree(refresh_version)
    ORDER BY (user_id, activity_id, channel, recorded_at)`;
}

function requireClickHouseUrl(): string {
  const url = process.env.CLICKHOUSE_URL?.trim();
  if (!url) throw new Error("CLICKHOUSE_URL is required");
  return url;
}
