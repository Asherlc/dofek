import { randomUUID } from "node:crypto";
import { referenceBestPower } from "@dofek/training/power-duration-reference";
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
const referenceConstantStartedAt = testTimestamp(32_400);
const referenceZeroStartedAt = testTimestamp(36_000);
const referenceIrregularStartedAt = testTimestamp(39_600);
const referenceDropoutStartedAt = testTimestamp(43_200);
const referencePelotonStartedAt = testTimestamp(46_800);
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
const referenceConstantActivityId = randomUUID();
const referenceZeroActivityId = randomUUID();
const referenceIrregularActivityId = randomUUID();
const referenceDropoutActivityId = randomUUID();
const referencePelotonActivityId = randomUUID();
const readModelRowSchema = z.object({
  activity_id: z.string(),
  duration_seconds: z.coerce.number(),
  best_power: z.coerce.number().nullable(),
  is_deleted: z.coerce.number(),
});
const evidenceRowSchema = readModelRowSchema.extend({
  start_offset_seconds: z.coerce.number().nullable(),
  observed_samples: z.coerce.number().nullable(),
  median_sample_interval_seconds: z.coerce.number().nullable(),
  largest_gap_seconds: z.coerce.number().nullable(),
  coverage_pct: z.coerce.number().nullable(),
  power_measurement_kind: z.string().nullable(),
  source_providers: z.array(z.string()),
  source_devices: z.array(z.string()),
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
  options: {
    providerId?: string;
    deviceId?: string;
    measurementKind?: "direct" | "estimated" | "unknown";
  } = {},
): ClickHouseMetricStreamSeedRow[] {
  const startedAtMs = Date.parse(startedAt);

  return samples.map((sample) => ({
    activityId,
    userId: testUserId,
    recordedAt: new Date(startedAtMs + sample.offsetSeconds * 1000).toISOString(),
    providerId: options.providerId ?? "test_provider",
    deviceId: options.deviceId,
    sourceType: "api",
    channel: "power",
    scalar: sample.power,
    metadata: JSON.stringify({ measurement_kind: options.measurementKind ?? "direct" }),
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
      VALUES
        ('test_provider', 'Test Provider', ${testUserId}),
        ('wahoo', 'Wahoo', ${testUserId}),
        ('strava', 'Strava', ${testUserId}),
        ('peloton', 'Peloton', ${testUserId})
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
        start_offset_seconds Nullable(Float64),
        observed_samples Nullable(UInt64),
        median_sample_interval_seconds Nullable(Float64),
        largest_gap_seconds Nullable(Float64),
        coverage_pct Nullable(Float64),
        power_measurement_kind Nullable(String),
        source_providers Array(String),
        source_devices Array(String),
        is_deleted UInt8,
        refresh_version UInt64,
        refreshed_at DateTime64(9, 'UTC')
      ) ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY (user_id, activity_id, duration_seconds)`,
    });

    try {
      await client.command({
        query: `INSERT INTO ${targetTable} (
          activity_id, user_id, started_at, activity_date, duration_seconds, best_power,
          is_deleted, refresh_version, refreshed_at
        ) VALUES (
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

    await expect(result.json()).resolves.toEqual([{ "count()": 15 }]);
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
      query: `INSERT INTO analytics.activity_sensor_sample (
          activity_id, user_id, recorded_at, recorded_date, channel, scalar,
          refresh_version, is_deleted, refreshed_at
        )
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
        start_offset_seconds Nullable(Float64),
        observed_samples Nullable(UInt64),
        median_sample_interval_seconds Nullable(Float64),
        largest_gap_seconds Nullable(Float64),
        coverage_pct Nullable(Float64),
        power_measurement_kind Nullable(String),
        source_providers Array(String),
        source_devices Array(String),
        is_deleted UInt8,
        refresh_version UInt64,
        refreshed_at DateTime64(9, 'UTC')
      ) ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY (user_id, activity_id, duration_seconds)`,
    });

    try {
      await client.command({
        query: `INSERT INTO ${targetTable} (
          activity_id, user_id, started_at, activity_date, duration_seconds, best_power,
          is_deleted, refresh_version, refreshed_at
        )
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
        query: `INSERT INTO ${targetTable} (
          activity_id, user_id, started_at, activity_date, duration_seconds, best_power,
          is_deleted, refresh_version, refreshed_at
        ) VALUES (
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
        FROM (${renderActivityPowerCurveSql(true, targetTable, 1)}) AS power_curve
        WHERE duration_seconds = 5`,
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

  it("integrates through an unaligned fractional endpoint", async () => {
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

    expect(rows).toEqual([
      {
        activity_id: unalignedActivityId,
        best_power: 200,
        duration_seconds: 5,
        is_deleted: 0,
      },
    ]);
  });

  it("matches the independent elapsed-time reference across real-world sampling cases", async () => {
    const constantSamples = Array.from({ length: 31 }, (_, offsetSeconds) => ({
      offsetSeconds,
      power: 250,
    }));
    const zeroSamples = [300, 300, 0, 300, 300, 300].map((power, offsetSeconds) => ({
      offsetSeconds,
      power,
    }));
    const irregularSamples = [
      { offsetSeconds: 0, power: 100 },
      { offsetSeconds: 1.5, power: 200 },
      { offsetSeconds: 3.5, power: 300 },
      { offsetSeconds: 5.5, power: 400 },
    ];
    const dropoutSamples = [
      { offsetSeconds: 0, power: 500 },
      { offsetSeconds: 1, power: 500 },
      { offsetSeconds: 2, power: 500 },
      { offsetSeconds: 20, power: 100 },
    ];
    const pelotonSamples = [
      { offsetSeconds: 0, power: 200 },
      { offsetSeconds: 5, power: 200 },
      { offsetSeconds: 10, power: 200 },
    ];
    const activities = [
      [referenceConstantActivityId, "reference-constant", referenceConstantStartedAt, 30],
      [referenceZeroActivityId, "reference-zero", referenceZeroStartedAt, 5],
      [referenceIrregularActivityId, "reference-irregular", referenceIrregularStartedAt, 5.5],
      [referenceDropoutActivityId, "reference-dropout", referenceDropoutStartedAt, 20],
      [referencePelotonActivityId, "reference-peloton", referencePelotonStartedAt, 10],
    ] as const;

    for (const [activityId, name, startedAt, duration] of activities) {
      await insertActivity(
        testContext,
        activityId,
        name,
        startedAt,
        new Date(Date.parse(startedAt) + duration * 1000).toISOString(),
      );
    }
    await seedClickHouseMetricStreamRows(testContext, [
      ...powerSampleRows(referenceConstantActivityId, referenceConstantStartedAt, constantSamples, {
        providerId: "wahoo",
        deviceId: "elemnt-bolt",
      }),
      ...powerSampleRows(referenceConstantActivityId, referenceConstantStartedAt, constantSamples, {
        providerId: "strava",
        deviceId: "strava-import",
      }),
      ...powerSampleRows(referenceZeroActivityId, referenceZeroStartedAt, zeroSamples, {
        providerId: "wahoo",
        deviceId: "elemnt-roam",
      }),
      ...powerSampleRows(
        referenceIrregularActivityId,
        referenceIrregularStartedAt,
        irregularSamples,
        {
          providerId: "wahoo",
          deviceId: "estimated-power",
          measurementKind: "estimated",
        },
      ),
      ...powerSampleRows(referenceDropoutActivityId, referenceDropoutStartedAt, dropoutSamples, {
        providerId: "wahoo",
      }),
      ...powerSampleRows(referencePelotonActivityId, referencePelotonStartedAt, pelotonSamples, {
        providerId: "peloton",
        deviceId: "peloton-bike",
      }),
    ]);
    await syncClickHouseTestActivitySensorStore(testContext);

    const rows = await sensorStore.query(
      evidenceRowSchema,
      `SELECT
        toString(activity_id) AS activity_id,
        duration_seconds,
        best_power,
        start_offset_seconds,
        observed_samples,
        median_sample_interval_seconds,
        largest_gap_seconds,
        coverage_pct,
        power_measurement_kind,
        source_providers,
        source_devices,
        is_deleted
      FROM (${renderNonIncrementalActivityPowerCurveSql()}) AS power_curve
      WHERE (activity_id, duration_seconds) IN (
        ('${referenceConstantActivityId}', 30),
        ('${referenceZeroActivityId}', 5),
        ('${referenceIrregularActivityId}', 5),
        ('${referenceDropoutActivityId}', 15),
        ('${referencePelotonActivityId}', 1),
        ('${referencePelotonActivityId}', 5)
      )
      ORDER BY activity_id, duration_seconds`,
    );

    const cases = [
      [referenceConstantActivityId, constantSamples, 30],
      [referenceZeroActivityId, zeroSamples, 5],
      [referenceIrregularActivityId, irregularSamples, 5],
      [referenceDropoutActivityId, dropoutSamples, 15],
      [referencePelotonActivityId, pelotonSamples, 1],
      [referencePelotonActivityId, pelotonSamples, 5],
    ] as const;
    for (const [activityId, samples, duration] of cases) {
      const expected = referenceBestPower(
        samples.map(({ offsetSeconds, power }) => ({
          elapsedSeconds: offsetSeconds,
          watts: power,
        })),
        duration,
      );
      const row = rows.find(
        (candidate) =>
          candidate.activity_id === activityId && candidate.duration_seconds === duration,
      );
      if (expected === null) {
        expect(row).toBeUndefined();
      } else {
        expect(row?.best_power).toBeCloseTo(expected.watts, 1);
        expect(row?.start_offset_seconds).toBeCloseTo(expected.startOffsetSeconds, 3);
      }
    }

    const constant = rows.find(
      (row) => row.activity_id === referenceConstantActivityId && row.duration_seconds === 30,
    );
    expect(constant).toMatchObject({
      coverage_pct: 100,
      observed_samples: 31,
      power_measurement_kind: "direct",
    });
    expect(constant?.source_providers).toHaveLength(1);
    expect(constant?.source_devices).toHaveLength(1);
    expect(rows.find((row) => row.activity_id === referenceIrregularActivityId)).toMatchObject({
      power_measurement_kind: "estimated",
    });
  });
});
