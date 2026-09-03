import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import {
  createClickHouseTestActivitySensorStore,
  executeClickHouseTestCommand,
} from "../routers/clickhouse-integration-test-helpers.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { CyclingPerformanceRepository } from "./cycling-performance-repository.ts";

describe("CyclingPerformanceRepository integration", () => {
  let testContext: TestContext;
  let sensorStore: ActivitySensorStore;

  beforeAll(async () => {
    testContext = await setupTestDatabase();
    sensorStore = await createClickHouseTestActivitySensorStore(testContext);
  }, 60_000);

  afterAll(async () => {
    await testContext?.cleanup();
  });

  it("executes against deduped cycling and power-curve read models", async () => {
    const userId = randomUUID();
    const activityId = randomUUID();
    await executeClickHouseTestCommand(
      testContext,
      `INSERT INTO analytics.cycling_activity VALUES (
        toUUID('${activityId}'), toUUID('${userId}'), 'wahoo', ['wahoo'],
        'cycling', 'cycling', 'outdoor', 'Hilly outdoor ride',
        toDateTime64('2026-08-30 16:00:00', 6, 'UTC'),
        toDateTime64('2026-08-30 17:02:00', 6, 'UTC'),
        38066, 138.3, 170, 180, 1000, 1000, 220, 250, 736, 3720,
        190, 180, 135, 1.333, 600, 0, 1, now64(9, 'UTC')
      )`,
    );
    await executeClickHouseTestCommand(
      testContext,
      `INSERT INTO analytics.activity_power_curve VALUES
        (toUUID('${activityId}'), toUUID('${userId}'), toDateTime64('2026-08-30 16:00:00', 6, 'UTC'), '2026-08-30', 5, 900, 0, 1, now64(9, 'UTC')),
        (toUUID('${activityId}'), toUUID('${userId}'), toDateTime64('2026-08-30 16:00:00', 6, 'UTC'), '2026-08-30', 60, 500, 0, 1, now64(9, 'UTC')),
        (toUUID('${activityId}'), toUUID('${userId}'), toDateTime64('2026-08-30 16:00:00', 6, 'UTC'), '2026-08-30', 300, 300, 0, 1, now64(9, 'UTC')),
        (toUUID('${activityId}'), toUUID('${userId}'), toDateTime64('2026-08-30 16:00:00', 6, 'UTC'), '2026-08-30', 1200, 250, 0, 1, now64(9, 'UTC'))`,
    );

    const result = await new CyclingPerformanceRepository(sensorStore, userId, "UTC").listRange(
      "2026-08-30",
      "2026-09-01",
    );

    expect(result.activities).toEqual([
      expect.objectContaining({
        activity_id: activityId,
        estimated_ftp_watts: 237.5,
        intensity_factor: 0.926,
        elevation_gain_m: 736,
        best_efforts_watts: { "5s": 900, "1m": 500, "5m": 300, "20m": 250 },
      }),
    ]);
    expect(result.summary.power_coverage).toEqual({
      activities_with_power: 1,
      activities_total: 1,
      pct: 100,
    });
    expect(result.summary.power_availability_by_modality.outdoor).toEqual({
      first_observed: "2026-08-30",
      last_observed: "2026-08-30",
      activities_with_power: 1,
      activities_total: 1,
      pct: 100,
      source_providers: ["wahoo"],
    });
    expect(result.rolling_90_day_best["20m"]).toEqual({
      activity_id: activityId,
      date: "2026-08-30",
      watts: 250,
    });
  });
});
