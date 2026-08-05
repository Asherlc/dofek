import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  extractCteSql,
  readModelSql,
  renderDbtModelSql,
} from "../../../../analytics/models/read_models/read-model-sql-test-helpers.ts";
import {
  type ClickHouseClient,
  createClickHouseClientFromEnv,
} from "../../../../src/db/clickhouse.ts";

const countSchema = z.array(z.object({ count: z.coerce.number().int() }));
const providerSchema = z.array(
  z.object({
    provider_id: z.string(),
  }),
);
function renderProviderStatsSql(
  targetTable: string,
  watermarkTable: string,
  ingestDatabase: string,
  isIncremental: boolean,
  batchSize = 1,
): string {
  return renderDbtModelSql(readModelSql("provider_stats.sql"), { isIncremental })
    .replaceAll("{{ provider_dirty_key_batch_size }}", String(batchSize))
    .replace(/\{\{\s*ref\('provider_change_watermark'\)\s*\}\}/g, watermarkTable)
    .replace(
      /\{\{\s*source\('analytics',\s*'metric_stream_day_change'\)\s*\}\}/g,
      `${ingestDatabase}.metric_stream_day_change`,
    )
    .replace(
      /\{\{\s*ref\('provider_metric_stream_daily'\)\s*\}\}/g,
      `${ingestDatabase}.provider_metric_stream_daily`,
    )
    .replace(/\{\{\s*source\('postgres_fitness',\s*'([^']+)'\)\s*\}\}/g, `${ingestDatabase}.$1`)
    .replaceAll("analytics.body_measurement_sample", `${ingestDatabase}.body_measurement_sample`)
    .replace(/\{\{\s*this\s*\}\}/g, targetTable);
}

function renderDirtyProviderSelectionSql(
  targetTable: string,
  watermarkTable: string,
  isIncremental: boolean,
  batchSize = 1,
): string {
  const separatorIndex = targetTable.indexOf(".");
  if (separatorIndex <= 0 || separatorIndex === targetTable.length - 1) {
    throw new Error(`Expected database-qualified provider stats target: ${targetTable}`);
  }
  const ingestDatabase = targetTable.slice(0, separatorIndex);
  const modelSql = renderProviderStatsSql(
    targetTable,
    watermarkTable,
    ingestDatabase,
    isIncremental,
    batchSize,
  );
  const currentProviderStateSql = extractCteSql(modelSql, "current_provider_state");
  const sourceDirtyProvidersSql = extractCteSql(modelSql, "source_dirty_providers");
  const metricStreamDailySourceStateSql = extractCteSql(
    modelSql,
    "metric_stream_daily_source_state",
  );
  const metricStreamDailyTargetStateSql = extractCteSql(
    modelSql,
    "metric_stream_daily_target_state",
  );
  const metricStreamDailyDirtyProvidersSql = extractCteSql(
    modelSql,
    "metric_stream_daily_dirty_providers",
  );
  const candidateDirtyProvidersSql = extractCteSql(modelSql, "candidate_dirty_providers");
  const providersSql = extractCteSql(modelSql, "providers");
  const existingProviderStateSql = isIncremental
    ? `existing_provider_state AS (
      ${extractCteSql(modelSql, "existing_provider_state")}
    ),`
    : "";

  return `WITH current_provider_state AS (
    ${currentProviderStateSql}
  ),
  ${existingProviderStateSql}
  source_dirty_providers AS materialized (
    ${sourceDirtyProvidersSql}
  ),
  metric_stream_daily_source_state AS (
    ${metricStreamDailySourceStateSql}
  ),
  metric_stream_daily_target_state AS (
    ${metricStreamDailyTargetStateSql}
  ),
  metric_stream_daily_dirty_providers AS (
    ${metricStreamDailyDirtyProvidersSql}
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

function renderMetricStreamCountSql(
  targetTable: string,
  watermarkTable: string,
  ingestDatabase: string,
  isIncremental: boolean,
  batchSize = 1,
): string {
  const modelSql = renderProviderStatsSql(
    targetTable,
    watermarkTable,
    ingestDatabase,
    isIncremental,
    batchSize,
  );
  const countsSql = extractCteSql(modelSql, "metric_stream_counts");

  return `WITH providers AS (
    SELECT {userId:UUID} AS user_id, 'test_provider' AS provider_id
  ),
  metric_stream_counts AS (
    ${countsSql}
  )
  SELECT metric_stream_counts.count AS count
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
      query: `CREATE TABLE ${ingestDatabase}.metric_stream_day_change (
        user_id UUID,
        provider_id String,
        recorded_date Date,
        changed_at SimpleAggregateFunction(max, DateTime64(9, 'UTC'))
      )
      ENGINE = AggregatingMergeTree
      ORDER BY (user_id, provider_id, recorded_date)`,
    });
    await client.command({
      query: `CREATE TABLE ${ingestDatabase}.provider_metric_stream_daily (
        user_id UUID,
        provider_id String,
        recorded_date Date,
        metric_stream_count UInt64,
        source_changed_at DateTime64(9, 'UTC'),
        refresh_version UInt64,
        refreshed_at DateTime64(9, 'UTC')
      )
      ENGINE = ReplacingMergeTree(refresh_version)
      ORDER BY (user_id, provider_id, recorded_date)`,
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

  it("sums daily metric rows and holds provider publication until day state catches up", async () => {
    const userId = randomUUID();
    const watermarkTable = `${ingestDatabase}.provider_change_watermark_daily_readiness`;
    const targetTable = `${ingestDatabase}.provider_stats_daily_readiness`;
    const recordedDate = "2026-08-01";
    const markerChangedAt = "2026-08-02 12:00:00";

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
        query: `INSERT INTO ${watermarkTable}
          VALUES ({userId:UUID}, 'test_provider', '2026-08-02 10:00:00', 1, '2026-08-02 10:00:00')`,
        query_params: { userId },
      });
      await client.command({
        query: `INSERT INTO ${targetTable}
          VALUES ({userId:UUID}, 'test_provider', '2026-08-02 09:00:00')`,
        query_params: { userId },
      });
      await client.command({
        query: `INSERT INTO ${ingestDatabase}.metric_stream_day_change
          VALUES ({userId:UUID}, 'test_provider', {recordedDate:Date}, {changedAt:DateTime64(9, 'UTC')})`,
        query_params: { changedAt: markerChangedAt, recordedDate, userId },
      });
      await client.command({
        query: `INSERT INTO ${ingestDatabase}.provider_metric_stream_daily
          VALUES ({userId:UUID}, 'test_provider', {recordedDate:Date}, 7, '2026-08-02 13:00:00', 1, '2026-08-02 11:00:00')`,
        query_params: { recordedDate, userId },
      });

      await client.command({
        query: `INSERT INTO ${ingestDatabase}.provider_metric_stream_daily
          VALUES ({userId:UUID}, 'test_provider', {recordedDate:Date}, 7, '2026-08-02 11:00:00', 2, '2026-08-02 12:01:00')`,
        query_params: { recordedDate, userId },
      });

      const blockedResult = await client.query({
        query: renderDirtyProviderSelectionSql(targetTable, watermarkTable, true),
        format: "JSONEachRow",
      });
      expect(providerSchema.parse(await blockedResult.json())).toEqual([]);

      const countResult = await client.query({
        query: renderMetricStreamCountSql(targetTable, watermarkTable, ingestDatabase, true),
        query_params: { userId },
        format: "JSONEachRow",
      });
      expect(countSchema.parse(await countResult.json())).toEqual([{ count: 7 }]);

      await client.command({
        query: `INSERT INTO ${ingestDatabase}.provider_metric_stream_daily
          VALUES ({userId:UUID}, 'test_provider', {recordedDate:Date}, 7, {changedAt:DateTime64(9, 'UTC')}, 3, '2026-08-02 12:02:00')`,
        query_params: { changedAt: markerChangedAt, recordedDate, userId },
      });

      const readyResult = await client.query({
        query: renderDirtyProviderSelectionSql(targetTable, watermarkTable, true),
        format: "JSONEachRow",
      });
      expect(providerSchema.parse(await readyResult.json())).toEqual([
        { provider_id: "test_provider" },
      ]);
    } finally {
      await client.command({ query: `DROP TABLE IF EXISTS ${targetTable}` });
      await client.command({ query: `DROP TABLE IF EXISTS ${watermarkTable}` });
    }
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

  it("executes the full provider stats model with a materialized dirty-provider set", async () => {
    const userId = randomUUID();
    const watermarkTable = `${ingestDatabase}.provider_change_watermark_full_model`;
    const rawTableDefinitions = [
      {
        name: "activity",
        columns: `
          user_id UUID,
          provider_id String,
          provider_absent_at Nullable(DateTime64(9, 'UTC')),
          deleted_at Nullable(DateTime64(9, 'UTC')),
          _peerdb_is_deleted Int8,
          _peerdb_version Int64`,
      },
      {
        name: "daily_metrics",
        columns: `
          user_id UUID,
          provider_id String,
          _peerdb_is_deleted Int8,
          _peerdb_version Int64`,
      },
      {
        name: "sleep_session",
        columns: `
          user_id UUID,
          provider_id String,
          _peerdb_is_deleted Int8,
          _peerdb_version Int64`,
      },
      {
        name: "food_entry",
        columns: `
          user_id UUID,
          provider_id String,
          date Date,
          _peerdb_is_deleted Int8,
          _peerdb_version Int64`,
      },
      {
        name: "health_event",
        columns: `
          user_id UUID,
          provider_id String,
          _peerdb_is_deleted Int8,
          _peerdb_version Int64`,
      },
      {
        name: "lab_panel",
        columns: `
          user_id UUID,
          provider_id String,
          _peerdb_is_deleted Int8,
          _peerdb_version Int64`,
      },
      {
        name: "lab_result",
        columns: `
          user_id UUID,
          provider_id String,
          _peerdb_is_deleted Int8,
          _peerdb_version Int64`,
      },
      {
        name: "journal_entry",
        columns: `
          user_id UUID,
          provider_id String,
          _peerdb_is_deleted Int8,
          _peerdb_version Int64`,
      },
      {
        name: "body_measurement_sample",
        columns: `
          user_id UUID,
          provider_id String,
          channel String,
          external_id Nullable(String),
          recorded_at DateTime64(9, 'UTC'),
          device_id Nullable(String),
          _peerdb_is_deleted Int8,
          _peerdb_version Int64`,
      },
    ];
    const rawTableNames = rawTableDefinitions.map(({ name }) => `${ingestDatabase}.${name}`);

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
    for (const { name, columns } of rawTableDefinitions) {
      await client.command({
        query: `CREATE TABLE ${ingestDatabase}.${name} (${columns})
          ENGINE = ReplacingMergeTree(_peerdb_version)
          ORDER BY (user_id, provider_id)`,
      });
    }

    try {
      await client.command({
        query: `INSERT INTO ${watermarkTable}
          VALUES ({userId:UUID}, 'test_provider', '2026-08-02 10:00:00', 1, '2026-08-02 10:00:00')`,
        query_params: { userId },
      });

      const modelSql = `${renderProviderStatsSql(
        `${ingestDatabase}.provider_stats_full_model`,
        watermarkTable,
        ingestDatabase,
        false,
      )}
        SETTINGS join_use_nulls = 1, enable_materialized_cte = 1, max_threads = 1`;
      const result = await client.query({ query: modelSql, format: "JSONEachRow" });
      const rows = await result.json();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        provider_id: "test_provider",
        activities: 0,
        daily_metrics: 0,
        sleep_sessions: 0,
        body_measurements: 0,
        food_entries: 0,
        health_events: 0,
        metric_stream: 0,
        nutrition_daily: 0,
        lab_panels: 0,
        lab_results: 0,
        journal_entries: 0,
        is_deleted: 1,
      });

      const explainResult = await client.query({
        query: `EXPLAIN PIPELINE compact = 1 ${modelSql}`,
        format: "JSONEachRow",
      });
      expect(await explainResult.json()).not.toHaveLength(0);
    } finally {
      for (const tableName of [watermarkTable, ...rawTableNames]) {
        await client.command({ query: `DROP TABLE IF EXISTS ${tableName}` });
      }
    }
  });
});
