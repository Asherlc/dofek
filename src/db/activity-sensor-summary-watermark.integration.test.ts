import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createClient } from "@clickhouse/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { buildActivitySensorSummaryRowsTableSql } from "./clickhouse-activity-sensor-summary.ts";

const historicalActivityId = "00000000-0000-0000-0000-000000000901";
const unrelatedActivityId = "00000000-0000-0000-0000-000000000902";
const tombstonedActivityId = "00000000-0000-0000-0000-000000000903";
const testUserId = "00000000-0000-0000-0000-000000000001";

type ClickHouseClient = ReturnType<typeof createClient>;

interface SensorSummaryResultRow {
  activity_id: string;
  avg_power: number | null;
  power_sample_count: number;
}

const scanCountRowsSchema = z.array(z.object({ scan_count: z.number() }));

describe("activity_sensor_summary_rows historical dirty keys", () => {
  let client: ClickHouseClient | undefined;
  const targetSchema = `analytics_activity_sensor_summary_test_${randomBytes(6).toString("hex")}`;

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

  it("summarizes historical samples even after an unrelated row advanced the table watermark", async () => {
    const activeClient = requireClient(client);
    await seedHistoricalBackfillFixture(activeClient, targetSchema);
    const queryId = `activity-sensor-summary-${randomUUID()}`;

    await activeClient.command({
      query: `INSERT INTO ${targetSchema}.activity_sensor_summary_rows
${renderActivitySensorSummaryRowsSelectSql(targetSchema)}`,
      query_id: queryId,
    });

    const result = await activeClient.query({
      query: `SELECT
          toString(activity_id) AS activity_id,
          avg_power,
          toUInt32(ifNull(power_sample_count, 0)) AS power_sample_count
        FROM ${targetSchema}.activity_sensor_summary_rows FINAL
        WHERE is_deleted = 0
          AND activity_id = '${historicalActivityId}'`,
      format: "JSONEachRow",
    });
    const rows = await result.json<SensorSummaryResultRow>();

    expect(rows).toEqual([
      {
        activity_id: historicalActivityId,
        avg_power: 210,
        power_sample_count: 2,
      },
    ]);

    const tombstoneResult = await activeClient.query({
      query: `SELECT count() AS tombstone_count
        FROM ${targetSchema}.activity_sensor_summary_rows
        WHERE activity_id = '${tombstonedActivityId}'
          AND is_deleted = 1`,
      format: "JSONEachRow",
    });
    const tombstoneRows = await tombstoneResult.json<{ tombstone_count: number }>();

    expect(tombstoneRows).toEqual([{ tombstone_count: 1 }]);

    await activeClient.command({ query: "SYSTEM FLUSH LOGS" });
    const scanCountResult = await activeClient.query({
      query: `SELECT countIf(startsWith(message, 'Filtering marks')) AS scan_count
        FROM system.text_log
        WHERE query_id = {queryId:String}
          AND startsWith(logger_name, {tableName:String})`,
      query_params: {
        queryId,
        tableName: `${targetSchema}.activity_sensor_sample`,
      },
      format: "JSONEachRow",
    });
    const scanCountRows = scanCountRowsSchema.parse(await scanCountResult.json<unknown>());

    expect(scanCountRows).toEqual([{ scan_count: 2 }]);
  }, 180_000);
});

function requireClickHouseUrl(): string {
  const url = process.env.CLICKHOUSE_URL?.trim();
  if (!url) {
    throw new Error("CLICKHOUSE_URL is required for activity sensor summary integration tests");
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
      await client.query({ query: "SELECT 1", format: "JSONEachRow" });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolveAfterDelay) => setTimeout(resolveAfterDelay, 1_000));
    }
  }
  throw lastError instanceof Error ? lastError : new Error("ClickHouse did not become ready");
}

function readProjectFile(relativePath: string): string {
  return readFileSync(new URL(`../../${relativePath}`, import.meta.url), "utf8");
}

function renderActivitySensorSummaryRowsSelectSql(targetSchema: string): string {
  const modelSql = readProjectFile("analytics/models/read_models/activity_sensor_summary_rows.sql");
  return renderIncrementalDbtModelForFixture(modelSql)
    .replaceAll("{{ initial_lookback_days }}", "120")
    .replaceAll("{{ this }}", `${targetSchema}.activity_sensor_summary_rows`)
    .replaceAll("{{ ref('activity_sensor_sample') }}", `${targetSchema}.activity_sensor_sample`)
    .replaceAll("{{ source('postgres_fitness', 'activity') }}", `${targetSchema}.source_activity`)
    .concat("\nSETTINGS join_use_nulls = 1, enable_materialized_cte = 1");
}

function renderIncrementalDbtModelForFixture(modelSql: string): string {
  const renderedLines: string[] = [];
  const includeStack: boolean[] = [];
  let skippingConfig = false;

  for (const line of modelSql.split("\n")) {
    const trimmedLine = line.trim();

    if (skippingConfig) {
      if (trimmedLine === ") }}") {
        skippingConfig = false;
      }
      continue;
    }

    if (trimmedLine.startsWith("{{ config(")) {
      skippingConfig = true;
      continue;
    }

    if (trimmedLine.startsWith("{% set ")) {
      continue;
    }

    if (trimmedLine === "{% if is_incremental() %}") {
      includeStack.push(true);
      continue;
    }

    if (trimmedLine === "{% else %}") {
      const currentBranch = includeStack.pop();
      if (currentBranch == null) {
        throw new Error("Unexpected dbt else without an active if block");
      }
      includeStack.push(!currentBranch);
      continue;
    }

    if (trimmedLine === "{% endif %}") {
      if (includeStack.pop() == null) {
        throw new Error("Unexpected dbt endif without an active if block");
      }
      continue;
    }

    if (includeStack.every(Boolean)) {
      renderedLines.push(line);
    }
  }

  if (includeStack.length > 0) {
    throw new Error("Unclosed dbt if block while rendering activity sensor summary fixture");
  }

  return renderedLines.join("\n");
}

async function seedHistoricalBackfillFixture(
  client: ClickHouseClient,
  targetSchema: string,
): Promise<void> {
  await runStatements(client, [
    `DROP DATABASE IF EXISTS ${targetSchema} SYNC`,
    `CREATE DATABASE ${targetSchema}`,
    createSourceActivityTableSql(targetSchema),
    createActivitySensorSampleTableSql(targetSchema),
    buildActivitySensorSummaryRowsTableSql().replaceAll("analytics.", `${targetSchema}.`),
    insertCurrentActivitiesSql(targetSchema),
    insertHistoricalPowerSamplesSql(targetSchema),
    insertDeletedPowerSampleSql(targetSchema),
    insertExistingHistoricalSummarySql(targetSchema),
    insertUnrelatedFreshSummarySql(targetSchema),
    insertExistingTombstoneSql(targetSchema),
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

function createSourceActivityTableSql(targetSchema: string): string {
  return `CREATE TABLE ${targetSchema}.source_activity (
  id UUID,
  user_id UUID,
  started_at DateTime64(6, 'UTC'),
  provider_absent_at Nullable(DateTime64(6, 'UTC')),
  deleted_at Nullable(DateTime64(6, 'UTC')),
  _peerdb_is_deleted UInt8
)
ENGINE = ReplacingMergeTree()
ORDER BY id`;
}

function createActivitySensorSampleTableSql(targetSchema: string): string {
  return `CREATE TABLE ${targetSchema}.activity_sensor_sample (
  activity_id UUID,
  user_id UUID,
  recorded_at DateTime64(6, 'UTC'),
  recorded_date Date,
  channel String,
  scalar Nullable(Float64),
  refresh_version UInt64,
  is_deleted UInt8,
  refreshed_at DateTime64(9, 'UTC')
)
ENGINE = ReplacingMergeTree(refresh_version)
ORDER BY (user_id, activity_id, recorded_date, channel, recorded_at)`;
}

function insertCurrentActivitiesSql(targetSchema: string): string {
  return `INSERT INTO ${targetSchema}.source_activity VALUES
  ('${historicalActivityId}', '${testUserId}', toDateTime64('2019-07-16 14:56:37', 6, 'UTC'), NULL, NULL, 0),
  ('${unrelatedActivityId}', '${testUserId}', toDateTime64('2026-07-04 01:00:00', 6, 'UTC'), NULL, NULL, 0),
  ('${tombstonedActivityId}', '${testUserId}', toDateTime64('2026-07-05 01:00:00', 6, 'UTC'), NULL, NULL, 0)`;
}

function insertHistoricalPowerSamplesSql(targetSchema: string): string {
  return `INSERT INTO ${targetSchema}.activity_sensor_sample VALUES
  ('${historicalActivityId}', '${testUserId}', toDateTime64('2019-07-16 14:56:37', 6, 'UTC'), toDate('2019-07-16'), 'power', 200.0, 100, 0, toDateTime64('2026-07-10 05:31:41', 9, 'UTC')),
  ('${historicalActivityId}', '${testUserId}', toDateTime64('2019-07-16 14:56:38', 6, 'UTC'), toDate('2019-07-16'), 'power', 220.0, 100, 0, toDateTime64('2026-07-10 05:31:41', 9, 'UTC'))`;
}

function insertDeletedPowerSampleSql(targetSchema: string): string {
  return `INSERT INTO ${targetSchema}.activity_sensor_sample VALUES
  ('${tombstonedActivityId}', '${testUserId}', toDateTime64('2026-07-05 01:00:00', 6, 'UTC'), toDate('2026-07-05'), 'power', 180.0, 100, 1, toDateTime64('2026-07-10 05:31:41', 9, 'UTC'))`;
}

function insertExistingHistoricalSummarySql(targetSchema: string): string {
  return `INSERT INTO ${targetSchema}.activity_sensor_summary_rows (
    activity_id,
    user_id,
    avg_power,
    power_sample_count,
    source_refresh_version,
    refresh_version,
    is_deleted,
    refreshed_at
  ) VALUES (
    '${historicalActivityId}',
    '${testUserId}',
    100.0,
    1,
    50,
    150,
    0,
    toDateTime64('2026-07-10 05:00:00', 9, 'UTC')
  )`;
}

function insertUnrelatedFreshSummarySql(targetSchema: string): string {
  return `INSERT INTO ${targetSchema}.activity_sensor_summary_rows (
    activity_id,
    user_id,
    sample_count,
    source_refresh_version,
    refresh_version,
    is_deleted,
    refreshed_at
  ) VALUES (
    '${unrelatedActivityId}',
    '${testUserId}',
    1,
    200,
    200,
    0,
    toDateTime64('2026-07-10 15:00:00', 9, 'UTC')
  )`;
}

function insertExistingTombstoneSql(targetSchema: string): string {
  return `INSERT INTO ${targetSchema}.activity_sensor_summary_rows (
    activity_id,
    user_id,
    sample_count,
    source_refresh_version,
    refresh_version,
    is_deleted,
    refreshed_at
  ) VALUES (
    '${tombstonedActivityId}',
    '${testUserId}',
    0,
    100,
    200,
    1,
    toDateTime64('2026-07-10 15:00:00', 9, 'UTC')
  )`;
}
