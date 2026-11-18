import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClickHouseClientFromEnv } from "../../../../src/db/clickhouse.ts";
import {
  buildActivitySummaryRowsTableSql,
  buildActivitySummaryViewSql,
} from "../../../../src/db/clickhouse-activity-summary.ts";
import { cyclingPowerSchemaStatements } from "../../../../src/db/cycling-power-schema.ts";
import { activity } from "../../../../src/db/schema/activity.ts";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { ensureProvider } from "../../../../src/db/tokens.ts";
import { buildAccountErasureFenceTableSql } from "../../../../src/metric-stream/clickhouse-table.ts";
import { ChartRange } from "../lib/chart-range.ts";
import { buildTestAnalyticsTableStatement } from "../routers/clickhouse-integration-test-models.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { ClickHouseActivitySensorStore } from "./clickhouse-activity-sensor-store.ts";
import { CyclingAnalyticsRepository } from "./cycling-analytics-repository.ts";
import { CyclingThresholdRepository } from "./cycling-threshold-repository.ts";

const ACTIVITY_ID = "11111111-1111-4111-8111-111111111111";
const ZERO_EFFICIENCY_ACTIVITY_ID = "44444444-4444-4444-8444-444444444444";

describe("CyclingAnalyticsRepository ClickHouse serving models", () => {
  let testContext: TestContext;
  let sensorStore: ActivitySensorStore;
  let executeCommand: (query: string) => Promise<unknown>;

  beforeAll(async () => {
    testContext = await setupTestDatabase();
    await ensureProvider(
      testContext.db,
      "cycling-analytics-fixture",
      "Cycling analytics fixture",
      undefined,
      TEST_USER_ID,
    );
    await testContext.db.insert(activity).values({
      id: ACTIVITY_ID,
      groupId: ACTIVITY_ID,
      userId: TEST_USER_ID,
      providerId: "cycling-analytics-fixture",
      externalId: ACTIVITY_ID,
      canonicalType: "cycling",
      providerType: "cycling",
      startedAt: new Date(Date.now() - 2 * 86_400_000),
      endedAt: new Date(Date.now() - 2 * 86_400_000 + 3_600_000),
    });
    await testContext.db.execute(sql`DELETE FROM fitness.sport_settings
      WHERE user_id = ${TEST_USER_ID}::uuid AND sport = 'cycling'`);
    await testContext.db.execute(sql`INSERT INTO fitness.sport_settings
      (user_id, sport, ftp, effective_from) VALUES
      (${TEST_USER_ID}::uuid, 'cycling', 250, CURRENT_DATE - 10)`);
    const client = createClickHouseClientFromEnv();
    const database = `cycling_analytics_test_${randomUUID().replaceAll("-", "")}`;
    const rewrite = (query: string) =>
      query.replace(/\b(analytics|ingest|postgres_fitness)\b/g, database);
    executeCommand = (query) => client.command({ query: rewrite(query) });
    testContext.addCleanup(async () => {
      await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
      await client.close?.();
    });
    await client.command({ query: `CREATE DATABASE ${database}` });
    for (const statement of [
      buildAccountErasureFenceTableSql(),
      ...[
        "cycling_activity",
        "daily_cycling",
        "activity_power_curve",
        "daily_body_measurement",
      ].map((name) => buildTestAnalyticsTableStatement(`analytics.${name}`)),
      buildActivitySummaryRowsTableSql(),
      ...cyclingPowerSchemaStatements(),
      buildActivitySummaryViewSql(),
    ])
      await executeCommand(statement);
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
      `INSERT INTO analytics.activity_summary_rows (
        activity_id,user_id,canonical_type,name,started_at,ended_at,power_sample_count,
        refresh_version,is_deleted,refreshed_at
      ) VALUES (
        toUUID('${ACTIVITY_ID}'),toUUID('${TEST_USER_ID}'),'cycling','Threshold Intervals',
        now64(6, 'UTC') - INTERVAL 2 DAY,
        now64(6, 'UTC') - INTERVAL 2 DAY + INTERVAL 1 HOUR,
        3600,1,0,now64(9, 'UTC')
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

  it("serves cycling metrics and dated configured FTP in five ClickHouse statements", async () => {
    const querySpy = vi.spyOn(sensorStore, "query");
    const repository = new CyclingAnalyticsRepository(
      testContext.db,
      TEST_USER_ID,
      "UTC",
      sensorStore,
    );

    const thresholdMetrics = await new CyclingThresholdRepository(
      testContext.db,
      sensorStore,
      TEST_USER_ID,
      "UTC",
    ).getForActivities([ACTIVITY_ID]);
    const thresholdMetric = thresholdMetrics.get(ACTIVITY_ID);
    expect(thresholdMetric, JSON.stringify(thresholdMetric)).toMatchObject({
      ftp: 250,
      normalized_power: 280,
      intensity_factor: 1.12,
    });
    querySpy.mockClear();

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
    expect(performance.pmc.model.ftp).toBe(250);
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
});
