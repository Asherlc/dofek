import { Client, escapeIdentifier } from "pg";
import { z } from "zod";
import { logger } from "../../logger.ts";
import { INGEST_DATABASE, METRIC_STREAM_TABLE } from "../../metric-stream/clickhouse-table.ts";
import {
  buildClickHouseBootstrapStatements,
  type ClickHouseCommandClient,
  parsePostgresConnectionForClickHouse,
  waitForClickHouseTable,
} from "../clickhouse.ts";
import { buildActivityTrendDailyReadModelStatements } from "../clickhouse-activity-trend-read-model.ts";
import {
  buildIncrementalDedupedSensorBaseTableStatements,
  buildIncrementalDedupedSensorResetStatements,
} from "../clickhouse-deduped-sensor.ts";
import { buildActivitySummaryReadModelStatements } from "../clickhouse-metric-stream-bootstrap.ts";
import { buildPostgresFitnessActivityRawTableStatement } from "../clickhouse-raw-tables.ts";
import { buildActivityReadModelRefreshStatements } from "../clickhouse-read-models.ts";
import {
  clickHouseDateTimeLiteral,
  clickHouseStringLiteral,
  parsePostgresTimestamp,
} from "./sql.ts";
import { runClickHouseMigrationStatement } from "./statement-runner.ts";

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

interface ClickHouseDatabaseEngineRow {
  engine: string;
}

interface ClickHouseCreateTableQueryRow {
  create_table_query: string;
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

const clickHouseDatabaseEngineRowSchema = z.object({
  engine: z.string(),
});

const clickHouseCreateTableQueryRowSchema = z.object({
  create_table_query: z.string(),
});

const migrationCountRowSchema = z.object({
  migration_count: z.union([z.number(), z.string()]),
});

type MigrationCountRow = z.infer<typeof migrationCountRowSchema>;

const METRIC_STREAM_BACKFILL_RANGE_MILLISECONDS = 5 * 60 * 1_000;
const CURRENT_METRIC_STREAM_REQUIRED_COLUMNS = [
  "external_id",
  "device_id",
  "source_type",
  "activity_id",
  "point",
];

export async function migrateIncrementalDedupedSensor(
  client: ClickHouseCommandClient,
  _postgresConnectionString: string,
): Promise<void> {
  const resetStatements = [
    "DROP TABLE IF EXISTS analytics.activity_summary",
    "DROP TABLE IF EXISTS analytics.activity_trend_daily",
    "DROP TABLE IF EXISTS analytics.resting_heart_rate_sleep_window",
    ...buildIncrementalDedupedSensorResetStatements(),
    ...buildIncrementalDedupedSensorBaseTableStatements(),
  ];

  for (const statement of resetStatements) {
    await runClickHouseMigrationStatement(client, statement);
  }

  const finalStatements = [
    ...buildActivitySummaryReadModelStatements(),
    ...buildActivityTrendDailyReadModelStatements(),
  ];
  for (const statement of finalStatements) {
    await runClickHouseMigrationStatement(client, statement);
  }
}

export async function replaceNativeMetricStreamAndBackfill(
  client: ClickHouseCommandClient,
  postgresConnectionString: string,
): Promise<void> {
  const resetStatements = [
    "DROP VIEW IF EXISTS analytics.activity_summary",
    "DROP TABLE IF EXISTS analytics.activity_summary",
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

  for (const statement of buildClickHouseBootstrapStatements(postgresConnectionString)) {
    await runClickHouseMigrationStatement(client, statement);
  }

  await backfillNativeMetricStream(client, postgresConnectionString);
}

export async function repairNativeMetricStreamBackfill(
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
}

export async function rebuildMetricStreamLocationPoint(
  client: ClickHouseCommandClient,
  postgresConnectionString: string,
): Promise<void> {
  const resetStatements = [
    "DROP VIEW IF EXISTS analytics.activity_summary",
    "DROP TABLE IF EXISTS analytics.activity_summary",
    "DROP VIEW IF EXISTS analytics.deduped_location",
    "DROP TABLE IF EXISTS analytics.deduped_location",
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
    await runClickHouseMigrationStatement(client, `DROP TABLE IF EXISTS ${METRIC_STREAM_TABLE}`);
  }

  for (const statement of buildClickHouseBootstrapStatements(postgresConnectionString)) {
    await runClickHouseMigrationStatement(client, statement);
  }

  await backfillNativeMetricStream(client, postgresConnectionString);
}

export async function replaceLegacyMetricStreamIfNeeded(
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
    "DROP TABLE IF EXISTS analytics.deduped_sensor",
    "DROP TABLE IF EXISTS analytics.metric_stream_backfill_chunks",
    `DROP TABLE IF EXISTS ${METRIC_STREAM_TABLE}`,
  ];

  for (const statement of resetStatements) {
    await runClickHouseMigrationStatement(client, statement);
  }

  for (const statement of buildClickHouseBootstrapStatements(postgresConnectionString)) {
    await runClickHouseMigrationStatement(client, statement);
  }

  await backfillNativeMetricStream(client, postgresConnectionString);
}

export async function replaceActivityMirrorOrderKey(
  client: ClickHouseCommandClient,
  _postgresConnectionString: string,
): Promise<void> {
  if (!(await shouldReplaceActivityMirrorOrderKey(client))) {
    return;
  }

  const replacementTableName = "postgres_fitness.activity_order_key_next";
  const backupTableName = "postgres_fitness.activity_before_order_key_fix";
  const statements = [
    `DROP TABLE IF EXISTS ${replacementTableName}`,
    buildPostgresFitnessActivityRawTableStatement({
      tableName: replacementTableName,
      ifNotExists: false,
    }),
    `INSERT INTO ${replacementTableName} SELECT * FROM postgres_fitness.activity`,
    `DROP TABLE IF EXISTS ${backupTableName}`,
    `RENAME TABLE postgres_fitness.activity TO ${backupTableName}, ${replacementTableName} TO postgres_fitness.activity`,
    `INSERT INTO postgres_fitness.activity SELECT * FROM ${backupTableName}`,
    `DROP TABLE IF EXISTS ${backupTableName}`,
  ];

  for (const statement of statements) {
    await runClickHouseMigrationStatement(client, statement);
  }
}

async function metricStreamMirrorHasColumns(
  client: ClickHouseCommandClient,
  columns: string[],
): Promise<boolean> {
  if (!client.query) {
    throw new Error("ClickHouse migrations require a query-capable client");
  }
  const columnNames = columns.map(clickHouseStringLiteral).join(", ");
  for (const database of [INGEST_DATABASE, "postgres_fitness"]) {
    const result = await client.query<MigrationCountRow>({
      query: `SELECT count() AS migration_count
FROM system.columns
WHERE database = '${database}'
  AND table = 'metric_stream'
  AND name IN (${columnNames})`,
      format: "JSONEachRow",
    });
    const rows = await result.json();
    const parsedRows = z.array(migrationCountRowSchema).parse(rows);
    if (Number(parsedRows[0]?.migration_count ?? 0) === columns.length) {
      return true;
    }
  }
  return false;
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

async function shouldReplaceMetricStreamTable(client: ClickHouseCommandClient): Promise<boolean> {
  if (!client.query) {
    throw new Error("ClickHouse migrations require a query-capable client");
  }
  const result = await client.query<ClickHouseDatabaseEngineRow>({
    query: `SELECT engine FROM system.tables WHERE database = '${INGEST_DATABASE}' AND name = 'metric_stream'`,
    format: "JSONEachRow",
  });
  const rows = await result.json();
  if (!rows[0]) {
    return false;
  }
  const row = clickHouseDatabaseEngineRowSchema.parse(rows[0]);
  return row.engine !== "ReplacingMergeTree";
}

async function shouldReplaceActivityMirrorOrderKey(
  client: ClickHouseCommandClient,
): Promise<boolean> {
  if (!client.query) {
    throw new Error("ClickHouse migrations require a query-capable client");
  }
  const result = await client.query<ClickHouseCreateTableQueryRow>({
    query:
      "SELECT create_table_query FROM system.tables WHERE database = 'postgres_fitness' AND name = 'activity'",
    format: "JSONEachRow",
  });
  const rows = await result.json();
  if (!rows[0]) {
    return false;
  }
  const row = clickHouseCreateTableQueryRowSchema.parse(rows[0]);
  return !/\bORDER BY\s+id\b/.test(row.create_table_query);
}

async function backfillNativeMetricStream(
  client: ClickHouseCommandClient,
  postgresConnectionString: string,
): Promise<void> {
  logger.info(`[migrate] Waiting for ClickHouse ${METRIC_STREAM_TABLE} table`);
  await waitForClickHouseTable(client, INGEST_DATABASE, "metric_stream");
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

function buildMetricStreamBackfillStatement(
  postgresMetricStreamSource: string,
  chunkStart: Date,
  chunkEnd: Date,
): string {
  const lowerBound = clickHouseDateTimeLiteral(chunkStart);
  const upperBound = clickHouseDateTimeLiteral(chunkEnd);
  return `INSERT INTO ${METRIC_STREAM_TABLE} (
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
    isNull(metric_stream.point) OR assumeNotNull(metric_stream.point) = '',
    NULL,
    (
      SELECT concat(
        '{"type":"Point","coordinates":[',
        toString(p.1), ',', toString(p.2), ']}'
      )
      FROM (
        SELECT readWKBPoint(
          unhex(
            if(
              isNull(metric_stream.point) OR assumeNotNull(metric_stream.point) = '',
              '010100000000000000000000000000000000000000',
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
        ) AS p
      )
    )
  ) AS point,
  metric_stream.id
FROM ${postgresMetricStreamSource} AS metric_stream
LEFT JOIN (
  SELECT CAST(id, 'Nullable(UUID)') AS id
  FROM ${METRIC_STREAM_TABLE}
  WHERE recorded_at >= ${lowerBound}
    AND recorded_at < ${upperBound}
) AS existing_metric_stream
  ON existing_metric_stream.id = metric_stream.id
WHERE metric_stream.recorded_at >= ${lowerBound}
  AND metric_stream.recorded_at < ${upperBound}
  AND existing_metric_stream.id IS NULL`;
}

const dedupedActivitiesAbsentSourceColumnSql = `ALTER TABLE analytics.deduped_activities
ADD COLUMN IF NOT EXISTS absent_source_external_ids Array(Map(String, String)) DEFAULT []`;

export async function addDedupedActivitiesAbsentSourceLinks(
  client: ClickHouseCommandClient,
  _postgresConnectionString: string,
): Promise<void> {
  if (!client.query) {
    throw new Error("ClickHouse migrations require a query-capable client");
  }

  const result = await client.query<{ table_count: string | number }>({
    query:
      "SELECT count() AS table_count FROM system.tables WHERE database = 'analytics' AND name = 'deduped_activities'",
    format: "JSONEachRow",
  });
  const rows = await result.json();
  if (Number(rows[0]?.table_count ?? 0) === 0) {
    throw new Error(
      "Missing analytics.deduped_activities; run serving table migrations before 0032",
    );
  }

  for (const statement of buildActivityReadModelRefreshStatements()) {
    await runClickHouseMigrationStatement(client, statement);
  }

  await client.command({ query: dedupedActivitiesAbsentSourceColumnSql });
}
