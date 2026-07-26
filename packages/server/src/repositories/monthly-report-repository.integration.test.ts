import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import {
  createClickHouseTestActivitySensorStore,
  executeClickHouseTestCommand,
} from "../routers/clickhouse-integration-test-helpers.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { MonthlyReportRepository } from "./monthly-report-repository.ts";

const userId = "77777777-7777-4777-8777-777777777777";
const activityId = "88888888-8888-4888-8888-888888888888";

describe("MonthlyReportRepository ClickHouse read models", () => {
  let testContext: TestContext;
  let sensorStore: ActivitySensorStore;

  beforeAll(async () => {
    testContext = await setupTestDatabase();
    sensorStore = await createClickHouseTestActivitySensorStore(testContext);

    await executeClickHouseTestCommand(
      testContext,
      `INSERT INTO analytics.activity_summary (
        activity_id,
        user_id,
        activity_type,
        started_at,
        ended_at,
        avg_hr,
        max_hr
      ) VALUES (
        toUUID('${activityId}'),
        toUUID('${userId}'),
        'cycling',
        toDateTime64(toStartOfMonth(today()) + INTERVAL 5 DAY, 6, 'UTC'),
        toDateTime64(toStartOfMonth(today()) + INTERVAL 5 DAY + INTERVAL 1 HOUR, 6, 'UTC'),
        100,
        200
      )`,
    );
    await executeClickHouseTestCommand(
      testContext,
      `INSERT INTO analytics.daily_sleep (
        user_id,
        date,
        provider_id,
        started_at,
        duration_minutes,
        refresh_version,
        is_deleted,
        refreshed_at
      ) VALUES (
        toUUID('${userId}'),
        toDate(toStartOfMonth(today()) + INTERVAL 5 DAY),
        'test-provider',
        toDateTime64(toStartOfMonth(today()) + INTERVAL 5 DAY, 6, 'UTC'),
        480,
        1,
        0,
        now64(9)
      )`,
    );
    await executeClickHouseTestCommand(
      testContext,
      `INSERT INTO analytics.daily_recovery (
        user_id,
        date,
        hrv,
        resting_hr,
        is_deleted,
        refresh_version,
        refreshed_at
      ) VALUES (
        toUUID('${userId}'),
        toDate(toStartOfMonth(today()) + INTERVAL 5 DAY),
        60,
        50,
        0,
        1,
        now64(9)
      )`,
    );

    for (const recursiveView of ["v_activity", "v_sleep", "v_daily_metrics"]) {
      await executeClickHouseTestCommand(testContext, `DROP TABLE analytics.${recursiveView} SYNC`);
    }
  }, 120_000);

  afterAll(async () => {
    await testContext?.cleanup();
  });

  it("builds the report from compact serving models without recursive views", async () => {
    const report = await new MonthlyReportRepository(userId, sensorStore).getReport(12);

    expect(report.current).toEqual({
      monthStart: `${new Date().toISOString().slice(0, 7)}-01`,
      trainingHours: 1,
      activityCount: 1,
      avgDailyStrain: 30,
      avgSleepMinutes: 480,
      avgRestingHr: 50,
      avgHrv: 60,
      trainingHoursTrend: null,
      avgSleepTrend: null,
    });
    expect(report.history).toHaveLength(12);
  });
});
