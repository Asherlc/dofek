import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createClickHouseClientFromEnv } from "../../../../src/db/clickhouse.ts";
import { cyclingPowerSchemaStatements } from "../../../../src/db/cycling-power-schema.ts";
import { buildTestAnalyticsTableStatement } from "../routers/clickhouse-integration-test-models.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { ClickHouseActivitySensorStore } from "./clickhouse-activity-sensor-store.ts";
import { CyclingPerformanceRepository } from "./cycling-performance-repository.ts";

describe("CyclingPerformanceRepository integration", () => {
  const client = createClickHouseClientFromEnv();
  const database = `cycling_performance_${randomUUID().replaceAll("-", "")}`;
  const query = (sql: string) => sql.replaceAll("analytics.", `${database}.`);
  const execute = async (sql: string) => client.command({ query: query(sql) });
  let sensorStore: ActivitySensorStore;

  beforeAll(async () => {
    await client.command({ query: `CREATE DATABASE ${database}` });
    for (const sql of [
      buildTestAnalyticsTableStatement("analytics.cycling_activity"),
      buildTestAnalyticsTableStatement("analytics.activity_power_curve"),
      ...cyclingPowerSchemaStatements(),
    ])
      await execute(sql);
    sensorStore = new ClickHouseActivitySensorStore({
      command: (options) => client.command({ ...options, query: query(options.query) }),
      query: (options) => client.query({ ...options, query: query(options.query) }),
    });
  }, 60_000);

  afterAll(async () => {
    await client.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
    await client.close?.();
  });

  it("counts canonical normalized power when summary power fields are unavailable", async () => {
    const userId = randomUUID();
    const activityId = randomUUID();
    await execute(
      `INSERT INTO analytics.cycling_activity (activity_id,user_id,canonical_type,modality,started_at,ended_at,source_providers,is_deleted,refresh_version,refreshed_at) VALUES ('${activityId}','${userId}','cycling','indoor','2026-08-30 12:00:00','2026-08-30 13:00:00',['wahoo'],0,1,now64(9))`,
    );
    await execute(
      `INSERT INTO analytics.cycling_power_observation_rows VALUES ('${userId}','${activityId}',220,1,'np-v1',0,100,now64(6))`,
    );
    await execute(
      `INSERT INTO analytics.cycling_power_history_rows VALUES ('${userId}',1,today(),'model-v1',[(1.0,'${activityId}',250.0,0.88,100.0,NULL,0.0,0.0,0.0)],200,now64(6))`,
    );
    const result = await new CyclingPerformanceRepository(sensorStore, userId, "UTC").listRange(
      "2026-08-30",
      "2026-09-01",
    );
    expect(result.summary.power_availability_by_modality.indoor).toEqual({
      first_observed: "2026-08-30",
      last_observed: "2026-08-30",
      activities_with_power: 1,
      activities_total: 1,
      pct: 100,
      source_providers: ["wahoo"],
    });
  });

  it("executes against deduped cycling and power-curve read models", async () => {
    const userId = randomUUID();
    const activityId = randomUUID();
    const outOfRangeActivityId = randomUUID();
    await execute(
      `INSERT INTO analytics.cycling_activity VALUES
      (
        toUUID('${activityId}'), toUUID('${userId}'), 'wahoo', ['wahoo'],
        'cycling', 'cycling', 'outdoor', 'Hilly outdoor ride',
        toDateTime64('2026-08-30 16:00:00', 6, 'UTC'),
        toDateTime64('2026-08-30 17:02:00', 6, 'UTC'),
        38066, 138.3, 170, 180, 1000, 1000, 250, 736, 3720,
        190, 180, 135, 1.333, 600, 0, 1, now64(9, 'UTC'), NULL
      ),
      (
        toUUID('${outOfRangeActivityId}'), toUUID('${userId}'), 'peloton', ['peloton'],
        'cycling', 'cycling', 'indoor', 'Out-of-range indoor ride',
        toDateTime64('2026-09-02 16:00:00', 6, 'UTC'),
        toDateTime64('2026-09-02 17:00:00', 6, 'UTC'),
        0, 150, 175, 200, 1000, 1000, 260, 0, 3600,
        200, 190, 140, 1.263, 600, 0, 1, now64(9, 'UTC'), NULL
      )`,
    );
    await execute(
      `INSERT INTO analytics.activity_power_curve (
        activity_id, user_id, started_at, activity_date, duration_seconds, best_power,
        is_deleted, refresh_version, refreshed_at
      ) VALUES
        (toUUID('${activityId}'), toUUID('${userId}'), toDateTime64('2026-08-30 16:00:00', 6, 'UTC'), '2026-08-30', 5, 900, 0, 1, now64(9, 'UTC')),
        (toUUID('${activityId}'), toUUID('${userId}'), toDateTime64('2026-08-30 16:00:00', 6, 'UTC'), '2026-08-30', 60, 500, 0, 1, now64(9, 'UTC')),
        (toUUID('${activityId}'), toUUID('${userId}'), toDateTime64('2026-08-30 16:00:00', 6, 'UTC'), '2026-08-30', 300, 300, 0, 1, now64(9, 'UTC')),
        (toUUID('${activityId}'), toUUID('${userId}'), toDateTime64('2026-08-30 16:00:00', 6, 'UTC'), '2026-08-30', 1200, 250, 0, 1, now64(9, 'UTC'))`,
    );

    await execute(
      `INSERT INTO analytics.cycling_power_observation_rows VALUES ('${userId}','${activityId}',220,1,'np-v1',0,100,now64(6))`,
    );
    await execute(
      `INSERT INTO analytics.cycling_power_history_rows VALUES ('${userId}',1,today(),'model-v1',[(1.0,'${activityId}',237.5,0.926,100.0,'${activityId}',1.0,1200.0,250.0)],200,now64(6))`,
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
    expect(result.summary.power_availability_by_modality.indoor).toEqual({
      first_observed: null,
      last_observed: null,
      activities_with_power: 0,
      activities_total: 0,
      pct: 0,
      source_providers: [],
    });
    expect(result.rolling_90_day_best["20m"]).toEqual({
      activity_id: activityId,
      date: "2026-08-30",
      watts: 250,
    });
  });
});
