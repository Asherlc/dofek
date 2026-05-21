import { Client, escapeIdentifier } from "pg";
import { z } from "zod";
import { logger } from "../logger.ts";
import {
  buildClickHouseBootstrapStatements,
  CLICKHOUSE_DEFAULT_SETTINGS,
  type ClickHouseCommandClient,
  parsePostgresConnectionForClickHouse,
  waitForClickHouseTable,
} from "./clickhouse.ts";
import { buildActivitySummaryReadModelStatements } from "./clickhouse-metric-stream-bootstrap.ts";
import { buildPostgresFitnessRawTableStatements } from "./clickhouse-raw-tables.ts";
import {
  buildActivityTrendDailyReadModelStatements,
  buildBodyMeasurementReadModelStatements,
  buildBodyMeasurementSampleProjectionMigrationStatements,
  buildProviderStatsReadModelStatements,
} from "./clickhouse-read-models.ts";
import { buildRestingHeartRateSleepWindowMaterializedViewStatements } from "./clickhouse-resting-heart-rate-materialized-view.ts";

interface MigrationCountRow {
  migration_count: number | string;
}

interface MetricStreamBackfillChunkRow {
  lower_bound: string | null;
  upper_bound: string | null;
}

interface MetricStreamBackfillChunkRange {
  lower_bound: string;
  upper_bound: string;
}

interface MetricStreamBackfillRange {
  lowerBound: Date;
  upperBound: Date;
}

interface CompletedMetricStreamBackfillRange {
  lowerBound: Date;
  upperBound: Date;
}

interface CompletedMetricStreamBackfillRangeRow {
  lower_bound: string;
  upper_bound: string;
}

interface TimescaleChunkRow {
  chunk_schema: string;
  chunk_name: string;
}

const metricStreamBackfillChunkRowSchema = z.object({
  lower_bound: z.string().nullable(),
  upper_bound: z.string().nullable(),
});

const completedMetricStreamBackfillRangeSchema = z.object({
  lower_bound: z.string(),
  upper_bound: z.string(),
});

const timescaleChunkRowSchema = z.object({
  chunk_schema: z.string(),
  chunk_name: z.string(),
});

interface ClickHouseDatabaseEngineRow {
  engine: string;
}

const clickHouseDatabaseEngineRowSchema = z.object({
  engine: z.string(),
});

const METRIC_STREAM_BACKFILL_RANGE_MILLISECONDS = 5 * 60 * 1_000;
const CURRENT_METRIC_STREAM_REQUIRED_COLUMNS = [
  "external_id",
  "device_id",
  "source_type",
  "activity_id",
  "point",
];

function clickHouseStringLiteral(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

interface ClickHouseMigrationBase {
  id: string;
  requiresPreviouslyAppliedMigrationId?: string;
}

type ClickHouseMigration =
  | ({
      statements: string[];
    } & ClickHouseMigrationBase)
  | ({
      run: (client: ClickHouseCommandClient, postgresConnectionString: string) => Promise<void>;
    } & ClickHouseMigrationBase);

function clickHouseMigrations(postgresConnectionString: string): ClickHouseMigration[] {
  return [
    {
      id: "0001_clickhouse_analytics_schema_cleanup",
      statements: [
        "DROP VIEW IF EXISTS analytics.activity_summary",
        "DROP TABLE IF EXISTS analytics.activity_summary",
        "DROP VIEW IF EXISTS analytics.deduped_sensor",
        "DROP TABLE IF EXISTS analytics.deduped_sensor",
        "DROP VIEW IF EXISTS fitness.activity_summary",
        "DROP TABLE IF EXISTS fitness.activity_summary",
        "DROP VIEW IF EXISTS fitness.deduped_sensor",
        "DROP TABLE IF EXISTS fitness.deduped_sensor",
        "DROP TABLE IF EXISTS fitness.activity_sensor_window",
        "DROP TABLE IF EXISTS fitness.metric_stream_sync_log",
        "DROP TABLE IF EXISTS fitness.metric_stream",
      ],
    },
    {
      id: "0002_clickhouse_postgres_bridge_and_activity_read_models",
      statements: buildClickHouseBootstrapStatements(postgresConnectionString),
    },
    {
      id: "0004_reenable_materialized_metric_stream",
      statements: [
        "DROP VIEW IF EXISTS analytics.activity_summary",
        "DROP TABLE IF EXISTS analytics.activity_summary",
        "DROP VIEW IF EXISTS analytics.deduped_sensor",
        "DROP TABLE IF EXISTS analytics.deduped_sensor",
        "DROP DATABASE IF EXISTS postgres_fitness SYNC",
        ...buildClickHouseBootstrapStatements(postgresConnectionString),
      ],
    },
    {
      id: "0005_backfill_materialized_metric_stream",
      statements: [],
    },
    {
      id: "0006_backfill_native_metric_stream",
      run: replaceNativeMetricStreamAndBackfill,
    },
    {
      id: "0007_remaining_postgres_views_to_clickhouse",
      statements: [
        "DROP VIEW IF EXISTS analytics.activity_summary",
        "DROP TABLE IF EXISTS analytics.activity_summary",
        "DROP VIEW IF EXISTS analytics.deduped_sensor",
        "DROP TABLE IF EXISTS analytics.deduped_sensor",
        "DROP VIEW IF EXISTS analytics.v_activity_members",
        "DROP TABLE IF EXISTS analytics.v_activity_members",
        "DROP VIEW IF EXISTS analytics.v_activity",
        "DROP TABLE IF EXISTS analytics.v_activity",
        "DROP VIEW IF EXISTS analytics.v_sleep",
        "DROP TABLE IF EXISTS analytics.v_sleep",
        "DROP VIEW IF EXISTS analytics.v_body_measurement",
        "DROP TABLE IF EXISTS analytics.v_body_measurement",
        "DROP VIEW IF EXISTS analytics.v_daily_metrics",
        "DROP TABLE IF EXISTS analytics.v_daily_metrics",
        "DROP VIEW IF EXISTS analytics.derived_resting_heart_rate",
        "DROP TABLE IF EXISTS analytics.derived_resting_heart_rate",
        "DROP VIEW IF EXISTS analytics.provider_stats",
        "DROP TABLE IF EXISTS analytics.provider_stats",
        ...buildClickHouseBootstrapStatements(postgresConnectionString),
      ],
    },
    {
      id: "0007_repair_legacy_metric_stream_engine",
      run: replaceLegacyMetricStreamIfNeeded,
    },
    {
      id: "0008_complete_provider_stats_raw_mirrors",
      statements: [
        ...buildPostgresFitnessRawTableStatements(),
        ...buildProviderStatsReadModelStatements(),
      ],
    },
    {
      id: "0009_drop_derived_resting_heart_rate_read_model",
      statements: [
        "DROP VIEW IF EXISTS analytics.derived_resting_heart_rate",
        "DROP TABLE IF EXISTS analytics.derived_resting_heart_rate",
      ],
    },
    {
      id: "0010_include_standalone_deduped_sensor_samples",
      statements: [
        "DROP VIEW IF EXISTS analytics.activity_summary",
        "DROP TABLE IF EXISTS analytics.activity_summary",
        "DROP VIEW IF EXISTS analytics.deduped_sensor",
        "DROP TABLE IF EXISTS analytics.deduped_sensor",
        ...buildClickHouseBootstrapStatements(postgresConnectionString),
      ],
    },
    {
      id: "0011_activity_trend_daily_read_model",
      statements: buildActivityTrendDailyReadModelStatements(),
    },
    {
      id: "0012_repair_metric_stream_backfill",
      requiresPreviouslyAppliedMigrationId: "0006_backfill_native_metric_stream",
      run: repairNativeMetricStreamBackfill,
    },
    {
      id: "0013_metric_stream_location_point",
      run: rebuildMetricStreamLocationPoint,
    },
    {
      id: "0014_resting_heart_rate_sleep_window_materialized_view",
      statements: buildRestingHeartRateSleepWindowMaterializedViewStatements(),
    },
    {
      id: "0015_activity_summary_centroids",
      statements: [
        "DROP VIEW IF EXISTS analytics.activity_summary_before_centroids",
        "DROP TABLE IF EXISTS analytics.activity_summary_before_centroids",
        "DROP VIEW IF EXISTS analytics.activity_summary_centroids_next",
        "DROP TABLE IF EXISTS analytics.activity_summary_centroids_next",
        ...buildActivitySummaryReadModelStatements("analytics.activity_summary_centroids_next"),
        "RENAME TABLE analytics.activity_summary TO analytics.activity_summary_before_centroids, analytics.activity_summary_centroids_next TO analytics.activity_summary",
        "DROP VIEW IF EXISTS analytics.activity_summary_before_centroids",
        "DROP TABLE IF EXISTS analytics.activity_summary_before_centroids",
      ],
    },
    {
      id: "0016_reduce_metric_stream_refresh_load",
      statements: [
        "ALTER TABLE analytics.deduped_sensor MODIFY REFRESH EVERY 15 MINUTE",
        "ALTER TABLE analytics.deduped_location MODIFY REFRESH EVERY 15 MINUTE",
        "ALTER TABLE analytics.activity_summary MODIFY REFRESH EVERY 15 MINUTE OFFSET 10 SECOND",
        "ALTER TABLE analytics.v_body_measurement MODIFY REFRESH EVERY 15 MINUTE",
        "ALTER TABLE analytics.provider_stats MODIFY REFRESH EVERY 15 MINUTE",
        "ALTER TABLE analytics.activity_trend_daily MODIFY REFRESH EVERY 15 MINUTE OFFSET 20 SECOND",
      ],
    },
    {
      id: "0017_body_measurement_sample_projection",
      statements: [
        ...buildBodyMeasurementSampleProjectionMigrationStatements(),
        ...buildBodyMeasurementReadModelStatements(),
        ...buildProviderStatsReadModelStatements(),
      ],
    },
  ];
}

export function buildClickHouseMigrationStatements(postgresConnectionString: string): string[] {
  return clickHouseMigrations(postgresConnectionString).flatMap((migration) =>
    "statements" in migration ? migration.statements : [],
  );
}

export async function runClickHouseMigrations(
  client: ClickHouseCommandClient,
  postgresConnectionString: string,
): Promise<number> {
  if (!client.query) {
    throw new Error("ClickHouse migrations require a query-capable client");
  }

  await client.command({ query: "CREATE DATABASE IF NOT EXISTS analytics" });
  await client.command({ query: "CREATE DATABASE IF NOT EXISTS fitness" });
  await client.command({
    query: `CREATE TABLE IF NOT EXISTS analytics.schema_migrations (
  id String,
  applied_at DateTime DEFAULT now()
)
ENGINE = MergeTree
ORDER BY id`,
  });

  let appliedCount = 0;
  const initiallyAppliedMigrationIds = new Set<string>();
  for (const migration of clickHouseMigrations(postgresConnectionString)) {
    const migrationId = clickHouseStringLiteral(migration.id);
    const result = await client.query<MigrationCountRow>({
      query: `SELECT count() AS migration_count FROM analytics.schema_migrations WHERE id = ${migrationId}`,
      format: "JSONEachRow",
    });
    const rows = await result.json();
    const wasAppliedBeforeThisRun = Number(rows[0]?.migration_count ?? 0) > 0;
    if (wasAppliedBeforeThisRun) {
      initiallyAppliedMigrationIds.add(migration.id);
      continue;
    }

    logger.info(`[migrate] Applying ClickHouse migration: ${migration.id}`);
    if (
      migration.requiresPreviouslyAppliedMigrationId &&
      !initiallyAppliedMigrationIds.has(migration.requiresPreviouslyAppliedMigrationId)
    ) {
      logger.info(
        `[migrate] Skipping ClickHouse migration body: ${migration.id} requires ${migration.requiresPreviouslyAppliedMigrationId} to have been applied before this run`,
      );
    } else if ("statements" in migration) {
      for (const statement of migration.statements) {
        await runClickHouseMigrationStatement(client, statement);
      }
    } else {
      await migration.run(client, postgresConnectionString);
    }
    await client.command({
      query: `INSERT INTO analytics.schema_migrations (id) VALUES (${migrationId})`,
    });
    logger.info(`[migrate] Applied ClickHouse migration: ${migration.id}`);
    appliedCount += 1;
  }

  return appliedCount;
}

async function replaceNativeMetricStreamAndBackfill(
  client: ClickHouseCommandClient,
  postgresConnectionString: string,
): Promise<void> {
  const resetStatements = [
    "DROP VIEW IF EXISTS analytics.activity_summary",
    "DROP TABLE IF EXISTS analytics.activity_summary",
    "DROP VIEW IF EXISTS analytics.deduped_sensor",
    "DROP TABLE IF EXISTS analytics.deduped_sensor",
  ];

  for (const statement of resetStatements) {
    await runClickHouseMigrationStatement(client, statement);
  }

  if (await shouldReplacePostgresFitnessDatabase(client)) {
    await runClickHouseMigrationStatement(
      client,
      "DROP TABLE IF EXISTS analytics.metric_stream_backfill_chunks",
    );
    await runClickHouseMigrationStatement(client, "DROP DATABASE IF EXISTS postgres_fitness SYNC");
  }

  for (const statement of buildClickHouseBootstrapStatements(postgresConnectionString).filter(
    shouldRunBeforeMetricStreamBackfill,
  )) {
    await runClickHouseMigrationStatement(client, statement);
  }

  await backfillNativeMetricStream(client, postgresConnectionString);
  await runClickHouseMigrationStatement(client, "SYSTEM REFRESH VIEW analytics.deduped_sensor");
  await runClickHouseMigrationStatement(client, "SYSTEM WAIT VIEW analytics.deduped_sensor");
  await runClickHouseMigrationStatement(client, "SYSTEM REFRESH VIEW analytics.deduped_location");
  await runClickHouseMigrationStatement(client, "SYSTEM WAIT VIEW analytics.deduped_location");
  await runClickHouseMigrationStatement(client, "SYSTEM REFRESH VIEW analytics.activity_summary");
  await runClickHouseMigrationStatement(client, "SYSTEM WAIT VIEW analytics.activity_summary");
}

async function repairNativeMetricStreamBackfill(
  client: ClickHouseCommandClient,
  postgresConnectionString: string,
): Promise<void> {
  if (!(await metricStreamMirrorHasColumns(client, CURRENT_METRIC_STREAM_REQUIRED_COLUMNS))) {
    logger.info(
      "[migrate] Skipping ClickHouse metric_stream repair backfill because the mirror schema is older than the current metric_stream shape; a later migration will rebuild it",
    );
    return;
  }
  await runClickHouseMigrationStatement(
    client,
    "DROP TABLE IF EXISTS analytics.metric_stream_backfill_chunks",
  );
  await backfillNativeMetricStream(client, postgresConnectionString);
  await runClickHouseMigrationStatement(client, "SYSTEM REFRESH VIEW analytics.deduped_sensor");
  await runClickHouseMigrationStatement(client, "SYSTEM WAIT VIEW analytics.deduped_sensor");
  await runClickHouseMigrationStatement(client, "SYSTEM REFRESH VIEW analytics.deduped_location");
  await runClickHouseMigrationStatement(client, "SYSTEM WAIT VIEW analytics.deduped_location");
  await runClickHouseMigrationStatement(client, "SYSTEM REFRESH VIEW analytics.activity_summary");
  await runClickHouseMigrationStatement(client, "SYSTEM WAIT VIEW analytics.activity_summary");
  await runClickHouseMigrationStatement(
    client,
    "SYSTEM REFRESH VIEW analytics.activity_trend_daily",
  );
  await runClickHouseMigrationStatement(client, "SYSTEM WAIT VIEW analytics.activity_trend_daily");
}

async function metricStreamMirrorHasColumns(
  client: ClickHouseCommandClient,
  columns: string[],
): Promise<boolean> {
  if (!client.query) {
    throw new Error("ClickHouse migrations require a query-capable client");
  }
  const columnNames = columns.map(clickHouseStringLiteral).join(", ");
  const result = await client.query<MigrationCountRow>({
    query: `SELECT count() AS migration_count
FROM system.columns
WHERE database = 'postgres_fitness'
  AND table = 'metric_stream'
  AND name IN (${columnNames})`,
    format: "JSONEachRow",
  });
  const rows = await result.json();
  return Number(rows[0]?.migration_count ?? 0) === columns.length;
}

async function rebuildMetricStreamLocationPoint(
  client: ClickHouseCommandClient,
  postgresConnectionString: string,
): Promise<void> {
  const resetStatements = [
    "DROP VIEW IF EXISTS analytics.activity_summary",
    "DROP TABLE IF EXISTS analytics.activity_summary",
    "DROP VIEW IF EXISTS analytics.deduped_location",
    "DROP TABLE IF EXISTS analytics.deduped_location",
    "DROP VIEW IF EXISTS analytics.deduped_sensor",
    "DROP TABLE IF EXISTS analytics.deduped_sensor",
  ];

  for (const statement of resetStatements) {
    await runClickHouseMigrationStatement(client, statement);
  }

  if (!(await metricStreamMirrorHasColumns(client, CURRENT_METRIC_STREAM_REQUIRED_COLUMNS))) {
    await runClickHouseMigrationStatement(
      client,
      "DROP TABLE IF EXISTS analytics.metric_stream_backfill_chunks",
    );
    await runClickHouseMigrationStatement(
      client,
      "DROP TABLE IF EXISTS postgres_fitness.metric_stream",
    );
  }

  for (const statement of buildClickHouseBootstrapStatements(postgresConnectionString).filter(
    shouldRunBeforeMetricStreamBackfill,
  )) {
    await runClickHouseMigrationStatement(client, statement);
  }

  await backfillNativeMetricStream(client, postgresConnectionString);
  await runClickHouseMigrationStatement(client, "SYSTEM REFRESH VIEW analytics.deduped_sensor");
  await runClickHouseMigrationStatement(client, "SYSTEM WAIT VIEW analytics.deduped_sensor");
  await runClickHouseMigrationStatement(client, "SYSTEM REFRESH VIEW analytics.deduped_location");
  await runClickHouseMigrationStatement(client, "SYSTEM WAIT VIEW analytics.deduped_location");
  await runClickHouseMigrationStatement(client, "SYSTEM REFRESH VIEW analytics.activity_summary");
  await runClickHouseMigrationStatement(client, "SYSTEM WAIT VIEW analytics.activity_summary");
}

function shouldRunBeforeMetricStreamBackfill(statement: string): boolean {
  return (
    !statement.startsWith("SYSTEM REFRESH VIEW analytics.deduped_sensor") &&
    !statement.startsWith("SYSTEM WAIT VIEW analytics.deduped_sensor") &&
    !statement.startsWith("SYSTEM REFRESH VIEW analytics.deduped_location") &&
    !statement.startsWith("SYSTEM WAIT VIEW analytics.deduped_location") &&
    !statement.startsWith("SYSTEM REFRESH VIEW analytics.activity_summary") &&
    !statement.startsWith("SYSTEM WAIT VIEW analytics.activity_summary")
  );
}

async function shouldReplacePostgresFitnessDatabase(
  client: ClickHouseCommandClient,
): Promise<boolean> {
  if (!client.query) {
    throw new Error("ClickHouse migrations require a query-capable client");
  }
  const result = await client.query<ClickHouseDatabaseEngineRow>({
    query: "SELECT engine FROM system.databases WHERE name = 'postgres_fitness'",
    format: "JSONEachRow",
  });
  const rows = await result.json();
  if (!rows[0]) {
    return false;
  }
  const row = clickHouseDatabaseEngineRowSchema.parse(rows[0]);
  return row.engine !== "Atomic" && row.engine !== "Ordinary";
}

async function replaceLegacyMetricStreamIfNeeded(
  client: ClickHouseCommandClient,
  postgresConnectionString: string,
): Promise<void> {
  if (!(await shouldReplaceMetricStreamTable(client))) {
    return;
  }

  const resetStatements = [
    "DROP VIEW IF EXISTS analytics.provider_stats",
    "DROP TABLE IF EXISTS analytics.provider_stats",
    "DROP VIEW IF EXISTS analytics.derived_resting_heart_rate",
    "DROP TABLE IF EXISTS analytics.derived_resting_heart_rate",
    "DROP VIEW IF EXISTS analytics.activity_summary",
    "DROP TABLE IF EXISTS analytics.activity_summary",
    "DROP VIEW IF EXISTS analytics.deduped_sensor",
    "DROP TABLE IF EXISTS analytics.deduped_sensor",
    "DROP TABLE IF EXISTS analytics.metric_stream_backfill_chunks",
    "DROP TABLE IF EXISTS postgres_fitness.metric_stream",
  ];

  for (const statement of resetStatements) {
    await runClickHouseMigrationStatement(client, statement);
  }

  for (const statement of buildClickHouseBootstrapStatements(postgresConnectionString).filter(
    shouldRunBeforeMetricStreamBackfill,
  )) {
    await runClickHouseMigrationStatement(client, statement);
  }

  await backfillNativeMetricStream(client, postgresConnectionString);
  await runClickHouseMigrationStatement(client, "SYSTEM REFRESH VIEW analytics.provider_stats");
  await runClickHouseMigrationStatement(client, "SYSTEM WAIT VIEW analytics.provider_stats");
  await runClickHouseMigrationStatement(client, "SYSTEM REFRESH VIEW analytics.deduped_sensor");
  await runClickHouseMigrationStatement(client, "SYSTEM WAIT VIEW analytics.deduped_sensor");
  await runClickHouseMigrationStatement(client, "SYSTEM REFRESH VIEW analytics.deduped_location");
  await runClickHouseMigrationStatement(client, "SYSTEM WAIT VIEW analytics.deduped_location");
  await runClickHouseMigrationStatement(client, "SYSTEM REFRESH VIEW analytics.activity_summary");
  await runClickHouseMigrationStatement(client, "SYSTEM WAIT VIEW analytics.activity_summary");
}

async function shouldReplaceMetricStreamTable(client: ClickHouseCommandClient): Promise<boolean> {
  if (!client.query) {
    throw new Error("ClickHouse migrations require a query-capable client");
  }
  const result = await client.query<ClickHouseDatabaseEngineRow>({
    query:
      "SELECT engine FROM system.tables WHERE database = 'postgres_fitness' AND name = 'metric_stream'",
    format: "JSONEachRow",
  });
  const rows = await result.json();
  if (!rows[0]) {
    return false;
  }
  const row = clickHouseDatabaseEngineRowSchema.parse(rows[0]);
  return row.engine !== "ReplacingMergeTree";
}

async function backfillNativeMetricStream(
  client: ClickHouseCommandClient,
  postgresConnectionString: string,
): Promise<void> {
  logger.info("[migrate] Waiting for ClickHouse postgres_fitness.metric_stream table");
  await waitForClickHouseTable(client, "postgres_fitness", "metric_stream");
  const timescaleChunks = await fetchMetricStreamBackfillChunks(postgresConnectionString);
  const backfillRanges = timescaleChunks.flatMap(splitMetricStreamBackfillChunk);
  logger.info(
    `[migrate] ClickHouse metric_stream backfill has ${backfillRanges.length} range(s) from ${timescaleChunks.length} Timescale chunk(s)`,
  );
  if (backfillRanges.length === 0) {
    return;
  }

  const postgresMetricStreamSource =
    buildPostgresMetricStreamTableFunction(postgresConnectionString);
  await client.command({
    query: `CREATE TABLE IF NOT EXISTS analytics.metric_stream_backfill_chunks (
  lower_bound DateTime64(6, 'UTC'),
  upper_bound DateTime64(6, 'UTC'),
  completed_at DateTime DEFAULT now()
)
ENGINE = MergeTree
ORDER BY (lower_bound, upper_bound)`,
  });

  const completedRanges = await fetchCompletedMetricStreamBackfillRanges(client);
  let completedRangeIndex = 0;
  let completedThrough = new Date(0);
  let skippedRanges = 0;

  for (const [rangeIndex, backfillRange] of backfillRanges.entries()) {
    while (completedRangeIndex < completedRanges.length) {
      const completedRange = completedRanges[completedRangeIndex];
      if (!completedRange || completedRange.lowerBound > backfillRange.lowerBound) {
        break;
      }
      if (completedRange.upperBound > completedThrough) {
        completedThrough = completedRange.upperBound;
      }
      completedRangeIndex += 1;
    }

    if (completedThrough >= backfillRange.upperBound) {
      skippedRanges += 1;
      if (skippedRanges % 1000 === 0) {
        const percentComplete = (((rangeIndex + 1) / backfillRanges.length) * 100).toFixed(2);
        logger.info(
          `[migrate] Skipped ${skippedRanges} completed ClickHouse metric_stream range(s); scanned ${rangeIndex + 1}/${backfillRanges.length} (${percentComplete}%)`,
        );
      }
      continue;
    }
    if (skippedRanges > 0) {
      logger.info(
        `[migrate] Skipped ${skippedRanges} completed ClickHouse metric_stream range(s); resuming at range ${rangeIndex + 1}/${backfillRanges.length}`,
      );
      skippedRanges = 0;
    }
    logger.info(
      `[migrate] Backfilling ClickHouse metric_stream range ${rangeIndex + 1}/${backfillRanges.length}: ${backfillRange.lowerBound.toISOString()} to ${backfillRange.upperBound.toISOString()}`,
    );
    await client.command({
      query: buildMetricStreamBackfillStatement(
        postgresMetricStreamSource,
        backfillRange.lowerBound,
        backfillRange.upperBound,
      ),
    });
    await client.command({
      query: `INSERT INTO analytics.metric_stream_backfill_chunks (lower_bound, upper_bound)
VALUES (${clickHouseDateTimeLiteral(backfillRange.lowerBound)}, ${clickHouseDateTimeLiteral(backfillRange.upperBound)})`,
    });
  }
  logger.info("[migrate] ClickHouse metric_stream backfill complete");
}

async function fetchCompletedMetricStreamBackfillRanges(
  client: ClickHouseCommandClient,
): Promise<CompletedMetricStreamBackfillRange[]> {
  if (!client.query) {
    throw new Error("ClickHouse metric stream backfill requires a query-capable client");
  }
  const result = await client.query<CompletedMetricStreamBackfillRangeRow>({
    query: `SELECT
  toString(lower_bound) AS lower_bound,
  toString(upper_bound) AS upper_bound
FROM analytics.metric_stream_backfill_chunks
ORDER BY lower_bound ASC, upper_bound ASC`,
    format: "JSONEachRow",
  });
  const rows = await result.json();
  return rows.map((row) => {
    const completedRange = completedMetricStreamBackfillRangeSchema.parse(row);
    return {
      lowerBound: parsePostgresTimestamp(
        completedRange.lower_bound,
        "ClickHouse metric_stream completed lower bound",
      ),
      upperBound: parsePostgresTimestamp(
        completedRange.upper_bound,
        "ClickHouse metric_stream completed upper bound",
      ),
    };
  });
}

function splitMetricStreamBackfillChunk(
  chunk: MetricStreamBackfillChunkRange,
): MetricStreamBackfillRange[] {
  const chunkStart = parsePostgresTimestamp(chunk.lower_bound, "metric_stream chunk lower bound");
  const chunkEnd = parsePostgresTimestamp(chunk.upper_bound, "metric_stream chunk upper bound");
  const ranges: MetricStreamBackfillRange[] = [];

  for (
    let rangeStart = chunkStart;
    rangeStart < chunkEnd;
    rangeStart = new Date(rangeStart.getTime() + METRIC_STREAM_BACKFILL_RANGE_MILLISECONDS)
  ) {
    const nextRangeEnd = new Date(
      Math.min(
        rangeStart.getTime() + METRIC_STREAM_BACKFILL_RANGE_MILLISECONDS,
        chunkEnd.getTime(),
      ),
    );
    ranges.push({ lowerBound: rangeStart, upperBound: nextRangeEnd });
  }

  return ranges;
}

async function fetchMetricStreamBackfillChunks(
  postgresConnectionString: string,
): Promise<MetricStreamBackfillChunkRange[]> {
  const postgresClient = new Client({ connectionString: postgresConnectionString });
  try {
    await postgresClient.connect();
    const chunksResult = await postgresClient.query<TimescaleChunkRow>(`
      SELECT
        chunk_schema,
        chunk_name
      FROM timescaledb_information.chunks
      WHERE hypertable_schema = 'fitness'
        AND hypertable_name = 'metric_stream'
      ORDER BY range_start ASC
    `);
    const chunks = chunksResult.rows.map((row) => timescaleChunkRowSchema.parse(row));
    const chunkBounds: MetricStreamBackfillChunkRange[] = [];
    for (const chunk of chunks) {
      const chunkTable = `${escapeIdentifier(chunk.chunk_schema)}.${escapeIdentifier(
        chunk.chunk_name,
      )}`;
      const chunkBoundsResult = await postgresClient.query<MetricStreamBackfillChunkRow>(`
        SELECT
          to_char(min(recorded_at) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS lower_bound,
          to_char((max(recorded_at) + interval '1 microsecond') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS upper_bound
        FROM ${chunkTable}
      `);
      const bounds = metricStreamBackfillChunkRowSchema.parse(chunkBoundsResult.rows[0]);
      if (bounds.lower_bound && bounds.upper_bound) {
        chunkBounds.push({
          lower_bound: bounds.lower_bound,
          upper_bound: bounds.upper_bound,
        });
      }
    }
    return chunkBounds;
  } finally {
    await postgresClient.end();
  }
}

function buildPostgresMetricStreamTableFunction(postgresConnectionString: string): string {
  const postgres = parsePostgresConnectionForClickHouse(postgresConnectionString);
  return `postgresql(${clickHouseStringLiteral(postgres.hostAndPort)}, ${clickHouseStringLiteral(
    postgres.database,
  )}, 'metric_stream', ${clickHouseStringLiteral(postgres.user)}, ${clickHouseStringLiteral(
    postgres.password,
  )}, 'fitness')`;
}

function parsePostgresTimestamp(value: string, label: string): Date {
  const hasTimeZone = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/.test(value);
  const normalizedValue = hasTimeZone ? value : `${value.replace(" ", "T")}Z`;
  const parsed = new Date(normalizedValue);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid ${label}: ${value}`);
  }
  return parsed;
}

function buildMetricStreamBackfillStatement(
  postgresMetricStreamSource: string,
  chunkStart: Date,
  chunkEnd: Date,
): string {
  const lowerBound = clickHouseDateTimeLiteral(chunkStart);
  const upperBound = clickHouseDateTimeLiteral(chunkEnd);
  return `INSERT INTO postgres_fitness.metric_stream (
  recorded_at,
  user_id,
  provider_id,
  external_id,
  device_id,
  source_type,
  channel,
  activity_id,
  scalar,
  point,
  id
)
SELECT
  metric_stream.recorded_at,
  metric_stream.user_id,
  metric_stream.provider_id,
  metric_stream.external_id,
  metric_stream.device_id,
  metric_stream.source_type,
  metric_stream.channel,
  metric_stream.activity_id,
  metric_stream.scalar,
  if(
    isNull(metric_stream.point),
    NULL,
    readWKBPoint(
      unhex(
        if(
          startsWith(lower(assumeNotNull(metric_stream.point)), '0101000020'),
          concat(
            substring(assumeNotNull(metric_stream.point), 1, 2),
            '01000000',
            substring(assumeNotNull(metric_stream.point), 19)
          ),
          assumeNotNull(metric_stream.point)
        )
      )
    )
  ) AS point,
  metric_stream.id
FROM ${postgresMetricStreamSource} AS metric_stream
LEFT JOIN (
  SELECT CAST(id, 'Nullable(UUID)') AS id
  FROM postgres_fitness.metric_stream
  WHERE recorded_at >= ${lowerBound}
    AND recorded_at < ${upperBound}
) AS existing_metric_stream
  ON existing_metric_stream.id = metric_stream.id
WHERE metric_stream.recorded_at >= ${lowerBound}
  AND metric_stream.recorded_at < ${upperBound}
  AND existing_metric_stream.id IS NULL`;
}

function clickHouseDateTimeLiteral(value: Date): string {
  const clickHouseTimestamp = value.toISOString().replace("T", " ").replace("Z", "");
  return `toDateTime64(${clickHouseStringLiteral(clickHouseTimestamp)}, 6, 'UTC')`;
}

async function runClickHouseMigrationStatement(
  client: ClickHouseCommandClient,
  statement: string,
): Promise<void> {
  if (statement.startsWith("CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.deduped_sensor")) {
    await waitForClickHouseTable(client, "postgres_fitness", "metric_stream");
    await waitForClickHouseTable(client, "analytics", "v_activity_members");
  }
  if (statement.startsWith("CREATE MATERIALIZED VIEW IF NOT EXISTS analytics.activity_summary")) {
    await waitForClickHouseTable(client, "analytics", "deduped_sensor");
    await waitForClickHouseTable(client, "analytics", "deduped_location");
    await waitForClickHouseTable(client, "analytics", "v_activity");
  }

  await client.command({
    query: statement,
    clickhouse_settings: {
      ...CLICKHOUSE_DEFAULT_SETTINGS,
      allow_experimental_refreshable_materialized_view: 1,
    },
  });
}
