import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { readModelSql } from "../../../../analytics/models/read_models/read-model-sql-test-helpers.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import {
  type ClickHouseMetricStreamSeedRow,
  createClickHouseTestActivitySensorStore,
  executeClickHouseTestCommand,
  getClickHouseTestClient,
  seedClickHouseMetricStreamRows,
  syncClickHouseTestActivitySensorStore,
} from "./clickhouse-integration-test-helpers.ts";

const testUserId = "00000000-0000-0000-0000-000000000001";
const regularActivityStartedAt = "2026-07-01T12:00:00.000Z";
const gappedActivityStartedAt = "2026-07-01T13:00:00.000Z";
const varyingPowerStartedAt = "2026-07-01T14:00:00.000Z";
const readModelRowSchema = z.object({
  activity_id: z.string(),
  duration_seconds: z.coerce.number(),
  best_power: z.coerce.number().nullable(),
  is_deleted: z.coerce.number(),
});

function renderActivityPowerCurveSql(isIncremental: boolean, targetTable?: string): string {
  const renderedSql = readModelSql("activity_power_curve.sql")
    .replace(/^\{\{ config\([\s\S]*?\n\) \}\}\s*/, "")
    .replace(
      /\{\{\s*ref\('activity_summary_rows'\)\s*\}\} FINAL/g,
      `(SELECT
        activity_summary.*,
        toUInt8(0) AS is_deleted,
        toDateTime64('2026-07-01 00:00:00', 9, 'UTC') AS refreshed_at
      FROM analytics.activity_summary AS activity_summary)`,
    )
    .replace(/\{\{\s*ref\('([^']+)'\)\s*\}\}/g, "analytics.$1")
    .replace(
      /\{%\s*if is_incremental\(\)\s*%\}([\s\S]*?)(?:\{%\s*else\s*%\}([\s\S]*?))?\{%\s*endif\s*%\}/g,
      (_, incrementalSql: string, nonIncrementalSql: string | undefined) =>
        isIncremental ? incrementalSql : (nonIncrementalSql ?? ""),
    );

  if (!isIncremental) return renderedSql;
  if (!targetTable) throw new Error("Incremental power-curve SQL requires a target table");
  return renderedSql.replace(/\{\{\s*this\s*\}\}/g, targetTable);
}

function renderNonIncrementalActivityPowerCurveSql(): string {
  return renderActivityPowerCurveSql(false);
}

function powerSampleRows(
  activityId: string,
  startedAt: string,
  samples: readonly { offsetSeconds: number; power: number }[],
): ClickHouseMetricStreamSeedRow[] {
  const startedAtMs = Date.parse(startedAt);

  return samples.map((sample) => ({
    activityId,
    userId: testUserId,
    recordedAt: new Date(startedAtMs + sample.offsetSeconds * 1000).toISOString(),
    providerId: "test_provider",
    sourceType: "api",
    channel: "power",
    scalar: sample.power,
  }));
}

async function insertActivity(
  testContext: TestContext,
  activityId: string,
  name: string,
  startedAt: string,
  endedAt: string,
): Promise<void> {
  await testContext.db.execute(sql`
    INSERT INTO fitness.activity (
      id, provider_id, user_id, external_id, activity_type, started_at, ended_at, name
    ) VALUES (
      ${activityId}, 'test_provider', ${testUserId}, ${`${name}-${activityId}`}, 'cycling',
      ${startedAt}, ${endedAt}, ${name}
    )
  `);
}

describe("activity_power_curve read model", () => {
  let testContext: TestContext;
  let sensorStore: ActivitySensorStore;

  beforeAll(async () => {
    testContext = await setupTestDatabase();
    await testContext.db.execute(sql`
      INSERT INTO fitness.provider (id, name, user_id)
      VALUES ('test_provider', 'Test Provider', ${testUserId})
      ON CONFLICT DO NOTHING
    `);
    sensorStore = await createClickHouseTestActivitySensorStore(testContext);
  });

  afterAll(async () => {
    await testContext?.cleanup();
  });

  it("does not recompute unchanged activities during an incremental build", async () => {
    const unchangedActivityId = randomUUID();
    const client = getClickHouseTestClient(testContext);
    const targetTable = `analytics.test_activity_power_curve_${randomUUID().replaceAll("-", "")}`;

    await insertActivity(
      testContext,
      unchangedActivityId,
      "unchanged-power",
      regularActivityStartedAt,
      "2026-07-01T12:00:30.000Z",
    );
    await syncClickHouseTestActivitySensorStore(testContext);
    await client.command({
      query: `CREATE TABLE ${targetTable} (
        activity_id UUID,
        user_id UUID,
        started_at Nullable(DateTime64(6, 'UTC')),
        activity_date Nullable(String),
        duration_seconds UInt32,
        best_power Nullable(Int32),
        is_deleted UInt8,
        refresh_version UInt64,
        refreshed_at DateTime64(9, 'UTC')
      ) ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY (user_id, activity_id, duration_seconds)`,
    });

    try {
      await client.command({
        query: `INSERT INTO ${targetTable} VALUES (
          {activityId:UUID}, {userId:UUID}, parseDateTime64BestEffort({startedAt:String}, 6), '2026-07-01',
          5, 200, 0, 1, now64(9) + INTERVAL 1 DAY
        )`,
        query_params: {
          activityId: unchangedActivityId,
          startedAt: regularActivityStartedAt,
          userId: testUserId,
        },
      });

      const rows = await sensorStore.query(
        readModelRowSchema,
        `SELECT
          toString(activity_id) AS activity_id,
          duration_seconds,
          best_power,
          is_deleted
        FROM (${renderActivityPowerCurveSql(true, targetTable)}) AS power_curve`,
      );

      expect(rows).toEqual([]);
    } finally {
      await client.command({ query: `DROP TABLE IF EXISTS ${targetTable}` });
    }
  });

  it("uses elapsed timestamp duration instead of sample count for power windows", async () => {
    const regularActivityId = randomUUID();
    const gappedActivityId = randomUUID();
    const renderedSql = renderNonIncrementalActivityPowerCurveSql();

    await executeClickHouseTestCommand(testContext, "TRUNCATE TABLE ingest.metric_stream");
    await insertActivity(
      testContext,
      regularActivityId,
      "regular-power",
      regularActivityStartedAt,
      "2026-07-01T12:00:30.000Z",
    );
    await insertActivity(
      testContext,
      gappedActivityId,
      "gapped-power",
      gappedActivityStartedAt,
      "2026-07-01T13:00:30.000Z",
    );
    await syncClickHouseTestActivitySensorStore(testContext);
    await seedClickHouseMetricStreamRows(testContext, [
      ...powerSampleRows(regularActivityId, regularActivityStartedAt, [
        { offsetSeconds: 0, power: 200 },
        { offsetSeconds: 1, power: 200 },
        { offsetSeconds: 2, power: 200 },
        { offsetSeconds: 3, power: 200 },
        { offsetSeconds: 4, power: 200 },
        { offsetSeconds: 5, power: 200 },
      ]),
      ...powerSampleRows(gappedActivityId, gappedActivityStartedAt, [
        { offsetSeconds: 0, power: 100 },
        { offsetSeconds: 1, power: 100 },
        { offsetSeconds: 2, power: 100 },
        { offsetSeconds: 20, power: 500 },
        { offsetSeconds: 21, power: 500 },
        { offsetSeconds: 22, power: 500 },
      ]),
    ]);

    const rows = await sensorStore.query(
      readModelRowSchema,
      `
        SELECT
          toString(activity_id) AS activity_id,
          duration_seconds,
          best_power,
          is_deleted
        FROM (${renderedSql}) AS power_curve
        WHERE duration_seconds = 5
        ORDER BY activity_id
      `,
    );

    expect(rows).toEqual([
      {
        activity_id: regularActivityId,
        best_power: 200,
        duration_seconds: 5,
        is_deleted: 0,
      },
    ]);
  });

  it("computes average power correctly for varying-power windows", async () => {
    const varyingActivityId = randomUUID();
    const renderedSql = renderNonIncrementalActivityPowerCurveSql();

    await insertActivity(
      testContext,
      varyingActivityId,
      "varying-power",
      varyingPowerStartedAt,
      "2026-07-01T14:00:06.000Z",
    );
    await syncClickHouseTestActivitySensorStore(testContext);
    await seedClickHouseMetricStreamRows(testContext, [
      ...powerSampleRows(varyingActivityId, varyingPowerStartedAt, [
        { offsetSeconds: 0, power: 100 },
        { offsetSeconds: 1, power: 200 },
        { offsetSeconds: 2, power: 300 },
        { offsetSeconds: 3, power: 400 },
        { offsetSeconds: 4, power: 500 },
        { offsetSeconds: 5, power: 300 },
      ]),
    ]);

    const rows = await sensorStore.query(
      readModelRowSchema,
      `
        SELECT
          toString(activity_id) AS activity_id,
          duration_seconds,
          best_power,
          is_deleted
        FROM (${renderedSql}) AS power_curve
        WHERE activity_id = '${varyingActivityId}'
          AND duration_seconds = 5
        ORDER BY activity_id
      `,
    );

    expect(rows).toEqual([
      {
        activity_id: varyingActivityId,
        best_power: 300,
        duration_seconds: 5,
        is_deleted: 0,
      },
    ]);
  });
});
