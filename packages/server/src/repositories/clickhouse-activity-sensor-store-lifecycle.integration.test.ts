import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import {
  createClickHouseTestActivitySensorStore,
  executeClickHouseTestCommand,
} from "../routers/clickhouse-integration-test-helpers.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";

const userId = "11111111-1111-1111-1111-111111111111";
const activityId = "22222222-2222-2222-2222-222222222222";
const window = {
  activityId,
  userId,
  startedAt: "2026-07-01T12:00:00.000Z",
  endedAt: "2026-07-01T13:00:00.000Z",
  memberActivityIds: [activityId],
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
});
