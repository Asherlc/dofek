import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import {
  createClickHouseTestActivitySensorStore,
  executeClickHouseTestCommand,
} from "../routers/clickhouse-integration-test-helpers.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";

const userId = "11111111-1111-1111-1111-111111111111";
const activityId = "22222222-2222-2222-2222-222222222222";
const liveStreamActivityId = "44444444-4444-4444-4444-444444444444";
const liveZoneActivityId = "55555555-5555-5555-5555-555555555555";
const staggeredStreamActivityId = "66666666-6666-6666-6666-666666666666";
const powerActivityId = "77777777-7777-7777-7777-777777777777";
const overlappingPowerActivityId = "88888888-8888-8888-8888-888888888888";
const window = {
  activityId,
  userId,
  startedAt: "2026-07-01T12:00:00.000Z",
  endedAt: "2026-07-01T13:00:00.000Z",
  memberActivityIds: [activityId],
};
const liveStreamWindow = {
  ...window,
  activityId: liveStreamActivityId,
  memberActivityIds: [liveStreamActivityId],
};
const liveZoneWindow = {
  ...window,
  activityId: liveZoneActivityId,
  memberActivityIds: [liveZoneActivityId],
};
const staggeredStreamWindow = {
  ...window,
  activityId: staggeredStreamActivityId,
  memberActivityIds: [staggeredStreamActivityId],
};
const powerWindow = {
  ...window,
  activityId: powerActivityId,
  memberActivityIds: [powerActivityId, overlappingPowerActivityId],
};

describe("ClickHouseActivitySensorStore read-model lifecycle rows", () => {
  let testContext: TestContext;
  let sensorStore: ActivitySensorStore;

  beforeAll(async () => {
    testContext = await setupTestDatabase();
    sensorStore = await createClickHouseTestActivitySensorStore(testContext);
  });

  afterAll(async () => {
    await testContext?.cleanup();
  });

  it("serves live stream points when the latest row is not a tombstone", async () => {
    await executeClickHouseTestCommand(
      testContext,
      `
        INSERT INTO analytics.activity_stream_points (
          user_id, activity_id, points, refresh_version, is_deleted, refreshed_at
        ) VALUES
        (
          toUUID('${userId}'),
          toUUID('${liveStreamActivityId}'),
          [(parseDateTime64BestEffort('2026-07-01T12:15:00.000Z', 6, 'UTC'), 150, NULL, NULL, NULL, NULL, NULL, NULL)],
          1,
          0,
          toDateTime64('2026-07-01 12:15:00', 9, 'UTC')
        )
      `,
    );

    await expect(sensorStore.getStream(liveStreamWindow, 500)).resolves.toEqual([
      {
        recorded_at: "2026-07-01T12:15:00.000Z",
        heart_rate: 150,
        power: null,
        speed: null,
        cadence: null,
        altitude: null,
        lat: null,
        lng: null,
      },
    ]);
  });

  it("preserves staggered sensor channels when downsampling stream points", async () => {
    await executeClickHouseTestCommand(
      testContext,
      `
        INSERT INTO analytics.activity_stream_points (
          user_id, activity_id, points, refresh_version, is_deleted, refreshed_at
        )
        SELECT
          toUUID('${userId}'),
          toUUID('${staggeredStreamActivityId}'),
          groupArray(tuple(
            addMilliseconds(
              toDateTime64('2026-07-01 12:15:00', 6, 'UTC'),
              sample_index * 100
            ),
            if(
              sample_index % 2 = 0,
              CAST(100 + sample_index AS Nullable(Float64)),
              CAST(NULL AS Nullable(Float64))
            ),
            CAST(NULL AS Nullable(Float64)),
            if(
              sample_index % 2 = 1,
              CAST(sample_index AS Nullable(Float64)),
              CAST(NULL AS Nullable(Float64))
            ),
            CAST(NULL AS Nullable(Float64)),
            CAST(NULL AS Nullable(Float64)),
            if(
              sample_index % 10 = 5,
              CAST(37 + sample_index / 100 AS Nullable(Float64)),
              CAST(NULL AS Nullable(Float64))
            ),
            if(
              sample_index % 10 = 5,
              CAST(-122 - sample_index / 100 AS Nullable(Float64)),
              CAST(NULL AS Nullable(Float64))
            )
          )),
          1,
          0,
          toDateTime64('2026-07-01 12:15:10', 9, 'UTC')
        FROM (
          SELECT number AS sample_index
          FROM numbers(100)
          ORDER BY sample_index
        )
      `,
    );

    const points = await sensorStore.getStream(staggeredStreamWindow, 10);

    expect(points).toHaveLength(10);
    expect(
      points.slice(0, -1).every((point) => point.heart_rate != null && point.speed != null),
    ).toBe(true);
    expect(points[0]).toMatchObject({
      heart_rate: 100,
      speed: 1,
      lat: 37.05,
      lng: -122.05,
    });
  });

  it("does not serve stale stream points when the latest row is a tombstone", async () => {
    await executeClickHouseTestCommand(
      testContext,
      `
        INSERT INTO analytics.activity_stream_points (
          user_id, activity_id, points, refresh_version, is_deleted, refreshed_at
        ) VALUES
        (
          toUUID('${userId}'),
          toUUID('${activityId}'),
          [(parseDateTime64BestEffort('2026-07-01T12:15:00.000Z', 6, 'UTC'), 150, NULL, NULL, NULL, NULL, NULL, NULL)],
          1,
          0,
          toDateTime64('2026-07-01 12:15:00', 9, 'UTC')
        ),
        (
          toUUID('${userId}'),
          toUUID('${activityId}'),
          [],
          2,
          1,
          toDateTime64('2026-07-01 12:16:00', 9, 'UTC')
        )
      `,
    );

    await expect(sensorStore.getStream(window, 500)).resolves.toEqual([]);
  });

  it("serves live heart-rate zones when the latest row is not a tombstone", async () => {
    await executeClickHouseTestCommand(
      testContext,
      `
        INSERT INTO analytics.activity_heart_rate_zones (
          user_id, activity_id, zones, refresh_version, is_deleted, refreshed_at
        ) VALUES
        (
          toUUID('${userId}'),
          toUUID('${liveZoneActivityId}'),
          [(0, 60)],
          1,
          0,
          toDateTime64('2026-07-01 12:15:00', 9, 'UTC')
        )
      `,
    );

    await expect(sensorStore.getHeartRateZoneSeconds(liveZoneWindow)).resolves.toEqual([
      { zone: 0, seconds: 60 },
    ]);
  });

  it("does not serve stale heart-rate zones when the latest row is a tombstone", async () => {
    await executeClickHouseTestCommand(
      testContext,
      `
        INSERT INTO analytics.activity_heart_rate_zones (
          user_id, activity_id, zones, refresh_version, is_deleted, refreshed_at
        ) VALUES
        (
          toUUID('${userId}'),
          toUUID('${activityId}'),
          [(0, 60)],
          1,
          0,
          toDateTime64('2026-07-01 12:15:00', 9, 'UTC')
        ),
        (
          toUUID('${userId}'),
          toUUID('${activityId}'),
          [],
          2,
          1,
          toDateTime64('2026-07-01 12:16:00', 9, 'UTC')
        )
      `,
    );

    await expect(sensorStore.getHeartRateZoneSeconds(window)).resolves.toEqual([]);
  });

  it("does not mix power samples from another same-user activity with an overlapping window", async () => {
    await executeClickHouseTestCommand(
      testContext,
      `
        INSERT INTO analytics.activity_sensor_sample (
          activity_id, user_id, recorded_at, recorded_date, channel, scalar,
          refresh_version, is_deleted, refreshed_at
        ) VALUES
        (
          toUUID('${powerActivityId}'),
          toUUID('${userId}'),
          toDateTime64('2026-07-01 12:15:00', 6, 'UTC'),
          toDate('2026-07-01'),
          'power',
          100,
          1,
          0,
          toDateTime64('2026-07-01 12:15:00', 9, 'UTC')
        ),
        (
          toUUID('${overlappingPowerActivityId}'),
          toUUID('${userId}'),
          toDateTime64('2026-07-01 12:15:00', 6, 'UTC'),
          toDate('2026-07-01'),
          'power',
          400,
          1,
          0,
          toDateTime64('2026-07-01 12:15:00', 9, 'UTC')
        )
      `,
    );

    const zones = await sensorStore.getPowerZoneSeconds(powerWindow, 200);

    expect(zones.find((zone) => zone.zone === 1)?.seconds).toBe(1);
    expect(zones.find((zone) => zone.zone === 7)?.seconds).toBe(0);
  });
});
