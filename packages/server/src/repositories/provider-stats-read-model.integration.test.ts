import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  extractCteSql,
  readModelSql,
} from "../../../../analytics/models/read_models/read-model-sql-test-helpers.ts";
import {
  type ClickHouseClient,
  createClickHouseClientFromEnv,
} from "../../../../src/db/clickhouse.ts";
import { buildIngestMetricStreamCreateTableSql } from "../../../../src/metric-stream/clickhouse-table.ts";

const providerCountSchema = z.array(
  z.object({
    metric_stream: z.coerce.number().int(),
  }),
);

function renderMetricStreamCountSql(ingestDatabase: string): string {
  const modelSql = readModelSql("provider_stats.sql");
  const currentSql = extractCteSql(modelSql, "metric_stream_current").replace(
    /\{\{\s*source\('ingest',\s*'metric_stream'\)\s*\}\}/g,
    `${ingestDatabase}.metric_stream`,
  );
  const countsSql = extractCteSql(modelSql, "metric_stream_counts");

  return `WITH providers AS (
    SELECT {userId:UUID} AS user_id, 'test_provider' AS provider_id
  ),
  metric_stream_current AS (
    ${currentSql}
  ),
  metric_stream_counts AS (
    ${countsSql}
  )
  SELECT metric_stream_counts.count AS metric_stream
  FROM metric_stream_counts
  WHERE user_id = {userId:UUID}
    AND provider_id = 'test_provider'`;
}

describe("provider stats read model", () => {
  const ingestDatabase = `ingest_provider_stats_${randomUUID().replaceAll("-", "")}`;
  let client: ClickHouseClient;

  beforeAll(async () => {
    client = createClickHouseClientFromEnv();
    await client.command({ query: `CREATE DATABASE ${ingestDatabase}` });
    await client.command({
      query: buildIngestMetricStreamCreateTableSql().replace(
        "ingest.metric_stream",
        `${ingestDatabase}.metric_stream`,
      ),
    });
  });

  afterAll(async () => {
    await client?.command({ query: `DROP DATABASE IF EXISTS ${ingestDatabase}` });
  });

  it("counts only the current live version of each metric-stream row", async () => {
    const userId = randomUUID();
    const deletedId = randomUUID();
    const liveId = randomUUID();
    const recordedAt = "2026-07-20 12:00:00";

    await client.command({
      query: `INSERT INTO ${ingestDatabase}.metric_stream (
        id, activity_id, user_id, recorded_at, channel, provider_id, external_id,
        device_id, source_type, scalar, vector, point, metadata, ingested_at,
        is_deleted, version, generation
      ) VALUES
        (
          {deletedId:UUID}, NULL, {userId:UUID}, {recordedAt:DateTime64(6, 'UTC')}, 'heart_rate', 'test_provider',
          NULL, NULL, 'api', 60, [], '', '', now64(9) - INTERVAL 1 SECOND, 0, 1, 0
        ),
        (
          {deletedId:UUID}, NULL, {userId:UUID}, {recordedAt:DateTime64(6, 'UTC')}, 'heart_rate', 'test_provider',
          NULL, NULL, 'api', 60, [], '', '', now64(9), 1, 2, 0
        ),
        (
          {liveId:UUID}, NULL, {userId:UUID}, {recordedAt:DateTime64(6, 'UTC')}, 'heart_rate', 'test_provider',
          NULL, NULL, 'api', 61, [], '', '', now64(9), 0, 1, 0
        )`,
      query_params: { deletedId, liveId, recordedAt, userId },
    });

    const result = await client.query({
      query: renderMetricStreamCountSql(ingestDatabase),
      query_params: { userId },
      format: "JSONEachRow",
    });

    expect(providerCountSchema.parse(await result.json())).toEqual([{ metric_stream: 1 }]);
  });
});
