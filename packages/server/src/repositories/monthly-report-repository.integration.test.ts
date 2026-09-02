import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { dateStringSchema } from "../lib/typed-sql.ts";
import {
  createClickHouseTestActivitySensorStore,
  executeClickHouseTestCommand,
  getClickHouseTestClient,
} from "../routers/clickhouse-integration-test-helpers.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { MonthlyReportRepository } from "./monthly-report-repository.ts";

const userId = "77777777-7777-4777-8777-777777777777";
const activityId = "88888888-8888-4888-8888-888888888888";

describe("MonthlyReportRepository ClickHouse read models", () => {
  let testContext: TestContext;
  let sensorStore: ActivitySensorStore;
  let monthStart: string;
  let endDate: string;

  beforeAll(async () => {
    testContext = await setupTestDatabase();
    sensorStore = await createClickHouseTestActivitySensorStore(testContext);
    const monthResult = await getClickHouseTestClient(testContext).query({
      query:
        "SELECT toString(toStartOfMonth(today())) AS month_start, toString(toStartOfMonth(today()) + INTERVAL 6 DAY) AS end_date",
      format: "JSONEachRow",
    });
    const [monthRow] = z
      .array(z.object({ month_start: dateStringSchema, end_date: dateStringSchema }))
      .parse(await monthResult.json());
    if (!monthRow) {
      throw new Error("ClickHouse did not return its current month");
    }
    monthStart = monthRow.month_start;
    endDate = monthRow.end_date;

    await executeClickHouseTestCommand(
      testContext,
      `INSERT INTO analytics.activity_summary (
        activity_id,
        user_id,
        canonical_type,
        started_at,
        ended_at,
        avg_hr,
        max_hr
      ) VALUES (
        toUUID('${activityId}'),
        toUUID('${userId}'),
        'cycling',
        toDateTime64(toDate('${monthStart}') + INTERVAL 5 DAY, 6, 'UTC'),
        toDateTime64(toDate('${monthStart}') + INTERVAL 5 DAY + INTERVAL 1 HOUR, 6, 'UTC'),
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
        toDate('${monthStart}') + INTERVAL 5 DAY,
        'test-provider',
        toDateTime64(toDate('${monthStart}') + INTERVAL 5 DAY, 6, 'UTC'),
        300,
        1,
        0,
        now64(9)
      ), (
        toUUID('${userId}'),
        toDate('${monthStart}') + INTERVAL 5 DAY,
        'test-provider',
        toDateTime64(toDate('${monthStart}') + INTERVAL 5 DAY, 6, 'UTC'),
        480,
        2,
        0,
        now64(9)
      ), (
        toUUID('${userId}'),
        toDate('${monthStart}') + INTERVAL 6 DAY,
        'test-provider',
        toDateTime64(toDate('${monthStart}') + INTERVAL 6 DAY, 6, 'UTC'),
        600,
        1,
        0,
        now64(9)
      ), (
        toUUID('${userId}'),
        toDate('${monthStart}') + INTERVAL 6 DAY,
        'test-provider',
        toDateTime64(toDate('${monthStart}') + INTERVAL 6 DAY, 6, 'UTC'),
        600,
        2,
        1,
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
        toDate('${monthStart}') + INTERVAL 5 DAY,
        40,
        60,
        0,
        1,
        now64(9)
      ), (
        toUUID('${userId}'),
        toDate('${monthStart}') + INTERVAL 5 DAY,
        60,
        50,
        0,
        2,
        now64(9)
      ), (
        toUUID('${userId}'),
        toDate('${monthStart}') + INTERVAL 6 DAY,
        80,
        45,
        0,
        1,
        now64(9)
      ), (
        toUUID('${userId}'),
        toDate('${monthStart}') + INTERVAL 6 DAY,
        80,
        45,
        1,
        2,
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
    const report = await new MonthlyReportRepository(userId, sensorStore).getReport(12, endDate);

    expect(report.current).toEqual({
      monthStart,
      trainingHours: 1,
      activityCount: 1,
      avgDailyStrain: 30,
      avgSleepMinutes: 480,
      avgRestingHr: 50,
      avgHrv: 60,
      trainingHoursTrend: null,
      avgSleepTrend: null,
    });
    expect(report.history).toHaveLength(11);
  });

  it("transitions from the preview to a report after one observed day", async () => {
    const transitionUserId = randomUUID();
    const repository = new MonthlyReportRepository(transitionUserId, sensorStore);
    const emptyReport = await repository.getReport(12, endDate);

    expect(emptyReport.current).toBeNull();
    expect(emptyReport.history).toEqual([]);
    expect(emptyReport.emptyState).toEqual(
      expect.objectContaining({
        reportKind: "monthly",
        minimumObservedDays: 1,
      }),
    );
    expect(emptyReport.decisionSupport).toBeNull();

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
        toUUID('${transitionUserId}'),
        toDate('${monthStart}') + INTERVAL 5 DAY,
        55,
        51,
        0,
        1,
        now64(9)
      )`,
    );

    const report = await repository.getReport(12, endDate);

    expect(report.current).toEqual(
      expect.objectContaining({
        monthStart,
        avgRestingHr: 51,
        avgHrv: 55,
      }),
    );
  });
});
