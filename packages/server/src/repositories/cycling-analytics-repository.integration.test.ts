import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { ChartRange } from "../lib/chart-range.ts";
import {
  createClickHouseTestActivitySensorStore,
  executeClickHouseTestCommand,
} from "../routers/clickhouse-integration-test-helpers.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { CyclingAnalyticsRepository } from "./cycling-analytics-repository.ts";

const ACTIVITY_ID = "11111111-1111-4111-8111-111111111111";

describe("CyclingAnalyticsRepository ClickHouse serving models", () => {
  let testContext: TestContext;
  let sensorStore: ActivitySensorStore;

  beforeAll(async () => {
    testContext = await setupTestDatabase();
    sensorStore = await createClickHouseTestActivitySensorStore(testContext);
    await executeClickHouseTestCommand(
      testContext,
      `INSERT INTO analytics.cycling_activity VALUES (
        toUUID('${ACTIVITY_ID}'),
        toUUID('${TEST_USER_ID}'),
        'wahoo',
        ['wahoo'],
        'cycling',
        'Threshold Intervals',
        now64(6, 'UTC') - INTERVAL 2 DAY,
        now64(6, 'UTC') - INTERVAL 2 DAY + INTERVAL 1 HOUR,
        40000,
        150,
        180,
        250,
        3600,
        3600,
        280,
        300,
        500,
        3600,
        190,
        180,
        135,
        1.333,
        600,
        0,
        1,
        now64(9, 'UTC')
      )`,
    );
    await executeClickHouseTestCommand(
      testContext,
      `INSERT INTO analytics.daily_cycling VALUES (
        toUUID('${TEST_USER_ID}'),
        today() - INTERVAL 2 DAY,
        [tuple(
          toUUID('${ACTIVITY_ID}'),
          now64(6, 'UTC') - INTERVAL 2 DAY,
          toFloat64(60),
          toFloat64(150),
          toFloat64(180),
          CAST(250, 'Nullable(Float64)'),
          toUInt64(3600),
          toUInt64(3600),
          CAST(280, 'Nullable(Float64)'),
          CAST('Threshold Intervals', 'Nullable(String)')
        )],
        0,
        1,
        now64(9, 'UTC')
      )`,
    );
    await executeClickHouseTestCommand(
      testContext,
      `INSERT INTO analytics.activity_power_curve VALUES
        (toUUID('${ACTIVITY_ID}'), toUUID('${TEST_USER_ID}'), now64(6, 'UTC') - INTERVAL 2 DAY, toString(today() - INTERVAL 2 DAY), 300, 400, 0, 1, now64(9, 'UTC')),
        (toUUID('${ACTIVITY_ID}'), toUUID('${TEST_USER_ID}'), now64(6, 'UTC') - INTERVAL 2 DAY, toString(today() - INTERVAL 2 DAY), 1200, 300, 0, 1, now64(9, 'UTC'))`,
    );
  }, 60_000);

  afterAll(async () => {
    await testContext?.cleanup();
  });

  it("serves the full cycling page in three ClickHouse statements", async () => {
    const querySpy = vi.spyOn(sensorStore, "query");
    const repository = new CyclingAnalyticsRepository(
      testContext.db,
      TEST_USER_ID,
      "UTC",
      sensorStore,
    );

    const performance = await repository.getPerformance(ChartRange.fromDays(90));
    const activities = await repository.getActivities(ChartRange.fromDays(90), {
      activityLimit: 20,
      activityOffset: 0,
      variabilityLimit: 20,
      variabilityOffset: 0,
    });

    expect(querySpy).toHaveBeenCalledTimes(3);
    expect(performance.powerCurve.recent.points).toEqual(
      expect.arrayContaining([expect.objectContaining({ durationSeconds: 300, bestPower: 400 })]),
    );
    expect(performance.eftpTrend.currentEftp).toBeGreaterThan(0);
    expect(activities.activities.items[0]?.name).toBe("Threshold Intervals");
    expect(activities.variability.rows[0]?.variabilityIndex).toBe(1.12);
    expect(activities.verticalAscent[0]?.verticalAscentRate).toBe(500);
    expect(activities.aerobicEfficiency.activities[0]?.efficiencyFactor).toBe(1.333);
  });
});
