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
const countSchema = z.array(z.object({ count: z.coerce.number().int() }));
const providerSchema = z.array(
  z.object({
    provider_id: z.string(),
  }),
);

function stripDbtModelWrapper(modelSql: string): string {
  return modelSql
    .replace(/\{%\s*set[\s\S]*?%\}\s*/g, "")
    .replace(/\{\{\s*config\([\s\S]*?\)\s*\}\}\s*/g, "")
    .trimStart();
}

function renderProviderStatsSql(
  targetTable: string,
  watermarkTable: string,
  ingestDatabase: string,
  isIncremental: boolean,
  batchSize = 1,
): string {
  return stripDbtModelWrapper(readModelSql("provider_stats.sql"))
    .replaceAll("{{ provider_dirty_key_batch_size }}", String(batchSize))
    .replace(/\{\{\s*ref\('provider_change_watermark'\)\s*\}\}/g, watermarkTable)
    .replace(
      /\{\{\s*source\('ingest',\s*'metric_stream'\)\s*\}\}/g,
      `${ingestDatabase}.metric_stream`,
    )
    .replace(/\{\{\s*source\('postgres_fitness',\s*'([^']+)'\)\s*\}\}/g, `${ingestDatabase}.$1`)
    .replace(
      /\{%\s*if is_incremental\(\)\s*%\}([\s\S]*?)(?:\{%\s*else\s*%\}([\s\S]*?))?\{%\s*endif\s*%\}/g,
      (_, incrementalSql: string, nonIncrementalSql: string | undefined) =>
        isIncremental ? incrementalSql : (nonIncrementalSql ?? ""),
    )
    .replace(/\{\{\s*this\s*\}\}/g, targetTable);
}

function renderDirtyProviderSelectionSql(
  targetTable: string,
  watermarkTable: string,
  isIncremental: boolean,
  batchSize = 1,
): string {
  const modelSql = renderProviderStatsSql(
    targetTable,
    watermarkTable,
    "unused",
    isIncremental,
    batchSize,
  );
  const currentProviderStateSql = extractCteSql(modelSql, "current_provider_state");
  const sourceDirtyProvidersSql = extractCteSql(modelSql, "source_dirty_providers");
  const candidateDirtyProvidersSql = extractCteSql(modelSql, "candidate_dirty_providers");
  const providersSql = extractCteSql(modelSql, "providers");
  const existingProviderStateSql = isIncremental
    ? `existing_provider_state AS (
      ${extractCteSql(modelSql, "existing_provider_state")}
    ),`
    : "";

  return `WITH current_provider_state AS materialized (
    ${currentProviderStateSql}
  ),
  ${existingProviderStateSql}
  source_dirty_providers AS (
    ${sourceDirtyProvidersSql}
  ),
  candidate_dirty_providers AS (
    ${candidateDirtyProvidersSql}
  ),
  providers AS materialized (
    ${providersSql}
  )
  SELECT
    providers.user_id AS user_id,
    providers.provider_id AS provider_id
  FROM providers`;
}

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

function renderProviderConnectionSql(database: string): string {
  const modelSql = readModelSql("provider_stats.sql");
  const currentProvidersSql = extractCteSql(modelSql, "current_providers")
    .replace(/\n\s+UNION DISTINCT[\s\S]*$/, "")
    .replace(
      /\{\{\s*source\('postgres_fitness',\s*'provider_connection'\)\s*\}\}/g,
      `${database}.provider_connection`,
    );

  return `WITH providers AS (
    SELECT {userId:UUID} AS user_id, 'test_provider' AS provider_id
  )
  ${currentProvidersSql}`;
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
    await client.command({
      query: `CREATE TABLE ${ingestDatabase}.provider_connection (
        user_id UUID,
        provider_id String,
        _peerdb_is_deleted Int8,
        _peerdb_version Int64
      )
      ENGINE = ReplacingMergeTree(_peerdb_version)
      ORDER BY (user_id, provider_id)`,
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

  it("tracks provider connection and disconnection versions by provider_id", async () => {
    const userId = randomUUID();
    await client.command({
      query: `INSERT INTO ${ingestDatabase}.provider_connection
        (user_id, provider_id, _peerdb_is_deleted, _peerdb_version)
      VALUES ({userId:UUID}, 'test_provider', 0, 1)`,
      query_params: { userId },
    });

    const result = await client.query({
      query: renderProviderConnectionSql(ingestDatabase),
      query_params: { userId },
      format: "JSONEachRow",
    });

    expect(providerSchema.parse(await result.json())).toEqual([{ provider_id: "test_provider" }]);

    await client.command({
      query: `INSERT INTO ${ingestDatabase}.provider_connection
        (user_id, provider_id, _peerdb_is_deleted, _peerdb_version)
      VALUES ({userId:UUID}, 'test_provider', 1, 2)`,
      query_params: { userId },
    });

    const disconnectedResult = await client.query({
      query: renderProviderConnectionSql(ingestDatabase),
      query_params: { userId },
      format: "JSONEachRow",
    });

    expect(providerSchema.parse(await disconnectedResult.json())).toEqual([]);
  });

  it("recounts at most one dirty provider per incremental batch", async () => {
    const userId = randomUUID();
    const watermarkTable = `${ingestDatabase}.provider_change_watermark_batch`;
    const targetTable = `${ingestDatabase}.provider_stats_batch`;

    await client.command({
      query: `CREATE TABLE ${watermarkTable} (
        user_id UUID,
        provider_id String,
        changed_at DateTime64(9, 'UTC'),
        refresh_version UInt64,
        refreshed_at DateTime64(9, 'UTC')
      ) ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY (user_id, provider_id)`,
    });
    await client.command({
      query: `CREATE TABLE ${targetTable} (
        user_id UUID,
        provider_id String,
        activities UInt64,
        daily_metrics UInt64,
        sleep_sessions UInt64,
        body_measurements UInt64,
        food_entries UInt64,
        health_events UInt64,
        metric_stream UInt64,
        nutrition_daily UInt64,
        lab_panels UInt64,
        lab_results UInt64,
        journal_entries UInt64,
        is_deleted UInt8,
        refresh_version UInt64,
        refreshed_at DateTime64(9, 'UTC')
      ) ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY (user_id, provider_id)`,
    });

    try {
      await client.command({
        query: `INSERT INTO ${watermarkTable} VALUES
          ({userId:UUID}, 'alpha_provider', now64(9), 1, now64(9)),
          ({userId:UUID}, 'beta_provider', now64(9), 1, now64(9))`,
        query_params: { userId },
      });
      await client.command({
        query: `INSERT INTO ${targetTable} VALUES
          ({userId:UUID}, 'alpha_provider', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, now64(9) - INTERVAL 2 HOUR),
          ({userId:UUID}, 'beta_provider', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, now64(9) - INTERVAL 1 HOUR)`,
        query_params: { userId },
      });

      const result = await client.query({
        query: `SELECT uniqExact(provider_id) AS count
          FROM (${renderDirtyProviderSelectionSql(targetTable, watermarkTable, true, 1)})
          SETTINGS join_use_nulls = 1, enable_materialized_cte = 1`,
        format: "JSONEachRow",
      });

      expect(countSchema.parse(await result.json())).toEqual([{ count: 1 }]);
    } finally {
      await client.command({ query: `DROP TABLE IF EXISTS ${targetTable}` });
      await client.command({ query: `DROP TABLE IF EXISTS ${watermarkTable}` });
    }
  });

  it("recounts at most one provider during the initial build", async () => {
    const userId = randomUUID();
    const watermarkTable = `${ingestDatabase}.provider_change_watermark_initial`;
    const targetTable = `${ingestDatabase}.provider_stats_initial`;

    await client.command({
      query: `CREATE TABLE ${watermarkTable} (
        user_id UUID,
        provider_id String,
        changed_at DateTime64(9, 'UTC'),
        refresh_version UInt64,
        refreshed_at DateTime64(9, 'UTC')
      ) ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY (user_id, provider_id)`,
    });
    await client.command({
      query: `CREATE TABLE ${targetTable} (
        user_id UUID,
        provider_id String,
        refreshed_at DateTime64(9, 'UTC')
      ) ENGINE = ReplacingMergeTree(refreshed_at)
      ORDER BY (user_id, provider_id)`,
    });

    try {
      await client.command({
        query: `INSERT INTO ${watermarkTable} VALUES
          ({userId:UUID}, 'alpha_provider', now64(9), 1, now64(9)),
          ({userId:UUID}, 'beta_provider', now64(9), 1, now64(9))`,
        query_params: { userId },
      });

      const result = await client.query({
        query: `SELECT uniqExact(provider_id) AS count
          FROM (${renderDirtyProviderSelectionSql(targetTable, watermarkTable, false, 1)})
          SETTINGS join_use_nulls = 1, enable_materialized_cte = 1`,
        format: "JSONEachRow",
      });

      expect(countSchema.parse(await result.json())).toEqual([{ count: 1 }]);
    } finally {
      await client.command({ query: `DROP TABLE IF EXISTS ${targetTable}` });
      await client.command({ query: `DROP TABLE IF EXISTS ${watermarkTable}` });
    }
  });

  it("preserves old provider rows missing from a partial bootstrap", async () => {
    const userId = randomUUID();
    const watermarkTable = `${ingestDatabase}.provider_change_watermark_partial`;
    const targetTable = `${ingestDatabase}.provider_stats_partial`;

    await client.command({
      query: `CREATE TABLE ${watermarkTable} (
        user_id UUID,
        provider_id String,
        changed_at DateTime64(9, 'UTC'),
        refresh_version UInt64,
        refreshed_at DateTime64(9, 'UTC')
      ) ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY (user_id, provider_id)`,
    });
    await client.command({
      query: `CREATE TABLE ${targetTable} (
        user_id UUID,
        provider_id String,
        refreshed_at DateTime64(9, 'UTC')
      ) ENGINE = ReplacingMergeTree(refreshed_at)
      ORDER BY (user_id, provider_id)`,
    });

    try {
      await client.command({
        query: `INSERT INTO ${watermarkTable} VALUES
          ({userId:UUID}, 'new_provider', now64(9), 1, now64(9))`,
        query_params: { userId },
      });
      await client.command({
        query: `INSERT INTO ${targetTable} VALUES
          ({userId:UUID}, 'legacy_provider', now64(9) - INTERVAL 1 DAY)`,
        query_params: { userId },
      });

      const result = await client.query({
        query: `SELECT provider_id
          FROM (${renderDirtyProviderSelectionSql(targetTable, watermarkTable, true, 1)})
          SETTINGS join_use_nulls = 1, enable_materialized_cte = 1`,
        format: "JSONEachRow",
      });

      expect(providerSchema.parse(await result.json())).toEqual([{ provider_id: "new_provider" }]);
    } finally {
      await client.command({ query: `DROP TABLE IF EXISTS ${targetTable}` });
      await client.command({ query: `DROP TABLE IF EXISTS ${watermarkTable}` });
    }
  });

  it("converges through successive bounded provider batches", async () => {
    const userId = randomUUID();
    const watermarkTable = `${ingestDatabase}.provider_change_watermark_convergence`;
    const targetTable = `${ingestDatabase}.provider_stats_convergence`;

    await client.command({
      query: `CREATE TABLE ${watermarkTable} (
        user_id UUID,
        provider_id String,
        changed_at DateTime64(9, 'UTC'),
        refresh_version UInt64,
        refreshed_at DateTime64(9, 'UTC')
      ) ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY (user_id, provider_id)`,
    });
    await client.command({
      query: `CREATE TABLE ${targetTable} (
        user_id UUID,
        provider_id String,
        refreshed_at DateTime64(9, 'UTC')
      ) ENGINE = ReplacingMergeTree(refreshed_at)
      ORDER BY (user_id, provider_id)`,
    });

    try {
      await client.command({
        query: `INSERT INTO ${watermarkTable} VALUES
          ({userId:UUID}, 'alpha_provider', now64(9) - INTERVAL 3 HOUR, 1, now64(9)),
          ({userId:UUID}, 'beta_provider', now64(9) - INTERVAL 2 HOUR, 1, now64(9)),
          ({userId:UUID}, 'gamma_provider', now64(9) - INTERVAL 1 HOUR, 1, now64(9))`,
        query_params: { userId },
      });

      const selectedProviders: string[] = [];
      for (let batch = 0; batch < 3; batch += 1) {
        const result = await client.query({
          query: `SELECT provider_id
            FROM (${renderDirtyProviderSelectionSql(targetTable, watermarkTable, true, 1)})
            SETTINGS join_use_nulls = 1, enable_materialized_cte = 1`,
          format: "JSONEachRow",
        });
        const rows = providerSchema.parse(await result.json());
        const selectedProvider = rows[0]?.provider_id;
        expect(selectedProvider).toBeDefined();
        selectedProviders.push(selectedProvider ?? "");
        await client.command({
          query: `INSERT INTO ${targetTable}
            VALUES ({userId:UUID}, {providerId:String}, now64(9))`,
          query_params: { providerId: selectedProvider, userId },
        });
      }

      expect(selectedProviders).toEqual(["alpha_provider", "beta_provider", "gamma_provider"]);

      const finalResult = await client.query({
        query: `SELECT provider_id
          FROM (${renderDirtyProviderSelectionSql(targetTable, watermarkTable, true, 1)})
          SETTINGS join_use_nulls = 1, enable_materialized_cte = 1`,
        format: "JSONEachRow",
      });
      expect(providerSchema.parse(await finalResult.json())).toEqual([]);
    } finally {
      await client.command({ query: `DROP TABLE IF EXISTS ${targetTable}` });
      await client.command({ query: `DROP TABLE IF EXISTS ${watermarkTable}` });
    }
  });

  it("prefers the provider with the oldest existing refreshed_at during incremental batches", async () => {
    const userId = randomUUID();
    const watermarkTable = `${ingestDatabase}.provider_change_watermark_fairness`;
    const targetTable = `${ingestDatabase}.provider_stats_fairness`;

    await client.command({
      query: `CREATE TABLE ${watermarkTable} (
        user_id UUID,
        provider_id String,
        changed_at DateTime64(9, 'UTC'),
        refresh_version UInt64,
        refreshed_at DateTime64(9, 'UTC')
      ) ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY (user_id, provider_id)`,
    });
    await client.command({
      query: `CREATE TABLE ${targetTable} (
        user_id UUID,
        provider_id String,
        activities UInt64,
        daily_metrics UInt64,
        sleep_sessions UInt64,
        body_measurements UInt64,
        food_entries UInt64,
        health_events UInt64,
        metric_stream UInt64,
        nutrition_daily UInt64,
        lab_panels UInt64,
        lab_results UInt64,
        journal_entries UInt64,
        is_deleted UInt8,
        refresh_version UInt64,
        refreshed_at DateTime64(9, 'UTC')
      ) ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY (user_id, provider_id)`,
    });

    try {
      await client.command({
        query: `INSERT INTO ${watermarkTable} VALUES
          ({userId:UUID}, 'alpha_provider', now64(9), 1, now64(9)),
          ({userId:UUID}, 'beta_provider', now64(9), 1, now64(9))`,
        query_params: { userId },
      });
      await client.command({
        query: `INSERT INTO ${targetTable} VALUES
          ({userId:UUID}, 'alpha_provider', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, now64(9) - INTERVAL 2 HOUR),
          ({userId:UUID}, 'beta_provider', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1, now64(9) - INTERVAL 1 HOUR)`,
        query_params: { userId },
      });

      const result = await client.query({
        query: `SELECT provider_id
          FROM (${renderDirtyProviderSelectionSql(targetTable, watermarkTable, true, 1)})
          SETTINGS join_use_nulls = 1, enable_materialized_cte = 1`,
        format: "JSONEachRow",
      });

      expect(providerSchema.parse(await result.json())).toEqual([
        { provider_id: "alpha_provider" },
      ]);
    } finally {
      await client.command({ query: `DROP TABLE IF EXISTS ${targetTable}` });
      await client.command({ query: `DROP TABLE IF EXISTS ${watermarkTable}` });
    }
  });
});
