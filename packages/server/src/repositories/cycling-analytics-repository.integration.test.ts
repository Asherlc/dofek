import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createClickHouseClientFromEnv } from "../../../../src/db/clickhouse.ts";
import {
  buildActivitySummaryRowsTableSql,
  buildActivitySummaryViewSql,
} from "../../../../src/db/clickhouse-activity-summary.ts";
import { cyclingPowerSchemaStatements } from "../../../../src/db/cycling-power-schema.ts";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { ChartRange } from "../lib/chart-range.ts";
import { buildTestAnalyticsTableStatement } from "../routers/clickhouse-integration-test-models.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { ClickHouseActivitySensorStore } from "./clickhouse-activity-sensor-store.ts";
import { CyclingAnalyticsRepository } from "./cycling-analytics-repository.ts";

const ACTIVITY_ID = "11111111-1111-4111-8111-111111111111";
const RECENT_HEART_RATE_ACTIVITY_ID = "22222222-2222-4222-8222-222222222222";
const HISTORICAL_HIGH_HEART_RATE_ACTIVITY_ID = "33333333-3333-4333-8333-333333333333";
const ZERO_EFFICIENCY_ACTIVITY_ID = "44444444-4444-4444-8444-444444444444";

describe("CyclingAnalyticsRepository ClickHouse serving models", () => {
  let testContext: TestContext;
  let sensorStore: ActivitySensorStore;
  let executeCommand: (query: string) => Promise<unknown>;

  beforeAll(async () => {
    testContext = await setupTestDatabase();
    const client = createClickHouseClientFromEnv();
    const database = `cycling_analytics_test_${randomUUID().replaceAll("-", "")}`;
    const rewrite = (query: string) => query.replace(/\b(analytics|postgres_fitness)\b/g, database);
    executeCommand = (query) => client.command({ query: rewrite(query) });
    testContext.addCleanup(async () => {
      await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
      await client.close?.();
    });
    await client.command({ query: `CREATE DATABASE ${database}` });
    for (const statement of [
      ...[
        "cycling_activity",
        "daily_cycling",
        "activity_power_curve",
        "daily_body_measurement",
      ].map((name) => buildTestAnalyticsTableStatement(`analytics.${name}`)),
      buildActivitySummaryRowsTableSql(),
      ...cyclingPowerSchemaStatements(),
      buildActivitySummaryViewSql(),
      "CREATE TABLE postgres_fitness.user_profile_current (id UUID,max_hr Nullable(Int32),resting_hr Nullable(Int32)) ENGINE=Memory",
    ])
      await executeCommand(statement);
    await executeCommand(
      `INSERT INTO postgres_fitness.user_profile_current VALUES ('${TEST_USER_ID}',190,60)`,
    );
    sensorStore = new ClickHouseActivitySensorStore({
      command: (options) => client.command({ ...options, query: rewrite(options.query) }),
      query: (options) => client.query({ ...options, query: rewrite(options.query) }),
    });
    await executeCommand(
      `INSERT INTO analytics.cycling_activity VALUES (
        toUUID('${ACTIVITY_ID}'),
        toUUID('${TEST_USER_ID}'),
        'wahoo',
        ['wahoo'],
        'cycling',
        'cycling',
        NULL,
        'Threshold Intervals',
        now64(6, 'UTC') - INTERVAL 2 DAY,
        now64(6, 'UTC') - INTERVAL 2 DAY + INTERVAL 1 HOUR,
        40000,
        150,
        180,
        250,
        3600,
        3600,
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
        now64(9, 'UTC'),
        NULL
      )`,
    );
    await executeCommand(
      `INSERT INTO analytics.cycling_activity VALUES (
        toUUID('${ZERO_EFFICIENCY_ACTIVITY_ID}'), toUUID('${TEST_USER_ID}'), 'wahoo', ['wahoo'],
        'cycling', 'cycling', NULL, 'Ride Without Zone Two Data', now64(6, 'UTC') - INTERVAL 4 DAY,
        now64(6, 'UTC') - INTERVAL 4 DAY + INTERVAL 1 HOUR, 30000, 145, 175, 200,
        3600, 3600, 250, 100, 3600, 0, 0, 0, 0, 0, 0, 1,
        now64(9, 'UTC'),
        NULL
      )`,
    );
    await executeCommand(
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
          CAST('Threshold Intervals', 'Nullable(String)')
        )],
        0,
        1,
        now64(9, 'UTC')
      )`,
    );
    await executeCommand(
      `INSERT INTO analytics.cycling_power_observation_rows
        (user_id, activity_id, normalized_power, source_refresh_version, model_version,
          is_deleted, refresh_version, refreshed_at) VALUES
        ('${TEST_USER_ID}','${ACTIVITY_ID}',280.0,1,'test-np',0,2,now64(6))`,
    );
    await executeCommand(
      `INSERT INTO analytics.cycling_power_history_rows VALUES
        ('${TEST_USER_ID}',1,today(),'reference-v1',[(toFloat64(toUnixTimestamp64Micro(now64(6)-INTERVAL 2 DAY))/1000000,'${ACTIVITY_ID}',250.0,1.12,125.44,'${ACTIVITY_ID}',toFloat64(toUnixTimestamp64Micro(now64(6)-INTERVAL 2 DAY))/1000000,1200.0,300.0)],3,now64(6))`,
    );
    await executeCommand(
      `INSERT INTO analytics.activity_power_curve (
        activity_id, user_id, started_at, activity_date, duration_seconds, best_power,
        is_deleted, refresh_version, refreshed_at
      ) VALUES
        (toUUID('${ACTIVITY_ID}'), toUUID('${TEST_USER_ID}'), now64(6, 'UTC') - INTERVAL 2 DAY, toString(today() - INTERVAL 2 DAY), 300, 400, 0, 1, now64(9, 'UTC')),
        (toUUID('${ACTIVITY_ID}'), toUUID('${TEST_USER_ID}'), now64(6, 'UTC') - INTERVAL 2 DAY, toString(today() - INTERVAL 2 DAY), 1200, 300, 0, 1, now64(9, 'UTC'))`,
    );
  }, 60_000);

  afterAll(async () => {
    await testContext?.cleanup();
  });

  it("serves cycling metrics and canonical threshold evidence in five ClickHouse statements", async () => {
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

    expect(querySpy).toHaveBeenCalledTimes(5);
    expect(performance.powerCurve.recent.points).toEqual(
      expect.arrayContaining([expect.objectContaining({ durationSeconds: 300, bestPower: 400 })]),
    );
    expect(performance.eftpTrend.currentEftp).toBeGreaterThan(0);
    expect(activities.activities.items[0]?.name).toBe("Threshold Intervals");
    expect(activities.variability.rows[0]?.variabilityIndex).toBe(1.12);
    expect(activities.verticalAscent[0]?.verticalAscentRate).toBe(500);
    expect(activities.aerobicEfficiency.activities[0]?.efficiencyFactor).toBe(1.333);
  });

  it("omits zero-filled aerobic efficiency rows returned by ClickHouse", async () => {
    const repository = new CyclingAnalyticsRepository(
      testContext.db,
      TEST_USER_ID,
      "UTC",
      sensorStore,
    );

    const activities = await repository.getActivities(ChartRange.fromDays(90), {
      activityLimit: 20,
      activityOffset: 0,
      variabilityLimit: 20,
      variabilityOffset: 0,
    });

    expect(activities.aerobicEfficiency.activities).toEqual([
      expect.objectContaining({ name: "Threshold Intervals", efficiencyFactor: 1.333 }),
    ]);
  });

  it("uses the newest body measurement for power summary calculations", async () => {
    await executeCommand(
      `INSERT INTO analytics.daily_body_measurement VALUES
        (generateUUIDv4(), toUUID('${TEST_USER_ID}'), today() - INTERVAL 10 DAY, now64(6, 'UTC') - INTERVAL 10 DAY, 90, NULL, 0, now64(9, 'UTC'), 1, now64(9, 'UTC')),
        (generateUUIDv4(), toUUID('${TEST_USER_ID}'), today() - INTERVAL 1 DAY, now64(6, 'UTC') - INTERVAL 1 DAY, 80, NULL, 0, now64(9, 'UTC'), 1, now64(9, 'UTC'))`,
    );
    const repository = new CyclingAnalyticsRepository(
      testContext.db,
      TEST_USER_ID,
      "UTC",
      sensorStore,
    );

    const performance = await repository.getPerformance(ChartRange.fromDays(90));

    expect(performance.powerSummary.weightKg).toBe(80);
    expect(performance.powerSummary.recent.efforts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ durationSeconds: 300, watts: 400, wattsPerKg: 5 }),
      ]),
    );
  });

  it("excludes historical maximum heart rate outside a limited access window", async () => {
    await testContext.db.execute(
      sql`UPDATE fitness.user_profile SET max_hr = NULL WHERE id = ${TEST_USER_ID}`,
    );
    await executeCommand(`TRUNCATE TABLE postgres_fitness.user_profile_current`);
    await executeCommand(
      `INSERT INTO postgres_fitness.user_profile_current VALUES ('${TEST_USER_ID}',NULL,60)`,
    );
    await executeCommand(
      `INSERT INTO analytics.cycling_activity VALUES
        (
          toUUID('${RECENT_HEART_RATE_ACTIVITY_ID}'), toUUID('${TEST_USER_ID}'), 'wahoo', ['wahoo'],
          'cycling', 'cycling', NULL, 'Recent Heart Rate Ride', now64(6, 'UTC') - INTERVAL 3 DAY,
          now64(6, 'UTC') - INTERVAL 3 DAY + INTERVAL 1 HOUR, 30000, 150, 180, NULL,
          0, 3600, NULL, 100, 3600, 190, NULL, NULL, NULL, NULL, 0, 1, now64(9, 'UTC'), NULL
        ),
        (
          toUUID('${HISTORICAL_HIGH_HEART_RATE_ACTIVITY_ID}'), toUUID('${TEST_USER_ID}'), 'wahoo', ['wahoo'],
          'cycling', 'cycling', NULL, 'Historical Ride', now64(6, 'UTC') - INTERVAL 180 DAY,
          now64(6, 'UTC') - INTERVAL 180 DAY + INTERVAL 1 HOUR, 30000, 150, 240, NULL,
          0, 3600, NULL, 100, 3600, 250, NULL, NULL, NULL, NULL, 0, 1, now64(9, 'UTC'), NULL
        )`,
    );
    await executeCommand(
      `INSERT INTO analytics.daily_cycling VALUES (
        toUUID('${TEST_USER_ID}'),
        today() - INTERVAL 3 DAY,
        [tuple(
          toUUID('${RECENT_HEART_RATE_ACTIVITY_ID}'),
          now64(6, 'UTC') - INTERVAL 3 DAY,
          toFloat64(60),
          toFloat64(150),
          toFloat64(180),
          CAST(NULL, 'Nullable(Float64)'),
          toUInt64(0),
          toUInt64(3600),
          CAST('Recent Heart Rate Ride', 'Nullable(String)')
        )],
        0,
        1,
        now64(9, 'UTC')
      )`,
    );
    const fullRepository = new CyclingAnalyticsRepository(
      testContext.db,
      TEST_USER_ID,
      "UTC",
      sensorStore,
    );
    const limitedRepository = new CyclingAnalyticsRepository(
      testContext.db,
      TEST_USER_ID,
      "UTC",
      sensorStore,
      {
        kind: "limited",
        paid: false,
        reason: "free_recent_week",
        startDate: new Date(Date.now() - 30 * 86_400_000).toISOString(),
        endDateExclusive: new Date(Date.now() + 86_400_000).toISOString(),
      },
    );

    const querySpy = vi.spyOn(sensorStore, "query");
    querySpy.mockClear();
    await fullRepository.getPerformance(ChartRange.fromDays(30));
    await limitedRepository.getPerformance(ChartRange.fromDays(30));
    const activityRowsSchema = z.array(z.object({ global_max_hr: z.coerce.number().nullable() }));
    const activityQueries = querySpy.mock.calls.flatMap((call, index) =>
      call[1].includes("user_baseline.global_max_hr AS global_max_hr")
        ? [querySpy.mock.results[index]?.value]
        : [],
    );
    const fullActivityRows = activityRowsSchema.parse(await activityQueries[0]);
    const limitedActivityRows = activityRowsSchema.parse(await activityQueries[1]);

    expect(fullActivityRows[0]?.global_max_hr).toBe(240);
    expect(limitedActivityRows[0]?.global_max_hr).toBe(180);
  });
});
