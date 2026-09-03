import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { readModelSql } from "../../../../src/db/read-model-sql-test-helpers.ts";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import {
  type ClickHouseMetricStreamSeedRow,
  createClickHouseTestActivitySensorStore,
  getClickHouseTestClient,
  seedClickHouseMetricStreamRows,
  syncClickHouseTestActivitySensorStore,
} from "./clickhouse-integration-test-helpers.ts";

const testUserId = "00000000-0000-0000-0000-000000000001";
const testRunStartedAtMs = Date.now();

function testTimestamp(offsetSeconds: number): string {
  return new Date(testRunStartedAtMs + offsetSeconds * 1000).toISOString();
}

const unchangedActivityStartedAt = testTimestamp(-3600);
const regularActivityStartedAt = testTimestamp(0);
const gappedActivityStartedAt = testTimestamp(3600);
const varyingPowerStartedAt = testTimestamp(7200);
const finalGapActivityStartedAt = testTimestamp(10_800);
const unalignedActivityStartedAt = testTimestamp(14_400);
const planActivityStartedAt = testTimestamp(18_000);
const duplicateVersionActivityStartedAt = testTimestamp(25_200);
const starvationActivityStartedAt = testTimestamp(28_800);
const unchangedActivityId = randomUUID();
const regularActivityId = randomUUID();
const gappedActivityId = randomUUID();
const varyingActivityId = randomUUID();
const finalGapActivityId = randomUUID();
const unalignedActivityId = randomUUID();
const planActivityId = randomUUID();
const duplicateVersionActivityId = "00000000-0000-4000-8000-000000000020";
const tombstonedActivityId = "00000000-0000-4000-8000-000000000010";
const starvationActivityId = "ffffffff-ffff-4fff-8fff-fffffffffff0";
const readModelRowSchema = z.object({
  activity_id: z.string(),
  duration_seconds: z.coerce.number(),
  best_power: z.coerce.number().nullable(),
  is_deleted: z.coerce.number(),
});

function renderActivityPowerCurveSql(
  isIncremental: boolean,
  targetTable?: string,
  dirtyKeyBatchSize = 32,
): string {
  const renderedSql = readModelSql("activity_power_curve.sql")
    .replace(/^\{\{ config\([\s\S]*?\n\) \}\}\s*/, "")
    .replace(/\{%\s*set power_curve_dirty_key_batch_size[\s\S]*?%\}\s*/, "")
    .replace(/\{\{\s*power_curve_dirty_key_batch_size\s*\}\}/g, dirtyKeyBatchSize.toString())
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
      id, provider_id, user_id, external_id, canonical_type, provider_type, started_at, ended_at, name
    ) VALUES (
      ${activityId}, 'test_provider', ${testUserId}, ${`${name}-${activityId}`}, 'cycling', 'cycling',
      ${startedAt}, ${endedAt}, ${name}
    )
    ON CONFLICT (id) DO NOTHING
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
    const client = getClickHouseTestClient(testContext);
    const targetTable = `analytics.test_activity_power_curve_${randomUUID().replaceAll("-", "")}`;

    await insertActivity(
      testContext,
      unchangedActivityId,
      "unchanged-power",
      unchangedActivityStartedAt,
      testTimestamp(-3570),
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
          startedAt: unchangedActivityStartedAt,
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

  it("keeps power-window computation memory bounded", async () => {
    await insertActivity(
      testContext,
      planActivityId,
      "power-plan",
      planActivityStartedAt,
      testTimestamp(21_600),
    );
    await seedClickHouseMetricStreamRows(
      testContext,
      powerSampleRows(
        planActivityId,
        planActivityStartedAt,
        Array.from({ length: 3601 }, (_, offsetSeconds) => ({ offsetSeconds, power: 200 })),
      ),
    );
    await syncClickHouseTestActivitySensorStore(testContext);
    const client = getClickHouseTestClient(testContext);
    const result = await client.query({
      query: `SELECT count()
        FROM (${renderNonIncrementalActivityPowerCurveSql()})
        WHERE activity_id = {activityId:UUID}
        SETTINGS max_memory_usage = 536870912, use_query_cache = 0`,
      query_params: { activityId: planActivityId },
      format: "JSONEachRow",
    });

    await expect(result.json()).resolves.toEqual([{ "count()": 12 }]);
  });

  it("uses elapsed timestamp duration instead of sample count for power windows", async () => {
    const renderedSql = renderNonIncrementalActivityPowerCurveSql();

    await insertActivity(
      testContext,
      regularActivityId,
      "regular-power",
      regularActivityStartedAt,
      testTimestamp(30),
    );
    await insertActivity(
      testContext,
      gappedActivityId,
      "gapped-power",
      gappedActivityStartedAt,
      testTimestamp(3630),
    );
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
    await syncClickHouseTestActivitySensorStore(testContext);

    const rows = await sensorStore.query(
      readModelRowSchema,
      `
        SELECT
          toString(activity_id) AS activity_id,
          duration_seconds,
          best_power,
          is_deleted
        FROM (${renderedSql}) AS power_curve
        WHERE activity_id IN ('${regularActivityId}', '${gappedActivityId}')
          AND duration_seconds = 5
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
    const renderedSql = renderNonIncrementalActivityPowerCurveSql();

    await insertActivity(
      testContext,
      varyingActivityId,
      "varying-power",
      varyingPowerStartedAt,
      testTimestamp(7206),
    );
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
    await syncClickHouseTestActivitySensorStore(testContext);

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

  it("uses the latest sensor version when endpoint timestamps are duplicated", async () => {
    const renderedSql = renderNonIncrementalActivityPowerCurveSql();

    await insertActivity(
      testContext,
      duplicateVersionActivityId,
      "duplicate-version-power",
      duplicateVersionActivityStartedAt,
      testTimestamp(25_206),
    );
    await seedClickHouseMetricStreamRows(
      testContext,
      powerSampleRows(
        duplicateVersionActivityId,
        duplicateVersionActivityStartedAt,
        Array.from({ length: 6 }, (_, offsetSeconds) => ({ offsetSeconds, power: 100 })),
      ),
    );
    await syncClickHouseTestActivitySensorStore(testContext);
    const client = getClickHouseTestClient(testContext);
    await client.command({
      query: `INSERT INTO analytics.activity_sensor_sample
        SELECT
          {activityId:UUID},
          {userId:UUID},
          addSeconds(parseDateTime64BestEffort({startedAt:String}, 6), number),
          toDate(parseDateTime64BestEffort({startedAt:String}, 6)),
          'power',
          toNullable(toFloat32(300)),
          toUInt64(18000000000000000000),
          toUInt8(0),
          now64(9)
        FROM numbers(6)`,
      query_params: {
        activityId: duplicateVersionActivityId,
        startedAt: duplicateVersionActivityStartedAt,
        userId: testUserId,
      },
    });

    const rows = await sensorStore.query(
      readModelRowSchema,
      `SELECT
        toString(power_curve.activity_id) AS activity_id,
        duration_seconds,
        best_power,
        is_deleted
      FROM (${renderedSql}) AS power_curve
      WHERE power_curve.activity_id = {activityId:UUID}
        AND duration_seconds = 5`,
      { activityId: duplicateVersionActivityId },
    );

    expect(rows).toEqual([
      {
        activity_id: duplicateVersionActivityId,
        best_power: 300,
        duration_seconds: 5,
        is_deleted: 0,
      },
    ]);
  });

  it("does not let an already-tombstoned key starve a new dirty activity", async () => {
    const client = getClickHouseTestClient(testContext);
    const targetTable = `analytics.test_activity_power_curve_${randomUUID().replaceAll("-", "")}`;

    await insertActivity(
      testContext,
      starvationActivityId,
      "starvation-power",
      starvationActivityStartedAt,
      testTimestamp(28_806),
    );
    await seedClickHouseMetricStreamRows(
      testContext,
      powerSampleRows(
        starvationActivityId,
        starvationActivityStartedAt,
        Array.from({ length: 6 }, (_, offsetSeconds) => ({ offsetSeconds, power: 250 })),
      ),
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
        query: `INSERT INTO ${targetTable}
          SELECT
            activity_id,
            user_id,
            NULL,
            NULL,
            toUInt32(5),
            toNullable(toInt32(1)),
            toUInt8(0),
            toUInt64(2),
            toDateTime64('2100-01-01 00:00:00', 9, 'UTC')
          FROM analytics.activity_summary
          WHERE activity_id != {activityId:UUID}
            AND ended_at IS NOT NULL
            AND power_sample_count > 1
            AND canonical_type IN (
              'cycling',
              'road_cycling',
              'mountain_biking',
              'gravel_cycling',
              'indoor_cycling',
              'virtual_cycling',
              'e_bike_cycling',
              'cyclocross',
              'track_cycling',
              'bmx',
              'hand_cycling',
              'running',
              'swimming',
              'walking',
              'hiking'
            )`,
        query_params: {
          activityId: starvationActivityId,
        },
      });
      await client.command({
        query: `INSERT INTO ${targetTable} VALUES (
          {activityId:UUID}, {userId:UUID}, NULL, NULL, 5, NULL, 1, 2, now64(9)
        )`,
        query_params: {
          activityId: tombstonedActivityId,
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
        FROM (${renderActivityPowerCurveSql(true, targetTable, 1)}) AS power_curve`,
      );

      expect(rows).toEqual([
        {
          activity_id: starvationActivityId,
          best_power: 250,
          duration_seconds: 5,
          is_deleted: 0,
        },
      ]);
    } finally {
      await client.command({ query: `DROP TABLE IF EXISTS ${targetTable}` });
    }
  });

  it("includes the final segment when rejecting discontinuous windows", async () => {
    const renderedSql = renderNonIncrementalActivityPowerCurveSql();

    await insertActivity(
      testContext,
      finalGapActivityId,
      "final-gap-power",
      finalGapActivityStartedAt,
      testTimestamp(10_820),
    );
    await seedClickHouseMetricStreamRows(testContext, [
      ...powerSampleRows(finalGapActivityId, finalGapActivityStartedAt, [
        { offsetSeconds: 0, power: 200 },
        { offsetSeconds: 1, power: 200 },
        { offsetSeconds: 2, power: 200 },
        { offsetSeconds: 15, power: 200 },
      ]),
    ]);
    await syncClickHouseTestActivitySensorStore(testContext);

    const rows = await sensorStore.query(
      readModelRowSchema,
      `
        SELECT
          toString(activity_id) AS activity_id,
          duration_seconds,
          best_power,
          is_deleted
        FROM (${renderedSql}) AS power_curve
        WHERE activity_id = '${finalGapActivityId}'
          AND duration_seconds = 15
      `,
    );

    expect(rows).toEqual([]);
  });

  it("preserves the exact-duration endpoint requirement for unaligned samples", async () => {
    const renderedSql = renderNonIncrementalActivityPowerCurveSql();

    await insertActivity(
      testContext,
      unalignedActivityId,
      "unaligned-power",
      unalignedActivityStartedAt,
      testTimestamp(14_410),
    );
    await seedClickHouseMetricStreamRows(testContext, [
      ...powerSampleRows(unalignedActivityId, unalignedActivityStartedAt, [
        { offsetSeconds: 0, power: 200 },
        { offsetSeconds: 1, power: 200 },
        { offsetSeconds: 2, power: 200 },
        { offsetSeconds: 3, power: 200 },
        { offsetSeconds: 4.9, power: 200 },
        { offsetSeconds: 5.1, power: 200 },
      ]),
    ]);
    await syncClickHouseTestActivitySensorStore(testContext);

    const rows = await sensorStore.query(
      readModelRowSchema,
      `
        SELECT
          toString(activity_id) AS activity_id,
          duration_seconds,
          best_power,
          is_deleted
        FROM (${renderedSql}) AS power_curve
        WHERE activity_id = '${unalignedActivityId}'
          AND duration_seconds = 5
      `,
    );

    expect(rows).toEqual([]);
  });
});
