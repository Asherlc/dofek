import { spawn } from "node:child_process";
import type { createClient } from "@clickhouse/client";
import { expect } from "vitest";
import { z } from "zod";

type ClickHouseClient = ReturnType<typeof createClient>;

export const userId = "00000000-0000-0000-0000-000000001001";
export const oldGroupId = "00000000-0000-0000-0000-000000001010";
export const newGroupId = "00000000-0000-0000-0000-000000001011";
export const unrelatedGroupId = "00000000-0000-0000-0000-000000001012";
export const movedMemberId = "00000000-0000-0000-0000-000000001020";
export const retainedMemberId = "00000000-0000-0000-0000-000000001021";
export const unrelatedMemberId = "00000000-0000-0000-0000-000000001022";
export const routeGroupId = "00000000-0000-0000-0000-000000001030";
export const unrelatedRouteGroupId = "00000000-0000-0000-0000-000000001031";
export const routeMemberId = "00000000-0000-0000-0000-000000001032";
export const unrelatedRouteMemberId = "00000000-0000-0000-0000-000000001033";
export const movedRouteGroupId = "00000000-0000-0000-0000-000000001034";
export const retainedRouteMemberId = "00000000-0000-0000-0000-000000001035";
export const tombstoneOnlyGroupId = "00000000-0000-0000-0000-000000001036";
export const tombstoneOnlyMemberId = "00000000-0000-0000-0000-000000001037";
export const productionSliceGroupId = "00000000-0000-0000-0000-000000001038";
export const productionSliceMemberId = "00000000-0000-0000-0000-000000001039";
export const productionSliceProviderBMemberId = "00000000-0000-0000-0000-000000001048";
export const productionRestoreGroupId = "00000000-0000-0000-0000-000000001050";
export const productionRestoreMemberId = "00000000-0000-0000-0000-000000001051";
export const productionRestorePointId = "00000000-0000-0000-0000-000000001052";
export const productionProvenanceGroupId = "00000000-0000-0000-0000-000000001053";
export const productionProvenanceLowerMemberId = "00000000-0000-0000-0000-000000000001";
export const productionProvenanceStorageFirstMemberId = "10000000-0000-0000-0000-000000000000";
export const providerAPointIds = [
  "00000000-0000-0000-0000-000000001040",
  "00000000-0000-0000-0000-000000001041",
  "00000000-0000-0000-0000-000000001042",
] as const;
export const providerBPointIds = [
  "00000000-0000-0000-0000-000000001043",
  "00000000-0000-0000-0000-000000001044",
  "00000000-0000-0000-0000-000000001045",
  "00000000-0000-0000-0000-000000001046",
] as const;
export const unrelatedPointId = "00000000-0000-0000-0000-000000001047";

export const sampleRowSchema = z.object({
  activity_id: z.string(),
  scalar: z.coerce.number(),
  is_deleted: z.coerce.number(),
});

export const sensorSummarySchema = z.object({
  activity_id: z.string(),
  avg_hr: z.coerce.number().nullable(),
  sample_count: z.coerce.number(),
  is_deleted: z.coerce.number(),
});

export type LocationPointFixture = readonly [
  id: string,
  providerId: string,
  lng: number,
  lat: number,
  recordedAt: string,
  ingestedAt: string,
  memberId?: string,
];

export async function seedLocationFixture(
  client: ClickHouseClient,
  database: string,
): Promise<void> {
  await runStatements(client, [
    `DROP DATABASE IF EXISTS ${database} SYNC`,
    `CREATE DATABASE ${database}`,
    createDedupedActivitiesSql(database),
    createDedupedActivityMembersSql(database),
    createMetricStreamSql(database),
    createActivityLocationMemberChangeSql(database),
    createActivityLocationMemberChangeViewSql(database),
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

export async function moveRouteMember(client: ClickHouseClient, database: string): Promise<void> {
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

export async function setRouteGroupDeleted(
  client: ClickHouseClient,
  database: string,
  isDeleted: boolean,
): Promise<void> {
  await client.command({
    query: `INSERT INTO ${database}.deduped_activities
      SELECT activity_id, user_id, started_at, ended_at, source_synced_at, member_activity_ids,
        stream_state.next_refresh_version, toUInt8(${isDeleted ? 1 : 0}),
        refreshed_at + INTERVAL 1 MICROSECOND
      FROM ${database}.deduped_activities FINAL
      CROSS JOIN (
        SELECT max(refresh_version) + 1 AS next_refresh_version
        FROM ${database}.activity_stream_points
        WHERE activity_id = toUUID('${movedRouteGroupId}')
      ) AS stream_state
      WHERE activity_id = toUUID('${movedRouteGroupId}')`,
  });
}

export async function seedTombstoneOnlyCurrentGroup(
  client: ClickHouseClient,
  database: string,
): Promise<void> {
  await runStatements(client, [
    `INSERT INTO ${database}.deduped_activities VALUES
      ('${tombstoneOnlyGroupId}', '${userId}',
       toDateTime64('2026-09-03 10:00:00', 6, 'UTC'),
       toDateTime64('2026-09-03 11:00:00', 6, 'UTC'),
       toDateTime64('2026-09-03 12:00:00', 9, 'UTC'), ['${tombstoneOnlyMemberId}'], 2, 0,
       toDateTime64('2026-09-03 12:00:00', 9, 'UTC'))`,
    `INSERT INTO ${database}.activity_stream_points
      SELECT toUUID('${userId}'), toUUID('${tombstoneOnlyGroupId}'),
        CAST([], 'Array(Tuple(DateTime64(6, ''UTC''), Nullable(Float64), Nullable(Float64), Nullable(Float64), Nullable(Float64), Nullable(Float64), Nullable(Float64), Nullable(Float64)))'),
        toUInt64(1), toUInt8(1), toDateTime64('2026-09-03 12:00:00', 9, 'UTC')`,
  ]);
}

export async function seedProductionLifecycleSliceFixture(
  client: ClickHouseClient,
  database: string,
): Promise<void> {
  await runStatements(client, [
    `DROP DATABASE IF EXISTS ${database} SYNC`,
    `CREATE DATABASE ${database}`,
    createActivitySourceRecordsSql(database),
    createSourceActivitySql(database),
    createProducerDedupedSensorSql(database),
    createActivitySensorSampleSql(database),
    createActivityLocationSampleSql(database),
    createActivityStreamPointsSql(database),
    `INSERT INTO ${database}.activity_source_records (
       activity_id, group_id, provider_id, user_id, external_id, canonical_type,
       provider_type, modality, started_at, ended_at, source_name, name, notes,
       timezone, start_utc_offset_minutes, end_utc_offset_minutes,
       local_time_source, raw, source_synced_at, priority, refresh_version, is_deleted,
       refreshed_at
      ) VALUES
      (
       '${productionSliceMemberId}', '${productionSliceGroupId}', 'wahoo', '${userId}',
       'production-slice', 'cycling', 'cycling', NULL,
       toDateTime64('2026-09-07 10:00:00', 6, 'UTC'),
       toDateTime64('2026-09-07 11:00:00', 6, 'UTC'), 'Wahoo', 'Morning Ride', NULL,
       'America/Los_Angeles', -420, -420, 'provider_timezone', '{}',
       toDateTime64('2026-09-07 12:00:00', 9, 'UTC'), 10, 1, 0,
       toDateTime64('2026-09-07 12:00:00', 9, 'UTC')
      ),
      (
       '${productionSliceProviderBMemberId}', '${productionSliceGroupId}', 'garmin', '${userId}',
       'production-slice-provider-b', 'cycling', 'cycling', NULL,
       toDateTime64('2026-09-07 10:00:00', 6, 'UTC'),
       toDateTime64('2026-09-07 11:00:00', 6, 'UTC'), 'Garmin', 'Garmin Ride', NULL,
       'America/Los_Angeles', -420, -420, 'provider_timezone', '{}',
       toDateTime64('2026-09-07 12:00:00', 9, 'UTC'), 20, 1, 0,
       toDateTime64('2026-09-07 12:00:00', 9, 'UTC')
      ),
      (
       '${productionRestoreMemberId}', '${productionRestoreGroupId}', 'wahoo', '${userId}',
       'production-restore', 'cycling', 'cycling', NULL,
       toDateTime64('2026-09-07 13:00:00', 6, 'UTC'),
       toDateTime64('2026-09-07 14:00:00', 6, 'UTC'), 'Wahoo', 'Restorable Ride', NULL,
       'America/Los_Angeles', -420, -420, 'provider_timezone', '{}',
       toDateTime64('2026-09-07 15:00:00', 9, 'UTC'), 10, 1, 0,
       toDateTime64('2026-09-07 15:00:00', 9, 'UTC')
      ),
      (
       '${productionProvenanceStorageFirstMemberId}', '${productionProvenanceGroupId}',
       'garmin', '${userId}', 'provenance-storage-first', 'cycling', 'cycling', NULL,
       toDateTime64('2026-09-07 16:00:00', 6, 'UTC'),
       toDateTime64('2026-09-07 17:00:00', 6, 'UTC'), 'Garmin', 'Equal Ride',
       'storage-first notes', 'America/Los_Angeles', -420, -420,
       'provider_timezone', '{"source":"storage-first"}',
       toDateTime64('2026-09-07 18:00:00', 9, 'UTC'), 30, 1, 0,
       toDateTime64('2026-09-07 18:00:00', 9, 'UTC')
      ),
      (
       '${productionProvenanceLowerMemberId}', '${productionProvenanceGroupId}',
       'garmin', '${userId}', 'provenance-code-unit-lower', 'cycling', 'cycling', NULL,
       toDateTime64('2026-09-07 16:00:00', 6, 'UTC'),
       toDateTime64('2026-09-07 17:00:00', 6, 'UTC'), 'Garmin', 'Equal Ride',
       'code-unit-lower notes', 'America/Los_Angeles', -420, -420,
       'provider_timezone', '{"source":"code-unit-lower"}',
       toDateTime64('2026-09-07 18:00:00', 9, 'UTC'), 30, 1, 0,
       toDateTime64('2026-09-07 18:00:00', 9, 'UTC')
      )`,
    `INSERT INTO ${database}.activity_location_sample
      (activity_id, user_id, recorded_at, recorded_date, source_metric_stream_id,
       lat, lng, refresh_version, is_deleted, source_refreshed_at, refreshed_at) VALUES (
       '${productionRestoreGroupId}', '${userId}',
       toDateTime64('2026-09-07 13:30:00', 9, 'UTC'), toDate('2026-09-07'),
       '${productionRestorePointId}', 37.8, -122.3, 1, 0,
       toDateTime64('2026-09-07 15:00:00', 9, 'UTC'),
       toDateTime64('2026-09-07 15:00:00', 9, 'UTC')
      )`,
  ]);
}

export async function rebuildEqualPriorityProvenanceInputs(
  client: ClickHouseClient,
  database: string,
): Promise<void> {
  await client.command({
    query: `INSERT INTO ${database}.activity_source_records
      SELECT
        activity_id, group_id, provider_id, user_id, external_id, canonical_type,
        provider_type, modality, started_at, ended_at, source_name, name, notes,
        timezone, start_utc_offset_minutes, end_utc_offset_minutes,
        local_time_source, raw, source_synced_at, priority,
        refresh_version + 1 AS refresh_version, is_deleted,
        refreshed_at + INTERVAL 1 SECOND AS refreshed_at
      FROM ${database}.activity_source_records FINAL
      WHERE activity_id IN (
        toUUID('${productionProvenanceLowerMemberId}'),
        toUUID('${productionProvenanceStorageFirstMemberId}')
      )
      ORDER BY toString(activity_id) DESC`,
  });
}

export async function changeActivitySourceRecord(
  client: ClickHouseClient,
  database: string,
  activityId: string,
  change: { groupId?: string; priority?: number; isDeleted?: boolean },
): Promise<void> {
  await client.command({
    query: `INSERT INTO ${database}.activity_source_records
      SELECT
        activity_id,
        ${change.groupId ? `toUUID('${change.groupId}')` : "group_id"} AS group_id,
        provider_id,
        user_id,
        external_id,
        canonical_type,
        provider_type,
        modality,
        started_at,
        ended_at,
        source_name,
        name,
        notes,
        timezone,
        start_utc_offset_minutes,
        end_utc_offset_minutes,
        local_time_source,
        raw,
        source_synced_at,
        ${change.priority ?? "priority"} AS priority,
        refresh_version + 1 AS refresh_version,
        toUInt8(${change.isDeleted ? 1 : 0}) AS is_deleted,
        refreshed_at + INTERVAL 1 SECOND AS refreshed_at
      FROM ${database}.activity_source_records FINAL
      WHERE activity_id = toUUID('${activityId}')`,
  });
}

export async function insertLocationPoints(
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
    query: `INSERT INTO ${database}.metric_stream
      (id, activity_id, user_id, recorded_at, provider_id, channel, point,
       ingested_at, version, is_deleted) VALUES ${values.join(",")}`,
  });
}

export async function expectActiveLocationPointIds(
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

export async function expectLocationCentroid(
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

export async function expectNoActiveLocationSummary(
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

export async function expectLocationStreamState(
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

export async function getLocationStreamVersion(
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

export async function getDedupedActivityVersion(
  client: ClickHouseClient,
  database: string,
  activityId: string,
): Promise<string> {
  const result = await client.query({
    query: `SELECT toString(refresh_version) AS refresh_version
      FROM ${database}.deduped_activities FINAL
      WHERE activity_id = toUUID('${activityId}')`,
    format: "JSONEachRow",
  });
  const [row] = z.array(z.object({ refresh_version: z.string() })).parse(await result.json());
  if (!row) throw new Error(`Missing deduped activity row for activity ${activityId}`);
  return row.refresh_version;
}

export async function getDedupedActivityState(
  client: ClickHouseClient,
  database: string,
  activityId: string,
): Promise<{
  primary_activity_id: string;
  member_activity_ids: string[];
  notes: string | null;
  raw: string | null;
  refresh_version: string;
}> {
  const result = await client.query({
    query: `SELECT
        toString(primary_activity_id) AS primary_activity_id,
        arrayMap(member_id -> toString(member_id), member_activity_ids) AS member_activity_ids,
        notes,
        raw,
        toString(refresh_version) AS refresh_version
      FROM ${database}.deduped_activities FINAL
      WHERE activity_id = toUUID('${activityId}') AND is_deleted = 0`,
    format: "JSONEachRow",
  });
  const [row] = z
    .array(
      z.object({
        primary_activity_id: z.string(),
        member_activity_ids: z.array(z.string()),
        notes: z.string().nullable(),
        raw: z.string().nullable(),
        refresh_version: z.string(),
      }),
    )
    .parse(await result.json());
  if (!row) throw new Error(`Missing active deduped activity ${activityId}`);
  return row;
}

export async function getDedupedActivityHistory(
  client: ClickHouseClient,
  database: string,
  activityId: string,
): Promise<{ row_count: number; transition_count: number }> {
  const result = await client.query({
    query: `SELECT
        toUInt32(count()) AS row_count,
        toUInt32(uniqExact(refresh_version)) AS transition_count
      FROM ${database}.deduped_activities
      WHERE activity_id = toUUID('${activityId}')`,
    format: "JSONEachRow",
  });
  const [row] = z
    .array(
      z.object({
        row_count: z.coerce.number(),
        transition_count: z.coerce.number(),
      }),
    )
    .parse(await result.json());
  if (!row) throw new Error(`Missing deduped activity history for activity ${activityId}`);
  return row;
}

export async function getStreamTransitionCount(
  client: ClickHouseClient,
  database: string,
  activityId: string,
): Promise<number> {
  const result = await client.query({
    query: `SELECT toUInt32(uniqExact(refresh_version)) AS transition_count
      FROM ${database}.activity_stream_points
      WHERE activity_id = toUUID('${activityId}')`,
    format: "JSONEachRow",
  });
  const [row] = z
    .array(z.object({ transition_count: z.coerce.number() }))
    .parse(await result.json());
  if (!row) throw new Error(`Missing stream transition count for activity ${activityId}`);
  return row.transition_count;
}

export async function getLocationSampleVersion(
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

export async function expectDeletedLocationStream(
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

export async function expectActiveLocationStream(
  client: ClickHouseClient,
  database: string,
  activityId: string,
  pointCount: number,
): Promise<void> {
  const result = await client.query({
    query: `SELECT length(points) AS point_count, is_deleted
      FROM ${database}.activity_stream_points FINAL
      WHERE activity_id = toUUID('${activityId}')`,
    format: "JSONEachRow",
  });
  expect(await result.json()).toEqual([{ point_count: pointCount, is_deleted: 0 }]);
}

export async function expectHistoricalLocationMappingsNewerThanStream(
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

export async function seedSensorFixture(client: ClickHouseClient, database: string): Promise<void> {
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
    `INSERT INTO ${database}.deduped_sensor
      (user_id, recorded_at, recorded_date, channel, scalar, source_activity_id,
       refresh_version, is_deleted, refreshed_at) VALUES
      ('${userId}', toDateTime64('2026-09-04 10:30:00', 9, 'UTC'), toDate('2026-09-04'),
       'heart_rate', 100, '${movedMemberId}', 1, 0,
       toDateTime64('2026-09-04 12:00:00', 9, 'UTC')),
      ('${userId}', toDateTime64('2026-09-05 10:30:00', 9, 'UTC'), toDate('2026-09-05'),
       'heart_rate', 120, '${unrelatedMemberId}', 1, 0,
       toDateTime64('2026-09-05 12:00:00', 9, 'UTC'))`,
  ]);
}

export async function moveMemberAndReplaySensor(
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
    `INSERT INTO ${database}.deduped_sensor
      (user_id, recorded_at, recorded_date, channel, scalar, source_activity_id,
       refresh_version, is_deleted, refreshed_at) VALUES
      ('${userId}', toDateTime64('2026-09-04 10:30:00', 9, 'UTC'), toDate('2026-09-04'),
       'heart_rate', 100, '${movedMemberId}', 2, 0,
       toDateTime64('2026-09-06 12:00:00', 9, 'UTC'))`,
  ]);
}

export async function expectSensorState(
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

export async function runDbtBatch(
  database: string,
  artifactDirectory: string,
  models: readonly string[],
  start: string,
  end: string,
  activityIds?: readonly string[],
  activityLocationBatchSize?: number,
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
        ...(activityLocationBatchSize
          ? { activity_location_batch_size: activityLocationBatchSize }
          : {}),
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

export function runProcess(
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

export async function runStatements(client: ClickHouseClient, statements: string[]): Promise<void> {
  for (const statement of statements) {
    await client.command({ query: statement });
  }
}

export function createDedupedActivitiesSql(database: string): string {
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

export function createDedupedSensorSql(database: string): string {
  return `CREATE TABLE ${database}.deduped_sensor (
    user_id UUID,
    recorded_at DateTime64(9, 'UTC'),
    recorded_date Date,
    channel String,
    scalar Nullable(Float64),
    provider_id Nullable(String),
    member_activity_id Nullable(UUID),
    device_id Nullable(String),
    source_external_id Nullable(String),
    source_type Nullable(String),
    measurement_kind LowCardinality(String),
    source_metric_stream_id Nullable(UUID),
    source_activity_id Nullable(UUID),
    provider_priority Int32,
    refresh_version UInt64,
    is_deleted UInt8,
    refreshed_at DateTime64(9, 'UTC')
  ) ENGINE = ReplacingMergeTree(refresh_version)
    ORDER BY (user_id, channel, recorded_date, recorded_at)`;
}

export function createDedupedActivityMembersSql(database: string): string {
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

export function createMetricStreamSql(database: string): string {
  return `CREATE TABLE ${database}.metric_stream (
    id UUID,
    activity_id Nullable(UUID),
    user_id UUID,
    recorded_at DateTime64(9, 'UTC'),
    provider_id String,
    channel String,
    point Point,
    external_id Nullable(String),
    device_id Nullable(String),
    source_type Nullable(String),
    metadata String,
    ingested_at DateTime64(9, 'UTC'),
    version UInt64,
    is_deleted UInt8
  ) ENGINE = MergeTree ORDER BY (user_id, activity_id, channel, recorded_at, id, version)
    SETTINGS allow_nullable_key = 1`;
}

export function createActivityLocationMemberChangeSql(database: string): string {
  return `CREATE TABLE ${database}.activity_location_member_change (
    member_activity_id UUID,
    user_id UUID,
    changed_at SimpleAggregateFunction(max, DateTime64(9, 'UTC')),
    has_live_sample SimpleAggregateFunction(max, UInt8)
  ) ENGINE = AggregatingMergeTree ORDER BY (user_id, member_activity_id)`;
}

export function createActivityLocationMemberChangeViewSql(
  database: string,
  metricStreamTable = "metric_stream",
): string {
  return `CREATE MATERIALIZED VIEW ${database}.activity_location_member_change_ingest
    TO ${database}.activity_location_member_change AS
    SELECT
      assumeNotNull(activity_id) AS member_activity_id,
      user_id,
      max(ingested_at) AS changed_at,
      max(toUInt8(is_deleted = 0 AND point IS NOT NULL)) AS has_live_sample
    FROM ${database}.${metricStreamTable}
    WHERE activity_id IS NOT NULL
      AND channel = 'location'
      AND (point IS NOT NULL OR is_deleted = 1)
    GROUP BY user_id, member_activity_id`;
}

export function createActivitySensorSampleSql(database: string): string {
  return `CREATE TABLE ${database}.activity_sensor_sample (
    activity_id UUID,
    user_id UUID,
    recorded_at DateTime64(9, 'UTC'),
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
    refresh_version UInt64,
    is_deleted UInt8,
    refreshed_at DateTime64(9, 'UTC')
  ) ENGINE = ReplacingMergeTree(refresh_version)
    ORDER BY (user_id, activity_id, channel, recorded_at)`;
}

export function createActivitySourceRecordsSql(database: string): string {
  return `CREATE TABLE ${database}.activity_source_records (
    activity_id UUID,
    group_id Nullable(UUID),
    provider_id Nullable(String),
    user_id Nullable(UUID),
    external_id Nullable(String),
    canonical_type Nullable(String),
    provider_type Nullable(String),
    modality Nullable(String),
    started_at Nullable(DateTime64(6, 'UTC')),
    ended_at Nullable(DateTime64(6, 'UTC')),
    source_name Nullable(String),
    name Nullable(String),
    notes Nullable(String),
    timezone Nullable(String),
    start_utc_offset_minutes Nullable(Int16),
    end_utc_offset_minutes Nullable(Int16),
    local_time_source LowCardinality(String),
    raw Nullable(String),
    source_synced_at Nullable(DateTime64(9, 'UTC')),
    priority Nullable(Int32),
    refresh_version UInt64,
    is_deleted UInt8,
    refreshed_at DateTime64(9, 'UTC')
  ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY activity_id`;
}

export function createSourceActivitySql(database: string): string {
  return `CREATE TABLE ${database}.activity (
    id UUID,
    group_id Nullable(UUID),
    provider_id Nullable(String),
    user_id UUID,
    external_id Nullable(String),
    provider_absent_at Nullable(DateTime64(6, 'UTC')),
    raw Nullable(String),
    source_name Nullable(String),
    deleted_at Nullable(DateTime64(6, 'UTC')),
    _peerdb_is_deleted Int8,
    _peerdb_version Int64
  ) ENGINE = ReplacingMergeTree(_peerdb_version) ORDER BY id`;
}

export function createProducerDedupedSensorSql(database: string): string {
  return `CREATE TABLE ${database}.deduped_sensor (
    user_id UUID,
    recorded_at DateTime64(9, 'UTC'),
    recorded_date Date,
    channel String,
    scalar Nullable(Float64),
    provider_id Nullable(String),
    member_activity_id Nullable(UUID),
    device_id Nullable(String),
    source_external_id Nullable(String),
    source_type Nullable(String),
    measurement_kind LowCardinality(String),
    source_metric_stream_id Nullable(UUID),
    source_activity_id Nullable(UUID),
    provider_priority Int32,
    refresh_version UInt64,
    is_deleted UInt8,
    refreshed_at DateTime64(9, 'UTC')
  ) ENGINE = ReplacingMergeTree(refresh_version)
    ORDER BY (user_id, channel, recorded_at)`;
}

export function createActivityLocationSampleSql(database: string): string {
  return `CREATE TABLE ${database}.activity_location_sample (
    activity_id UUID,
    user_id UUID,
    recorded_at DateTime64(9, 'UTC'),
    recorded_date Date,
    source_metric_stream_id UUID,
    member_activity_id Nullable(UUID),
    provider_id Nullable(String),
    source_external_id Nullable(String),
    device_id Nullable(String),
    source_type Nullable(String),
    measurement_kind LowCardinality(String),
    lat Nullable(Float64),
    lng Nullable(Float64),
    refresh_version UInt64,
    is_deleted UInt8,
    source_refreshed_at DateTime64(9, 'UTC'),
    refreshed_at DateTime64(9, 'UTC')
  ) ENGINE = ReplacingMergeTree(refresh_version)
    ORDER BY (user_id, activity_id, source_metric_stream_id)`;
}

export function createActivityStreamPointsSql(database: string): string {
  return `CREATE TABLE ${database}.activity_stream_points (
    user_id UUID,
    activity_id UUID,
    points Array(Tuple(
      DateTime64(6, 'UTC'),
      Nullable(Float64),
      Nullable(Float64),
      Nullable(Float64),
      Nullable(Float64),
      Nullable(Float64),
      Nullable(Float64),
      Nullable(Float64)
    )),
    refresh_version UInt64,
    is_deleted UInt8,
    refreshed_at DateTime64(9, 'UTC')
  ) ENGINE = ReplacingMergeTree(refresh_version) ORDER BY (user_id, activity_id)`;
}

export function requireClickHouseUrl(): string {
  const url = process.env.CLICKHOUSE_URL?.trim();
  if (!url) throw new Error("CLICKHOUSE_URL is required");
  return url;
}
