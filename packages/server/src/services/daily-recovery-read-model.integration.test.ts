import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import { RecoveryBaselineRepository } from "../repositories/recovery-baseline-repository.ts";
import { loadDashboardOverview } from "./dashboard-overview.ts";

const testUserId = "00000000-0000-4000-8000-000000001771";
const recoveryDate = "2026-01-01";

type ClickHouseClient = ReturnType<typeof createClient>;

const tombstoneRowSchema = z.object({
  is_deleted: z.coerce.number(),
});

const baselineContextRowSchema = z.object({
  hrv_score: z.coerce.number(),
  hrv_mean_30d: z.coerce.number().nullable(),
  hrv_sd_30d: z.coerce.number().nullable(),
  hrv_z_score: z.coerce.number().nullable(),
  hrv_baseline_sample_count: z.coerce.number(),
  hrv_baseline_coverage: z.coerce.number(),
  hrv_mean_7d: z.coerce.number().nullable(),
  hrv_mean_previous_28d: z.coerce.number().nullable(),
  efficiency_mean_30d: z.coerce.number().nullable(),
  efficiency_sd_30d: z.coerce.number().nullable(),
  efficiency_z_score: z.coerce.number().nullable(),
  efficiency_baseline_sample_count: z.coerce.number(),
  efficiency_baseline_coverage: z.coerce.number(),
});

describe("daily recovery read-model lifecycle", () => {
  let client: ClickHouseClient | undefined;
  const targetSchema = `analytics_daily_recovery_test_${randomBytes(6).toString("hex")}`;

  beforeAll(async () => {
    client = createClient({
      url: requireClickHouseUrl(),
      request_timeout: 120_000,
    });
    await waitForClickHouse(client);
  }, 120_000);

  afterAll(async () => {
    if (client) {
      await client.command({ query: `DROP DATABASE IF EXISTS ${targetSchema} SYNC` });
      await client.close();
    }
  });

  it("computes prior-calendar-day baseline context without hiding sparse coverage", async () => {
    const activeClient = requireClient(client);
    await seedBaselineFixture(activeClient, targetSchema);
    await materializeRecoveryInputs(activeClient, targetSchema, false);
    await materializeRecovery(activeClient, targetSchema, false);

    const rows = await readBaselineContext(activeClient, targetSchema);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      hrv_baseline_sample_count: 3,
      hrv_baseline_coverage: 0.1,
      hrv_mean_30d: 60,
      hrv_mean_7d: 80,
      hrv_mean_previous_28d: 40,
      efficiency_baseline_sample_count: 3,
      efficiency_baseline_coverage: 0.1,
      efficiency_mean_30d: 80,
    });
    expect(rows[0]?.hrv_sd_30d).toBeCloseTo(16.3299, 3);
    expect(rows[0]?.hrv_z_score).toBeCloseTo(2.4494, 3);
    expect(rows[0]?.efficiency_sd_30d).toBeCloseTo(8.165, 3);
    expect(rows[0]?.efficiency_z_score).toBeCloseTo(2.4494, 3);
  });

  it("selects only the latest non-null canonical metric rows for all-time consumers", async () => {
    const activeClient = requireClient(client);
    await seedBaselineFixture(activeClient, targetSchema);
    await materializeRecoveryInputs(activeClient, targetSchema, false);
    await materializeRecovery(activeClient, targetSchema, false);

    const repository = new RecoveryBaselineRepository(
      testUserId,
      createIsolatedSensorStore(activeClient, targetSchema),
    );

    await expect(repository.latestMetrics(recoveryDate)).resolves.toMatchObject([
      { metric: "hrv", value: 100 },
      { metric: "resting_heart_rate", value: 48 },
      { metric: "respiratory_rate", value: 18 },
      { metric: "sleep_efficiency", value: 100 },
    ]);
  });

  it("returns null baseline statistics and the default readiness component with no prior samples", async () => {
    const activeClient = requireClient(client);
    await seedFixture(activeClient, targetSchema);
    await materializeRecoveryInputs(activeClient, targetSchema, false);
    await materializeRecovery(activeClient, targetSchema, false);

    await expect(readBaselineContext(activeClient, targetSchema)).resolves.toMatchObject([
      {
        hrv_baseline_sample_count: 0,
        hrv_baseline_coverage: 0,
        hrv_mean_30d: null,
        hrv_sd_30d: null,
        hrv_z_score: null,
        hrv_score: 62,
      },
    ]);
  });

  it("tombstones recovery after the final source input is removed and excludes it from the API", async () => {
    const activeClient = requireClient(client);
    await seedFixture(activeClient, targetSchema);
    await materializeRecoveryInputs(activeClient, targetSchema, false);
    await materializeRecovery(activeClient, targetSchema, false);

    const sensorStore = createIsolatedSensorStore(activeClient, targetSchema);
    await expect(loadRepresentativeApi(sensorStore)).resolves.toMatchObject({
      readiness: {
        date: recoveryDate,
      },
    });

    const initialInputRowCount = await readPhysicalRowCount(
      activeClient,
      targetSchema,
      "daily_recovery_inputs",
    );
    const initialRecoveryRowCount = await readPhysicalRowCount(
      activeClient,
      targetSchema,
      "daily_recovery",
    );

    await materializeRecoveryInputs(activeClient, targetSchema, true);
    await materializeRecovery(activeClient, targetSchema, true);

    await expect(
      readPhysicalRowCount(activeClient, targetSchema, "daily_recovery_inputs"),
    ).resolves.toBe(initialInputRowCount);
    await expect(readPhysicalRowCount(activeClient, targetSchema, "daily_recovery")).resolves.toBe(
      initialRecoveryRowCount,
    );

    await activeClient.command({ query: `TRUNCATE TABLE ${targetSchema}.v_daily_metrics` });
    await materializeRecoveryInputs(activeClient, targetSchema, true);
    await materializeRecovery(activeClient, targetSchema, true);

    await expect(readLiveRecovery(activeClient, targetSchema)).resolves.toBe(0);
    await expect(readRecoveryTombstone(activeClient, targetSchema)).resolves.toEqual([
      { is_deleted: 1 },
    ]);
    await expect(loadRepresentativeApi(sensorStore)).resolves.toMatchObject({
      readiness: null,
    });
  }, 180_000);
});

function requireClickHouseUrl(): string {
  const url = process.env.CLICKHOUSE_URL?.trim();
  if (!url) {
    throw new Error("CLICKHOUSE_URL is required for daily recovery integration tests");
  }
  return url;
}

function requireClient(client: ClickHouseClient | undefined): ClickHouseClient {
  if (!client) {
    throw new Error("ClickHouse client was not initialized");
  }
  return client;
}

async function waitForClickHouse(client: ClickHouseClient): Promise<void> {
  let lastError: unknown;
  for (let attemptIndex = 0; attemptIndex < 60; attemptIndex += 1) {
    try {
      const result = await client.query({ query: "SELECT 1", format: "JSONEachRow" });
      await result.json();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolveAfterDelay) => setTimeout(resolveAfterDelay, 1_000));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("ClickHouse did not become ready");
}

function readModelSql(modelName: "daily_recovery" | "daily_recovery_inputs"): string {
  return readFileSync(
    new URL(`../../../../analytics/models/read_models/${modelName}.sql`, import.meta.url),
    "utf8",
  );
}

function renderModelSelectSql(
  modelName: "daily_recovery" | "daily_recovery_inputs",
  targetSchema: string,
  isIncremental: boolean,
): string {
  return readModelSql(modelName)
    .replace(/{{ config\([\s\S]*?\) }}\s*/, "")
    .replace(
      /{% if is_incremental\(\) %}([\s\S]*?)(?:{% else %}([\s\S]*?))?{% endif %}/g,
      (_, incrementalSql: string, initialSql: string | undefined) =>
        isIncremental ? incrementalSql : (initialSql ?? ""),
    )
    .replaceAll("{{ this }}", `${targetSchema}.${modelName}`)
    .replaceAll("{{ ref('daily_recovery_inputs') }}", `${targetSchema}.daily_recovery_inputs`)
    .replaceAll("{{ ref('daily_sleep') }}", `${targetSchema}.daily_sleep`)
    .replaceAll(
      "{{ ref('resting_heart_rate_sleep_window') }}",
      `${targetSchema}.resting_heart_rate_sleep_window`,
    )
    .replaceAll("analytics.v_daily_metrics", `${targetSchema}.v_daily_metrics`)
    .concat("\nSETTINGS join_use_nulls = 1, max_threads = 1");
}

async function materializeRecoveryInputs(
  client: ClickHouseClient,
  targetSchema: string,
  isIncremental: boolean,
): Promise<void> {
  await client.command({
    query: `INSERT INTO ${targetSchema}.daily_recovery_inputs (
      user_id, date, hrv, resting_hr, respiratory_rate, efficiency_pct,
      hrv_mean_30d, hrv_sd_30d,
      hrv_baseline_sample_count, hrv_baseline_coverage, hrv_mean_7d, hrv_mean_previous_28d,
      rhr_mean_30d, rhr_sd_30d,
      rhr_baseline_sample_count, rhr_baseline_coverage, rhr_mean_7d, rhr_mean_previous_28d,
      rr_mean_30d, rr_sd_30d,
      rr_baseline_sample_count, rr_baseline_coverage, rr_mean_7d, rr_mean_previous_28d,
      efficiency_mean_30d, efficiency_sd_30d,
      efficiency_baseline_sample_count, efficiency_baseline_coverage,
      efficiency_mean_7d, efficiency_mean_previous_28d,
      hrv_mean_60d, hrv_sd_60d,
      rhr_mean_60d, rhr_sd_60d, is_deleted, refresh_version, refreshed_at
    )
${renderModelSelectSql("daily_recovery_inputs", targetSchema, isIncremental)}`,
  });
}

async function materializeRecovery(
  client: ClickHouseClient,
  targetSchema: string,
  isIncremental: boolean,
): Promise<void> {
  await client.command({
    query: `INSERT INTO ${targetSchema}.daily_recovery (
      user_id, date, hrv, resting_hr, respiratory_rate, efficiency_pct,
      hrv_mean_30d, hrv_sd_30d, hrv_z_score,
      hrv_baseline_sample_count, hrv_baseline_coverage, hrv_mean_7d, hrv_mean_previous_28d,
      rhr_mean_30d, rhr_sd_30d, resting_hr_z_score,
      rhr_baseline_sample_count, rhr_baseline_coverage, rhr_mean_7d, rhr_mean_previous_28d,
      rr_mean_30d, rr_sd_30d, respiratory_rate_z_score,
      rr_baseline_sample_count, rr_baseline_coverage, rr_mean_7d, rr_mean_previous_28d,
      efficiency_mean_30d, efficiency_sd_30d, efficiency_z_score,
      efficiency_baseline_sample_count, efficiency_baseline_coverage,
      efficiency_mean_7d, efficiency_mean_previous_28d,
      hrv_mean_60d, hrv_sd_60d,
      rhr_mean_60d, rhr_sd_60d, hrv_score, resting_hr_score,
      sleep_score, respiratory_rate_score, is_deleted, refresh_version, refreshed_at
    )
${renderModelSelectSql("daily_recovery", targetSchema, isIncremental)}`,
  });
}

async function readLiveRecovery(client: ClickHouseClient, targetSchema: string): Promise<number> {
  const result = await client.query({
    query: `SELECT count() AS row_count
      FROM ${targetSchema}.daily_recovery FINAL
      WHERE user_id = {userId:UUID}
        AND date = toDate({date:String})
        AND is_deleted = 0`,
    query_params: {
      date: recoveryDate,
      userId: testUserId,
    },
    format: "JSONEachRow",
  });
  const rows = z
    .array(z.object({ row_count: z.coerce.number() }))
    .parse(await result.json<unknown>());
  return rows[0]?.row_count ?? 0;
}

async function readPhysicalRowCount(
  client: ClickHouseClient,
  targetSchema: string,
  tableName: "daily_recovery" | "daily_recovery_inputs",
): Promise<number> {
  const result = await client.query({
    query: `SELECT count() AS row_count FROM ${targetSchema}.${tableName}`,
    format: "JSONEachRow",
  });
  const rows = z
    .array(z.object({ row_count: z.coerce.number() }))
    .parse(await result.json<unknown>());
  return rows[0]?.row_count ?? 0;
}

async function readRecoveryTombstone(
  client: ClickHouseClient,
  targetSchema: string,
): Promise<z.infer<typeof tombstoneRowSchema>[]> {
  const result = await client.query({
    query: `SELECT is_deleted
      FROM ${targetSchema}.daily_recovery FINAL
      WHERE user_id = {userId:UUID}
        AND date = toDate({date:String})`,
    query_params: {
      date: recoveryDate,
      userId: testUserId,
    },
    format: "JSONEachRow",
  });
  return z.array(tombstoneRowSchema).parse(await result.json<unknown>());
}

async function readBaselineContext(
  client: ClickHouseClient,
  targetSchema: string,
): Promise<z.infer<typeof baselineContextRowSchema>[]> {
  const result = await client.query({
    query: `SELECT
        hrv_score,
        hrv_mean_30d,
        hrv_sd_30d,
        hrv_z_score,
        hrv_baseline_sample_count,
        hrv_baseline_coverage,
        hrv_mean_7d,
        hrv_mean_previous_28d,
        efficiency_mean_30d,
        efficiency_sd_30d,
        efficiency_z_score,
        efficiency_baseline_sample_count,
        efficiency_baseline_coverage
      FROM ${targetSchema}.daily_recovery FINAL
      WHERE user_id = {userId:UUID}
        AND date = toDate({date:String})
        AND is_deleted = 0`,
    query_params: {
      date: recoveryDate,
      userId: testUserId,
    },
    format: "JSONEachRow",
  });
  return z.array(baselineContextRowSchema).parse(await result.json<unknown>());
}

function createIsolatedSensorStore(
  client: ClickHouseClient,
  targetSchema: string,
): ActivitySensorStore {
  return {
    async query<TSchema extends z.ZodType>(
      schema: TSchema,
      queryText: string,
      params: Record<string, unknown> = {},
    ) {
      const result = await client.query({
        query: queryText.replaceAll("analytics.", `${targetSchema}.`),
        query_params: params,
        format: "JSONEachRow",
      });
      const rows = z.array(z.record(z.string(), z.unknown())).parse(await result.json<unknown>());
      return rows.map((row) => schema.parse(row));
    },
    getActivitySummaries: async () => [],
    getStream: async () => [],
    getHeartRateZoneSeconds: async () => [],
    getPowerZoneSeconds: async () => [],
    getPowerCurveSamples: async () => [],
    getNormalizedPowerSamples: async () => [],
    getVo2MaxEstimates: async () => [],
    getHeartRateCurveRows: async () => [],
    getPaceCurveRows: async () => [],
    refreshBodyMeasurements: async () => undefined,
  };
}

async function loadRepresentativeApi(sensorStore: ActivitySensorStore) {
  return loadDashboardOverview({
    accessWindow: { kind: "full" },
    endDate: recoveryDate,
    sensorStore,
    userId: testUserId,
  });
}

async function seedFixture(client: ClickHouseClient, targetSchema: string): Promise<void> {
  await runStatements(client, [
    `DROP DATABASE IF EXISTS ${targetSchema} SYNC`,
    `CREATE DATABASE ${targetSchema}`,
    createDailyMetricsTableSql(targetSchema),
    createRestingHeartRateTableSql(targetSchema),
    createRecoveryInputsTableSql(targetSchema),
    createRecoveryTableSql(targetSchema),
    createDailyStrainTableSql(targetSchema),
    createDailySleepTableSql(targetSchema),
    `INSERT INTO ${targetSchema}.v_daily_metrics VALUES (
      '${testUserId}',
      toDate('${recoveryDate}'),
      65,
      14
    )`,
  ]);
}

async function seedBaselineFixture(client: ClickHouseClient, targetSchema: string): Promise<void> {
  await runStatements(client, [
    `DROP DATABASE IF EXISTS ${targetSchema} SYNC`,
    `CREATE DATABASE ${targetSchema}`,
    createDailyMetricsTableSql(targetSchema),
    createRestingHeartRateTableSql(targetSchema),
    createRecoveryInputsTableSql(targetSchema),
    createRecoveryTableSql(targetSchema),
    createDailyStrainTableSql(targetSchema),
    createDailySleepTableSql(targetSchema),
    `INSERT INTO ${targetSchema}.v_daily_metrics VALUES
      ('${testUserId}', toDate('2025-12-02'), 40, 12),
      ('${testUserId}', toDate('2025-12-30'), 60, 14),
      ('${testUserId}', toDate('2025-12-31'), 80, 16),
      ('${testUserId}', toDate('${recoveryDate}'), 100, 18)`,
    `INSERT INTO ${targetSchema}.daily_sleep VALUES
      ('${testUserId}', toDate('2025-12-02'), 480, NULL, NULL, NULL, NULL, 70, false, 0, 1),
      ('${testUserId}', toDate('2025-12-30'), 480, NULL, NULL, NULL, NULL, 80, false, 0, 1),
      ('${testUserId}', toDate('2025-12-31'), 480, NULL, NULL, NULL, NULL, 90, false, 0, 1),
      ('${testUserId}', toDate('${recoveryDate}'), 480, NULL, NULL, NULL, NULL, 100, false, 0, 1)`,
    `INSERT INTO ${targetSchema}.resting_heart_rate_sleep_window VALUES
      ('${testUserId}', toDateTime64('2025-12-02 08:00:00', 6, 'UTC'), 480, 54, 0, 1),
      ('${testUserId}', toDateTime64('2025-12-30 08:00:00', 6, 'UTC'), 480, 52, 0, 1),
      ('${testUserId}', toDateTime64('2025-12-31 08:00:00', 6, 'UTC'), 480, 50, 0, 1),
      ('${testUserId}', toDateTime64('${recoveryDate} 08:00:00', 6, 'UTC'), 480, 48, 0, 1)`,
  ]);
}

async function runStatements(client: ClickHouseClient, statements: string[]): Promise<void> {
  for (const [statementIndex, statement] of statements.entries()) {
    try {
      await client.command({ query: statement });
    } catch (error) {
      const statementPreview = statement.replace(/\s+/g, " ").slice(0, 240);
      throw new Error(
        `ClickHouse fixture statement ${statementIndex + 1} failed: ${statementPreview}`,
        { cause: error },
      );
    }
  }
}

function createDailyMetricsTableSql(targetSchema: string): string {
  return `CREATE TABLE ${targetSchema}.v_daily_metrics (
    user_id UUID,
    date Date,
    hrv Nullable(Float32),
    respiratory_rate_avg Nullable(Float32)
  )
  ENGINE = MergeTree
  ORDER BY (user_id, date)`;
}

function createRestingHeartRateTableSql(targetSchema: string): string {
  return `CREATE TABLE ${targetSchema}.resting_heart_rate_sleep_window (
    user_id UUID,
    ended_at Nullable(DateTime64(6, 'UTC')),
    duration_seconds Nullable(Int64),
    resting_hr Nullable(Float64),
    is_deleted UInt8,
    refresh_version UInt64
  )
  ENGINE = ReplacingMergeTree(refresh_version)
  ORDER BY user_id`;
}

function createRecoveryInputsTableSql(targetSchema: string): string {
  return `CREATE TABLE ${targetSchema}.daily_recovery_inputs (
    user_id UUID,
    date Date,
    hrv Nullable(Float64),
    resting_hr Nullable(Float64),
    respiratory_rate Nullable(Float64),
    efficiency_pct Nullable(Float64),
    hrv_mean_30d Nullable(Float64),
    hrv_sd_30d Nullable(Float64),
    hrv_baseline_sample_count UInt16,
    hrv_baseline_coverage Float64,
    hrv_mean_7d Nullable(Float64),
    hrv_mean_previous_28d Nullable(Float64),
    rhr_mean_30d Nullable(Float64),
    rhr_sd_30d Nullable(Float64),
    rhr_baseline_sample_count UInt16,
    rhr_baseline_coverage Float64,
    rhr_mean_7d Nullable(Float64),
    rhr_mean_previous_28d Nullable(Float64),
    rr_mean_30d Nullable(Float64),
    rr_sd_30d Nullable(Float64),
    rr_baseline_sample_count UInt16,
    rr_baseline_coverage Float64,
    rr_mean_7d Nullable(Float64),
    rr_mean_previous_28d Nullable(Float64),
    efficiency_mean_30d Nullable(Float64),
    efficiency_sd_30d Nullable(Float64),
    efficiency_baseline_sample_count UInt16,
    efficiency_baseline_coverage Float64,
    efficiency_mean_7d Nullable(Float64),
    efficiency_mean_previous_28d Nullable(Float64),
    hrv_mean_60d Nullable(Float64),
    hrv_sd_60d Nullable(Float64),
    rhr_mean_60d Nullable(Float64),
    rhr_sd_60d Nullable(Float64),
    is_deleted UInt8,
    refresh_version UInt64,
    refreshed_at DateTime64(9, 'UTC')
  )
  ENGINE = ReplacingMergeTree(refresh_version)
  ORDER BY (user_id, date)`;
}

function createRecoveryTableSql(targetSchema: string): string {
  return `CREATE TABLE ${targetSchema}.daily_recovery (
    user_id UUID,
    date Date,
    hrv Nullable(Float64),
    resting_hr Nullable(Float64),
    respiratory_rate Nullable(Float64),
    efficiency_pct Nullable(Float64),
    hrv_mean_30d Nullable(Float64),
    hrv_sd_30d Nullable(Float64),
    hrv_z_score Nullable(Float64),
    hrv_baseline_sample_count UInt16,
    hrv_baseline_coverage Float64,
    hrv_mean_7d Nullable(Float64),
    hrv_mean_previous_28d Nullable(Float64),
    rhr_mean_30d Nullable(Float64),
    rhr_sd_30d Nullable(Float64),
    resting_hr_z_score Nullable(Float64),
    rhr_baseline_sample_count UInt16,
    rhr_baseline_coverage Float64,
    rhr_mean_7d Nullable(Float64),
    rhr_mean_previous_28d Nullable(Float64),
    rr_mean_30d Nullable(Float64),
    rr_sd_30d Nullable(Float64),
    respiratory_rate_z_score Nullable(Float64),
    rr_baseline_sample_count UInt16,
    rr_baseline_coverage Float64,
    rr_mean_7d Nullable(Float64),
    rr_mean_previous_28d Nullable(Float64),
    efficiency_mean_30d Nullable(Float64),
    efficiency_sd_30d Nullable(Float64),
    efficiency_z_score Nullable(Float64),
    efficiency_baseline_sample_count UInt16,
    efficiency_baseline_coverage Float64,
    efficiency_mean_7d Nullable(Float64),
    efficiency_mean_previous_28d Nullable(Float64),
    hrv_mean_60d Nullable(Float64),
    hrv_sd_60d Nullable(Float64),
    rhr_mean_60d Nullable(Float64),
    rhr_sd_60d Nullable(Float64),
    hrv_score Nullable(Float64),
    resting_hr_score Nullable(Float64),
    sleep_score Nullable(Float64),
    respiratory_rate_score Nullable(Float64),
    is_deleted UInt8,
    refresh_version UInt64,
    refreshed_at DateTime64(9, 'UTC')
  )
  ENGINE = ReplacingMergeTree(refresh_version)
  ORDER BY (user_id, date)`;
}

function createDailyStrainTableSql(targetSchema: string): string {
  return `CREATE TABLE ${targetSchema}.daily_strain (
    user_id UUID,
    date Date,
    daily_load Float64,
    is_deleted UInt8,
    refresh_version UInt64
  )
  ENGINE = ReplacingMergeTree(refresh_version)
  ORDER BY (user_id, date)`;
}

function createDailySleepTableSql(targetSchema: string): string {
  return `CREATE TABLE ${targetSchema}.daily_sleep (
    user_id UUID,
    date Date,
    duration_minutes Nullable(Int32),
    deep_minutes Nullable(Int32),
    rem_minutes Nullable(Int32),
    light_minutes Nullable(Int32),
    awake_minutes Nullable(Int32),
    efficiency_pct Nullable(Float64),
    staging_available Bool,
    is_deleted UInt8,
    refresh_version UInt64
  )
  ENGINE = ReplacingMergeTree(refresh_version)
  ORDER BY (user_id, date)`;
}
