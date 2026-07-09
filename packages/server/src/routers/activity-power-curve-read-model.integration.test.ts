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

function renderNonIncrementalActivityPowerCurveSql(): string {
  return readModelSql("activity_power_curve.sql")
    .replace(/^\{\{ config\([\s\S]*?\n\) \}\}\s*/, "")
    .replace(/\{\{\s*ref\('activity_summary_rows'\)\s*\}\}/g, "analytics.activity_summary")
    .replace(/\{\{\s*ref\('([^']+)'\)\s*\}\}/g, "analytics.$1")
    .replace(/FROM analytics\.activity_summary FINAL/g, "FROM analytics.activity_summary")
    .replace(
      /\n {4}WHERE is_deleted = 0\n {8}AND ended_at IS NOT NULL/,
      "\n    WHERE ended_at IS NOT NULL",
    )
    .replace(/\{%\s*if is_incremental\(\)\s*%\}[\s\S]*?\{%\s*endif\s*%\}/g, "");
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

  it("uses elapsed timestamp duration instead of sample count for power windows", async () => {
    const regularActivityId = randomUUID();
    const gappedActivityId = randomUUID();
    const renderedSql = renderNonIncrementalActivityPowerCurveSql();

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
      "2026-07-01T14:00:05.000Z",
    );
    await syncClickHouseTestActivitySensorStore(testContext);
    await seedClickHouseMetricStreamRows(testContext, [
      ...powerSampleRows(varyingActivityId, varyingPowerStartedAt, [
        { offsetSeconds: 0, power: 100 },
        { offsetSeconds: 1, power: 200 },
        { offsetSeconds: 2, power: 300 },
        { offsetSeconds: 3, power: 400 },
        { offsetSeconds: 4, power: 500 },
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
        activity_id: varyingActivityId,
        best_power: 300,
        duration_seconds: 5,
        is_deleted: 0,
      },
    ]);
  });
});
