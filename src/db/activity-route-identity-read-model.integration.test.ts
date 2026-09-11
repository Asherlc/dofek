import { randomUUID } from "node:crypto";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  activityId,
  buildModel,
  memberId,
  otherUserId,
  readRouteIdentity,
  renderModel,
  secondActivityId,
  seedRouteIdentityFixture,
  seedSchema,
  userId,
} from "./activity-route-identity-test-helpers.ts";

describe("activity route identity read model", () => {
  const database = `activity_route_identity_${randomUUID().replaceAll("-", "")}`;
  let client: ReturnType<typeof createClient>;

  beforeAll(async () => {
    const url = process.env.CLICKHOUSE_URL?.trim();
    if (!url) throw new Error("CLICKHOUSE_URL is required for activity route identity tests");
    client = createClient({ url, request_timeout: 120_000 });
    await client.query({ query: "SELECT 1", format: "JSONEachRow" });
    await seedSchema(client, database);
  }, 120_000);

  beforeEach(async () => {
    for (const table of [
      "deduped_activities",
      "activity_location_sample",
      "activity_effort_identity",
      "activity_route_identity",
      "activity_sensor_sample",
    ]) {
      await client.command({ query: `TRUNCATE TABLE ${database}.${table}` });
    }
  });

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client.close();
  });

  it("marks a one-percent fragment and a large internal gap as partial", async () => {
    await seedRouteIdentityFixture(client, database, {
      provider: "strava",
      routeId: null,
      durationSeconds: 3000,
    });
    await seedRouteIdentityFixture(client, database, {
      provider: "strava",
      routeId: null,
      activityId: secondActivityId,
      seconds: [0, 10, 20, 3000],
    });
    await buildModel(client, database);
    expect(await readRouteIdentity(client, database)).toMatchObject({
      coveragePct: 1,
      geometryStatus: "partial",
    });
    expect(await readRouteIdentity(client, database, secondActivityId)).toMatchObject({
      largestGapSeconds: 2980,
      geometryStatus: "partial",
    });
  });

  it("retains deduplicated altitude evidence and refreshes a changed profile", async () => {
    await seedRouteIdentityFixture(client, database, { provider: "strava", routeId: null });
    await client.command({
      query: `INSERT INTO ${database}.activity_sensor_sample SELECT toUUID('${activityId}'), toUUID('${userId}'), addSeconds(toDateTime64('2026-09-01 12:00:00', 6, 'UTC'), number * 10), 'altitude', 100 + number * 5, 0, toDateTime64('2026-09-01 12:00:00', 9, 'UTC') FROM numbers(4)`,
    });
    await buildModel(client, database);
    expect(await readRouteIdentity(client, database)).toMatchObject({
      elevationProfile: [100, 105, 110, 115],
    });
    await client.command({ query: `TRUNCATE TABLE ${database}.activity_sensor_sample` });
    await client.command({
      query: `INSERT INTO ${database}.activity_sensor_sample SELECT toUUID('${activityId}'), toUUID('${userId}'), addSeconds(toDateTime64('2026-09-01 12:00:00', 6, 'UTC'), number * 10), 'altitude', 200 + number * 5, 0, toDateTime64('2026-09-01 12:30:00', 9, 'UTC') FROM numbers(4)`,
    });
    await buildModel(client, database, true);
    expect(await readRouteIdentity(client, database)).toMatchObject({
      elevationProfile: [200, 205, 210, 215],
    });
  });

  it("bounds a dense altitude profile before joining route intervals", async () => {
    await seedRouteIdentityFixture(client, database, {
      provider: "strava",
      routeId: null,
      pointCount: 80,
    });
    await client.command({
      query: `INSERT INTO ${database}.activity_sensor_sample
      SELECT toUUID('${activityId}'), toUUID('${userId}'),
        addSeconds(toDateTime64('2026-09-01 12:00:00', 6, 'UTC'), number),
        'altitude', 100 + number, 0,
        toDateTime64('2026-09-01 12:00:00', 9, 'UTC')
      FROM numbers(128)`,
    });

    await buildModel(client, database);

    const row = await readRouteIdentity(client, database);
    expect(row.elevationProfile).toHaveLength(64);
    expect(row.elevationProfile.at(0)).toBe(100);
    expect(row.elevationProfile.at(-1)).toBe(227);
    expect(row.routeDistanceMeters).toBeGreaterThan(0);
  });

  it("removes deleted altitude evidence even when location data has a newer watermark", async () => {
    await seedRouteIdentityFixture(client, database, { provider: "strava", routeId: null });
    await client.command({
      query: `INSERT INTO ${database}.activity_location_sample
      SELECT * REPLACE(
        toUInt64(2) AS refresh_version,
        toDateTime64('2026-09-01 12:30:00', 9, 'UTC') AS source_refreshed_at,
        toDateTime64('2026-09-01 12:30:00', 9, 'UTC') AS refreshed_at
      )
      FROM ${database}.activity_location_sample FINAL
      WHERE activity_id = '${activityId}'`,
    });
    await client.command({
      query: `INSERT INTO ${database}.activity_sensor_sample
      SELECT toUUID('${activityId}'), toUUID('${userId}'),
        addSeconds(toDateTime64('2026-09-01 12:00:00', 6, 'UTC'), number * 10),
        'altitude', 100 + number * 5, 0,
        toDateTime64('2026-09-01 12:00:00', 9, 'UTC')
      FROM numbers(4)`,
    });
    await buildModel(client, database);
    expect(await readRouteIdentity(client, database)).toMatchObject({
      elevationProfile: [100, 105, 110, 115],
    });

    await client.command({
      query: `INSERT INTO ${database}.activity_sensor_sample
      SELECT * REPLACE(
        CAST(NULL, 'Nullable(Float64)') AS scalar,
        toUInt8(1) AS is_deleted,
        toDateTime64('2026-09-01 12:10:00', 9, 'UTC') AS refreshed_at
      )
      FROM ${database}.activity_sensor_sample FINAL
      WHERE activity_id = '${activityId}' AND channel = 'altitude'`,
    });
    await buildModel(client, database, true);

    expect(await readRouteIdentity(client, database)).toMatchObject({ elevationProfile: [] });
  });

  it("keeps an explicit provider route ID separate from normalized geometry", async () => {
    await seedRouteIdentityFixture(client, database, { provider: "ridewithgps", routeId: "rw-42" });

    await buildModel(client, database);

    expect(await readRouteIdentity(client, database)).toEqual(
      expect.objectContaining({
        canonicalActivityId: activityId,
        explicitProviderRouteIds: [
          {
            provider: "ridewithgps",
            value: "rw-42",
            sourceActivityId: activityId,
            field: "routeId",
          },
        ],
        direction: "forward",
        pointCount: 4,
        routeDistanceMeters: expect.any(Number),
        coveragePct: 100,
        largestGapSeconds: 10,
        sourceProviders: ["ridewithgps"],
        sourceDevices: ["head-unit"],
        geometryStatus: "available",
        isDeleted: 0,
      }),
    );
  });

  it("materializes direction-preserving and reverse bounded fingerprints", async () => {
    await seedRouteIdentityFixture(client, database, {
      provider: "strava",
      routeId: null,
      pointCount: 80,
    });

    await buildModel(client, database);

    const row = await readRouteIdentity(client, database);
    expect(row).toEqual(
      expect.objectContaining({
        explicitProviderRouteIds: [],
        pointCount: 64,
        routeFingerprint: expect.any(String),
        reverseRouteFingerprint: expect.any(String),
        geometryStatus: "available",
      }),
    );
    expect(row.routeFingerprint).not.toBe(row.reverseRouteFingerprint);
  });

  it("tombstones a current route when its deduplicated geometry disappears", async () => {
    await seedRouteIdentityFixture(client, database, { provider: "ridewithgps", routeId: "rw-42" });
    await buildModel(client, database);
    const deletedPoints = Array.from({ length: 4 }, (_, index) => {
      const pointId = `00000000-0000-4000-8000-${String(201 + index).padStart(12, "0")}`;
      return `('${activityId}', '${userId}',
        addSeconds(toDateTime64('2026-09-01 12:00:00', 6, 'UTC'), ${index * 10}), '${pointId}',
        'ridewithgps', 'head-unit', NULL, NULL, toDateTime64('2026-09-01 12:10:00', 9, 'UTC'),
        2, 1, toDateTime64('2026-09-01 12:10:00', 9, 'UTC'))`;
    });
    await client.command({
      query: `INSERT INTO ${database}.activity_location_sample
        (activity_id, user_id, recorded_at, source_metric_stream_id, provider_id, device_id, lat, lng,
         source_refreshed_at, refresh_version, is_deleted, refreshed_at)
        VALUES ${deletedPoints.join(",")}`,
    });

    await buildModel(client, database, true);

    expect(await readRouteIdentity(client, database)).toEqual(
      expect.objectContaining({ isDeleted: 1 }),
    );
  });

  it("tombstones a current route when refreshed coordinates become invalid", async () => {
    await seedRouteIdentityFixture(client, database, { provider: "strava", routeId: null });
    await buildModel(client, database);

    await client.command({
      query: `INSERT INTO ${database}.activity_location_sample
      SELECT * REPLACE(
        toNullable(toFloat64(95)) AS lat,
        toUInt64(2) AS refresh_version,
        toDateTime64('2026-09-01 12:10:00', 9, 'UTC') AS source_refreshed_at,
        toDateTime64('2026-09-01 12:10:00', 9, 'UTC') AS refreshed_at
      )
      FROM ${database}.activity_location_sample FINAL
      WHERE activity_id = '${activityId}'`,
    });
    await buildModel(client, database, true);

    expect(await readRouteIdentity(client, database)).toMatchObject({
      geometryStatus: "unavailable",
      isDeleted: 1,
    });
  });

  it("tombstones a current route when refreshed coordinates fall outside the activity window", async () => {
    await seedRouteIdentityFixture(client, database, { provider: "strava", routeId: null });
    await buildModel(client, database);

    await client.command({
      query: `INSERT INTO ${database}.activity_location_sample
      SELECT * REPLACE(
        CAST(NULL, 'Nullable(Float64)') AS lat,
        CAST(NULL, 'Nullable(Float64)') AS lng,
        toUInt64(2) AS refresh_version,
        toUInt8(1) AS is_deleted,
        toDateTime64('2026-09-01 12:10:00', 9, 'UTC') AS source_refreshed_at,
        toDateTime64('2026-09-01 12:10:00', 9, 'UTC') AS refreshed_at
      )
      FROM ${database}.activity_location_sample FINAL
      WHERE activity_id = '${activityId}'`,
    });
    await client.command({
      query: `INSERT INTO ${database}.activity_location_sample
      SELECT toUUID('${activityId}'), toUUID('${userId}'),
        addSeconds(toDateTime64('2026-09-01 13:00:00', 6, 'UTC'), number * 10),
        generateUUIDv4(), 'strava', 'head-unit', 37.8, -122.4,
        toDateTime64('2026-09-01 12:10:00', 9, 'UTC'), 2, 0,
        toDateTime64('2026-09-01 12:10:00', 9, 'UTC')
      FROM numbers(4)`,
    });
    await buildModel(client, database, true);

    expect(await readRouteIdentity(client, database)).toMatchObject({
      geometryStatus: "unavailable",
      isDeleted: 1,
    });
  });

  it.each([false, true])(
    "limits a scoped build to member-resolved canonical keys (incremental=%s)",
    async (incremental) => {
      await seedRouteIdentityFixture(client, database, {
        provider: "ridewithgps",
        routeId: "rw-42",
        memberIds: [memberId],
      });
      await seedRouteIdentityFixture(client, database, {
        provider: "strava",
        routeId: null,
        activityId: secondActivityId,
      });
      await seedRouteIdentityFixture(client, database, {
        provider: "strava",
        routeId: null,
        userId: otherUserId,
      });

      await buildModel(client, database, incremental, [memberId]);

      const result = await client.query({
        query: `SELECT toString(user_id) AS userId, toString(activity_id) AS activityId FROM ${database}.activity_route_identity FINAL`,
        format: "JSONEachRow",
      });
      expect(await result.json()).toEqual([{ userId, activityId }]);
    },
  );

  it("tombstones scoped prior keys after activity removal without touching another deleted route", async () => {
    await seedRouteIdentityFixture(client, database, { provider: "ridewithgps", routeId: "rw-42" });
    await seedRouteIdentityFixture(client, database, {
      provider: "strava",
      routeId: null,
      activityId: secondActivityId,
    });
    await buildModel(client, database);
    await client.command({ query: `TRUNCATE TABLE ${database}.deduped_activities` });

    await buildModel(client, database, true, [activityId]);

    expect(await readRouteIdentity(client, database)).toMatchObject({
      isDeleted: 1,
      geometryStatus: "unavailable",
    });
    expect(await readRouteIdentity(client, database, secondActivityId)).toMatchObject({
      isDeleted: 0,
      geometryStatus: "available",
    });
  });

  it("keeps scoped location reads below the unrelated route history size", async () => {
    await seedRouteIdentityFixture(client, database, { provider: "ridewithgps", routeId: "rw-42" });
    await seedRouteIdentityFixture(client, database, {
      provider: "strava",
      routeId: null,
      activityId: secondActivityId,
    });
    await client.command({
      query: `INSERT INTO ${database}.activity_location_sample
      SELECT toUUID('${secondActivityId}'), toUUID('${userId}'),
        addSeconds(toDateTime64('2026-09-01 13:00:00', 6, 'UTC'), number), generateUUIDv4(),
        'strava', 'head-unit', 37.8, -122.4,
        toDateTime64('2026-09-01 12:00:00', 9, 'UTC'), 1, 0,
        toDateTime64('2026-09-01 12:00:00', 9, 'UTC')
      FROM numbers(100000)`,
    });
    await client.command({
      query: `INSERT INTO ${database}.activity_route_identity ${renderModel(database, true, [activityId])}`,
      clickhouse_settings: { max_rows_to_read: "50000" },
    });
    expect(await readRouteIdentity(client, database)).toMatchObject({
      pointCount: 4,
      isDeleted: 0,
    });
  });

  it("retains the same explicit provider route claim on two distinct canonical activities", async () => {
    for (const id of [activityId, secondActivityId]) {
      await seedRouteIdentityFixture(client, database, {
        provider: "ridewithgps",
        routeId: "rw-42",
        activityId: id,
      });
    }
    await buildModel(client, database);
    for (const id of [activityId, secondActivityId]) {
      expect(await readRouteIdentity(client, database, id)).toMatchObject({
        canonicalActivityId: id,
        explicitProviderRouteIds: [
          { provider: "ridewithgps", value: "rw-42", sourceActivityId: id, field: "routeId" },
        ],
        pointCount: 4,
        isDeleted: 0,
      });
    }
  });

  it("refreshes only dirty geometry and leaves clean route versions unchanged", async () => {
    for (const id of [activityId, secondActivityId]) {
      await seedRouteIdentityFixture(client, database, {
        provider: "ridewithgps",
        routeId: "rw-42",
        activityId: id,
      });
    }
    await buildModel(client, database);
    await buildModel(client, database, true);
    const unchanged = await client.query({
      query: `SELECT count() AS count FROM ${database}.activity_route_identity`,
      format: "JSONEachRow",
    });
    expect(await unchanged.json()).toEqual([{ count: 2 }]);
    await client.command({
      query: `INSERT INTO ${database}.activity_location_sample
      SELECT * REPLACE(lat + 0.01 AS lat, toUInt64(2) AS refresh_version,
        toDateTime64('2026-09-01 12:10:00', 9, 'UTC') AS source_refreshed_at,
        toDateTime64('2026-09-01 12:10:00', 9, 'UTC') AS refreshed_at)
      FROM ${database}.activity_location_sample FINAL WHERE activity_id = '${activityId}'`,
    });
    await buildModel(client, database, true);
    const versions = await client.query({
      query: `SELECT toString(activity_id) AS activityId, count() AS count FROM ${database}.activity_route_identity GROUP BY activity_id ORDER BY activity_id`,
      format: "JSONEachRow",
    });
    expect(await versions.json()).toEqual([
      { activityId, count: 2 },
      { activityId: secondActivityId, count: 1 },
    ]);
    expect((await readRouteIdentity(client, database)).points[0]).toEqual({
      lat: 37.7849,
      lng: -122.4194,
    });
    expect((await readRouteIdentity(client, database, secondActivityId)).points[0]).toEqual({
      lat: 37.7749,
      lng: -122.4194,
    });
  });

  it.each([
    { name: "nearby inferred geometry", offset: 0.00001, detour: false },
    { name: "similar endpoints with a different middle", offset: 0, detour: true },
    { name: "different geometry", offset: 1, detour: false },
  ])("materializes independent route evidence for $name", async ({ offset, detour }) => {
    const points = [
      { lat: 37.77, lng: -122.42 },
      { lat: 37.78, lng: -122.42 },
      { lat: 37.79, lng: -122.42 },
      { lat: 37.8, lng: -122.42 },
    ];
    await seedRouteIdentityFixture(client, database, {
      provider: "ridewithgps",
      routeId: "rw-42",
      points,
    });
    await seedRouteIdentityFixture(client, database, {
      provider: "strava",
      routeId: null,
      activityId: secondActivityId,
      points: points.map((point, index) => ({
        lat: point.lat + offset,
        lng: point.lng + (detour && index > 0 && index < 3 ? 0.01 : 0),
      })),
      seconds: [0, 10, 20, 120],
    });
    await buildModel(client, database);
    const left = await readRouteIdentity(client, database);
    const right = await readRouteIdentity(client, database, secondActivityId);
    expect(left).toMatchObject({
      canonicalActivityId: activityId,
      explicitProviderRouteIds: [
        { provider: "ridewithgps", value: "rw-42", sourceActivityId: activityId, field: "routeId" },
      ],
      points,
      coveragePct: 100,
      largestGapSeconds: 10,
      elevationProfile: [],
    });
    expect(right).toMatchObject({
      canonicalActivityId: secondActivityId,
      explicitProviderRouteIds: [],
      coveragePct: 100 / 6,
      largestGapSeconds: 100,
      sourceProviders: ["strava"],
      sourceDevices: ["head-unit"],
    });
    expect(right.routeFingerprint).not.toBe(left.routeFingerprint);
  });
});
