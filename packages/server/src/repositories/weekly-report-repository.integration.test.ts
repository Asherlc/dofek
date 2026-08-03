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
import { WeeklyReportRepository } from "./weekly-report-repository.ts";

const userId = "99999999-9999-4999-8999-999999999999";
const boundaryUserId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const activityId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const boundaryActivityId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const boundaryActivityStartedAt = "2026-07-19 05:30:00";
const boundaryRequestTimezone = "Asia/Tokyo";
const endDate = "2026-07-25";

describe("WeeklyReportRepository ClickHouse read models", () => {
  let testContext: TestContext;
  let sensorStore: ActivitySensorStore;
  let weekStart: string;
  let boundaryWeekStart: string;
  let requestTimezoneWeekStart: string;

  beforeAll(async () => {
    testContext = await setupTestDatabase();
    sensorStore = await createClickHouseTestActivitySensorStore(testContext);
    const weekResult = await getClickHouseTestClient(testContext).query({
      query: `SELECT
        toString(toStartOfWeek(toDate('${endDate}'), 0)) AS week_start,
        toString(
          toStartOfWeek(
            toDate(toDateTime64('${boundaryActivityStartedAt}', 6, 'UTC') - INTERVAL 6 HOUR),
            0
          )
        ) AS boundary_week_start,
        toString(
          toStartOfWeek(
            toDate(
              toTimeZone(
                toDateTime64('${boundaryActivityStartedAt}', 6, 'UTC'),
                '${boundaryRequestTimezone}'
              )
            ),
            0
          )
        ) AS request_timezone_week_start`,
      format: "JSONEachRow",
    });
    const [weekRow] = z
      .array(
        z.object({
          week_start: dateStringSchema,
          boundary_week_start: dateStringSchema,
          request_timezone_week_start: dateStringSchema,
        }),
      )
      .parse(await weekResult.json());
    if (!weekRow) {
      throw new Error("ClickHouse did not return the report week");
    }
    weekStart = weekRow.week_start;
    boundaryWeekStart = weekRow.boundary_week_start;
    requestTimezoneWeekStart = weekRow.request_timezone_week_start;

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
        toDateTime64(toDate('${endDate}') - INTERVAL 2 DAY, 6, 'UTC'),
        toDateTime64(toDate('${endDate}') - INTERVAL 2 DAY + INTERVAL 1 HOUR, 6, 'UTC'),
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
        toDate('${endDate}') - INTERVAL 2 DAY,
        'test-provider',
        toDateTime64(toDate('${endDate}') - INTERVAL 2 DAY, 6, 'UTC'),
        300,
        1,
        0,
        now64(9)
      ), (
        toUUID('${userId}'),
        toDate('${endDate}') - INTERVAL 2 DAY,
        'test-provider',
        toDateTime64(toDate('${endDate}') - INTERVAL 2 DAY, 6, 'UTC'),
        480,
        2,
        0,
        now64(9)
      ), (
        toUUID('${userId}'),
        toDate('${endDate}') - INTERVAL 1 DAY,
        'test-provider',
        toDateTime64(toDate('${endDate}') - INTERVAL 1 DAY, 6, 'UTC'),
        600,
        1,
        0,
        now64(9)
      ), (
        toUUID('${userId}'),
        toDate('${endDate}') - INTERVAL 1 DAY,
        'test-provider',
        toDateTime64(toDate('${endDate}') - INTERVAL 1 DAY, 6, 'UTC'),
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
        toDate('${endDate}') - INTERVAL 2 DAY,
        40,
        60,
        0,
        1,
        now64(9)
      ), (
        toUUID('${userId}'),
        toDate('${endDate}') - INTERVAL 2 DAY,
        60,
        50,
        0,
        2,
        now64(9)
      ), (
        toUUID('${userId}'),
        toDate('${endDate}') - INTERVAL 1 DAY,
        80,
        45,
        0,
        1,
        now64(9)
      ), (
        toUUID('${userId}'),
        toDate('${endDate}') - INTERVAL 1 DAY,
        80,
        45,
        1,
        2,
        now64(9)
      )`,
    );
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
        toUUID('${boundaryActivityId}'),
        toUUID('${boundaryUserId}'),
        'cycling',
        toDateTime64('${boundaryActivityStartedAt}', 6, 'UTC'),
        toDateTime64('${boundaryActivityStartedAt}', 6, 'UTC') + INTERVAL 1 HOUR,
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
        toUUID('${boundaryUserId}'),
        toDate(toDateTime64('${boundaryActivityStartedAt}', 6, 'UTC') - INTERVAL 6 HOUR),
        'test-provider',
        toDateTime64('${boundaryActivityStartedAt}', 6, 'UTC'),
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
        toUUID('${boundaryUserId}'),
        toDate(toDateTime64('${boundaryActivityStartedAt}', 6, 'UTC') - INTERVAL 6 HOUR),
        64,
        52,
        0,
        1,
        now64(9)
      )`,
    );

    for (const recursiveView of [
      "v_activity",
      "v_sleep",
      "v_daily_metrics",
      "resting_heart_rate_sleep_window",
    ]) {
      await executeClickHouseTestCommand(testContext, `DROP TABLE analytics.${recursiveView} SYNC`);
    }
  }, 120_000);

  afterAll(async () => {
    await testContext?.cleanup();
  });

  it("builds the report from compact serving models without recursive views", async () => {
    const report = await new WeeklyReportRepository(userId, sensorStore).getReport(1, endDate);

    expect(report.current).toEqual(
      expect.objectContaining({
        weekStart,
        trainingHours: 1,
        activityCount: 1,
        avgSleepMinutes: 480,
        avgRestingHr: 50,
        avgHrv: 60,
      }),
    );
    expect(report.history).toEqual([]);
  });

  it("transitions from the preview to a report after one observed day", async () => {
    const transitionUserId = randomUUID();
    const repository = new WeeklyReportRepository(transitionUserId, sensorStore);
    const emptyReport = await repository.getReport(1, endDate);

    expect(emptyReport.current).toBeNull();
    expect(emptyReport.history).toEqual([]);
    expect(emptyReport.emptyState).toEqual(
      expect.objectContaining({
        reportKind: "weekly",
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
        toDate('${endDate}'),
        55,
        51,
        0,
        1,
        now64(9)
      )`,
    );

    const report = await repository.getReport(1, endDate);

    expect(report.current).toEqual(
      expect.objectContaining({
        weekStart,
        avgRestingHr: 51,
        avgHrv: 55,
      }),
    );
  });

  it("uses the serving-model health-day boundary for non-UTC requests", async () => {
    const report = await new WeeklyReportRepository(boundaryUserId, sensorStore).getReport(
      2,
      endDate,
    );

    expect(requestTimezoneWeekStart).not.toBe(boundaryWeekStart);
    expect(report.history).toEqual([
      expect.objectContaining({
        weekStart: boundaryWeekStart,
        trainingHours: 1,
        activityCount: 1,
        avgSleepMinutes: 480,
        avgRestingHr: 52,
        avgHrv: 64,
      }),
    ]);
    expect(report.current).toEqual(
      expect.objectContaining({
        weekStart,
        trainingHours: 0,
        activityCount: 0,
      }),
    );
  });
});
