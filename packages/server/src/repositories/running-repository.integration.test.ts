import { randomUUID } from "node:crypto";
import { createClickHouseClientFromEnv } from "dofek/db/clickhouse";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  buildActivitySummaryRowsTableSql,
  buildActivitySummaryViewSql,
} from "../../../../src/db/clickhouse-activity-summary.ts";
import { TEST_USER_ID } from "../../../../src/db/schema/core.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { ClickHouseActivitySensorStore } from "./clickhouse-activity-sensor-store.ts";
import { RunningRepository } from "./running-repository.ts";

describe("RunningRepository ClickHouse serving model", () => {
  const database = `running_${randomUUID().replaceAll("-", "")}`;
  const clickhouse = createClickHouseClientFromEnv();
  const rewrite = (query: string) => query.replaceAll("analytics.", `${database}.`);
  const unnamedRunId = randomUUID();
  const namedRunId = randomUUID();
  let testContext: TestContext;
  let repository: RunningRepository;

  beforeAll(async () => {
    testContext = await setupTestDatabase();
    testContext.addCleanup(async () => {
      try {
        await clickhouse.command({ query: `DROP DATABASE IF EXISTS ${database} SYNC` });
      } finally {
        await clickhouse.close?.();
      }
    });
    await testContext.db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES ('running-test', 'Running test', ${TEST_USER_ID})`,
    );
    await testContext.db.execute(
      sql`INSERT INTO fitness.activity (
            id, group_id, provider_id, user_id, external_id, canonical_type, provider_type,
            started_at, ended_at, name
          ) VALUES
          (
            ${unnamedRunId}, ${unnamedRunId}, 'running-test', ${TEST_USER_ID}, 'unnamed-run',
            'running', 'running', '2026-10-01T12:00:00Z', '2026-10-01T12:40:00Z', NULL
          ),
          (
            ${namedRunId}, ${namedRunId}, 'running-test', ${TEST_USER_ID}, 'named-run',
            'running', 'running', '2026-10-02T12:00:00Z', '2026-10-02T12:41:40Z', 'Tempo Run'
          )`,
    );
    await clickhouse.command({ query: `CREATE DATABASE ${database}` });
    for (const query of [buildActivitySummaryRowsTableSql(), buildActivitySummaryViewSql()]) {
      await clickhouse.command({ query: rewrite(query) });
    }
    await clickhouse.command({
      query: `INSERT INTO ${database}.activity_summary_rows (
        activity_id, user_id, canonical_type, name, started_at, ended_at,
        avg_speed, avg_cadence, total_distance, avg_stride_length, avg_stance_time, avg_vertical_osc,
        refresh_version, is_deleted, refreshed_at
      ) VALUES
      (
        toUUID('${unnamedRunId}'), toUUID('${TEST_USER_ID}'), 'running', NULL,
        toDateTime64('2026-10-01 12:00:00', 6, 'UTC'),
        toDateTime64('2026-10-01 12:40:00', 6, 'UTC'),
        3.5, 172, 8500, NULL, NULL, NULL, 1, 0, now64(9)
      ),
      (
        toUUID('${namedRunId}'), toUUID('${TEST_USER_ID}'), 'running', 'Tempo Run',
        toDateTime64('2026-10-02 12:00:00', 6, 'UTC'),
        toDateTime64('2026-10-02 12:41:40', 6, 'UTC'),
        4, 180, 10000, 1.2, 230, 85, 1, 0, now64(9)
      )`,
    });
    const sensorStore = new ClickHouseActivitySensorStore({
      query: (options) => clickhouse.query({ ...options, query: rewrite(options.query) }),
      command: (options) => clickhouse.command({ ...options, query: rewrite(options.query) }),
    });
    repository = new RunningRepository(testContext.db, TEST_USER_ID, "UTC", sensorStore);
  });

  afterAll(async () => {
    await testContext?.cleanup();
  });

  it("retains pace metrics for unnamed runs alongside named runs", async () => {
    const result = await repository.getPaceTrend(null);

    expect(result.map((activity) => activity.toDetail())).toEqual([
      {
        date: "2026-10-01",
        activityName: "Running",
        paceSecondsPerKm: 286,
        distanceKm: 8.5,
        durationMinutes: 40,
      },
      {
        date: "2026-10-02",
        activityName: "Tempo Run",
        paceSecondsPerKm: 250,
        distanceKm: 10,
        durationMinutes: 42,
      },
    ]);
  });

  it("retains running dynamics for unnamed runs alongside named runs", async () => {
    const result = await repository.getDynamics(null);

    expect(result.map((activity) => activity.toDetail())).toEqual([
      {
        activityId: unnamedRunId,
        date: "2026-10-01",
        activityName: "Running",
        cadence: 172,
        strideLengthMeters: null,
        stanceTimeMs: null,
        verticalOscillationMm: null,
        paceSecondsPerKm: 286,
        distanceKm: 8.5,
      },
      {
        activityId: namedRunId,
        date: "2026-10-02",
        activityName: "Tempo Run",
        cadence: 180,
        strideLengthMeters: 1.2,
        stanceTimeMs: 230,
        verticalOscillationMm: 85,
        paceSecondsPerKm: 250,
        distanceKm: 10,
      },
    ]);
  });
});
