import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import type { SyncDatabase } from "../db/index.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { logger } from "../logger.ts";
import type { TrainingExportJobData } from "./queues.ts";

/** Minimal Job interface — only the subset processTrainingExportJob actually uses. */
interface TrainingExportJob {
  data: TrainingExportJobData;
  updateProgress: (data: object) => Promise<void>;
  extendLock: (duration: number) => Promise<void>;
}

/**
 * Shared directory for job files. In production, both web and worker containers
 * mount the `job_files` volume at /app/job-files. Falls back to OS temp dir for
 * local development.
 */
const JOB_FILES_DIR = process.env.JOB_FILES_DIR || join(tmpdir(), "dofek-job-files");

const TRAINING_EXPORT_DIR = join(JOB_FILES_DIR, "training-export");

const BATCH_SIZE = 100_000;

const YIELD_INTERVAL = 10_000;

/**
 * Duration (ms) to extend the job lock by when explicitly renewing.
 * Matches the lockDuration configured on the training export worker.
 */
const LOCK_EXTENSION_MS = 600_000;

/**
 * Yield to the event loop so BullMQ can renew the job lock.
 * Called periodically during long synchronous DuckDB appender loops.
 */
const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// ── Zod schemas ──

const sensorSampleRowSchema = z.object({
  recorded_at: z.string(),
  user_id: z.string(),
  provider_id: z.string(),
  device_id: z.string().nullable(),
  source_type: z.string(),
  channel: z.string(),
  activity_id: z.string().nullable(),
  activity_type: z.string().nullable(),
  scalar: z.number().nullable(),
  vector: z.array(z.number()).nullable(),
});

const countRowSchema = z.object({ count: z.string() });

export type SensorSampleRow = z.infer<typeof sensorSampleRowSchema>;

// ── Cursor for keyset pagination ──

interface Cursor {
  recordedAt: string;
  userId: string;
  providerId: string;
  channel: string;
}

// ── SQL helpers ──

/**
 * Build an array of SQL conditions from time range and cursor parameters.
 * Used internally to construct WHERE clauses for cursor-based pagination.
 */
function buildConditions(since?: string, until?: string, cursor?: Cursor): SQL[] {
  const conditions: SQL[] = [];
  if (since) conditions.push(sql`ss.recorded_at >= ${since}::timestamptz`);
  if (until) conditions.push(sql`ss.recorded_at < ${until}::timestamptz`);
  if (cursor) {
    conditions.push(
      sql`(ss.recorded_at, ss.user_id, ss.provider_id, ss.channel) > (${cursor.recordedAt}::timestamptz, ${cursor.userId}::uuid, ${cursor.providerId}, ${cursor.channel})`,
    );
  }
  return conditions;
}

/** Join SQL conditions into a WHERE clause. Returns empty SQL if no conditions. */
function buildWhereClause(conditions: SQL[]): SQL {
  const [first, ...rest] = conditions;
  if (!first) return sql``;
  let combined = first;
  for (const condition of rest) {
    combined = sql`${combined} AND ${condition}`;
  }
  return sql`WHERE ${combined}`;
}

export function buildTimeFilter(since?: string, until?: string): ReturnType<typeof sql> {
  if (since && until) {
    return sql`WHERE ss.recorded_at >= ${since}::timestamptz AND ss.recorded_at < ${until}::timestamptz`;
  }
  if (since) {
    return sql`WHERE ss.recorded_at >= ${since}::timestamptz`;
  }
  if (until) {
    return sql`WHERE ss.recorded_at < ${until}::timestamptz`;
  }
  return sql``;
}

// ── Streaming Parquet writer ──

interface ParquetWriter {
  appendRows(rows: SensorSampleRow[]): Promise<void>;
  finalize(outputPath: string): Promise<void>;
  close(): void;
}

/**
 * Create a streaming Parquet writer backed by an in-memory DuckDB instance.
 * Rows are appended incrementally via the DuckDB appender API (no accumulation
 * in a JS array). Call `finalize()` to flush and write the Parquet file, or
 * `close()` to release resources without writing.
 */
async function createParquetWriter(): Promise<ParquetWriter> {
  const duckdb = await import("@duckdb/node-bindings");
  const database = await duckdb.open();
  const connection = await duckdb.connect(database);
  let closed = false;

  await duckdb.query(
    connection,
    `CREATE TABLE sensor_sample (
      recorded_at VARCHAR NOT NULL,
      user_id VARCHAR NOT NULL,
      provider_id VARCHAR NOT NULL,
      device_id VARCHAR,
      source_type VARCHAR NOT NULL,
      channel VARCHAR NOT NULL,
      activity_id VARCHAR,
      activity_type VARCHAR,
      scalar DOUBLE,
      vector DOUBLE[]
    )`,
  );

  const appender = duckdb.appender_create(connection, null, "sensor_sample");
  let rowIndex = 0;

  const cleanup = () => {
    if (closed) return;
    closed = true;
    duckdb.disconnect_sync(connection);
    duckdb.close_sync(database);
  };

  return {
    async appendRows(rows: SensorSampleRow[]) {
      for (const row of rows) {
        duckdb.append_varchar(appender, row.recorded_at);
        duckdb.append_varchar(appender, row.user_id);
        duckdb.append_varchar(appender, row.provider_id);
        if (row.device_id !== null) {
          duckdb.append_varchar(appender, row.device_id);
        } else {
          duckdb.append_null(appender);
        }
        duckdb.append_varchar(appender, row.source_type);
        duckdb.append_varchar(appender, row.channel);
        if (row.activity_id !== null) {
          duckdb.append_varchar(appender, row.activity_id);
        } else {
          duckdb.append_null(appender);
        }
        if (row.activity_type !== null) {
          duckdb.append_varchar(appender, row.activity_type);
        } else {
          duckdb.append_null(appender);
        }
        if (row.scalar !== null) {
          duckdb.append_double(appender, row.scalar);
        } else {
          duckdb.append_null(appender);
        }
        if (row.vector !== null) {
          const listLiteral = `[${row.vector.join(",")}]`;
          const listValue = duckdb.create_varchar(listLiteral);
          duckdb.append_value(appender, listValue);
        } else {
          duckdb.append_null(appender);
        }
        duckdb.appender_end_row(appender);

        rowIndex++;
        if (rowIndex % YIELD_INTERVAL === 0) {
          await yieldToEventLoop();
        }
      }
    },

    async finalize(outputPath: string) {
      try {
        duckdb.appender_flush_sync(appender);
        duckdb.appender_close_sync(appender);
        await duckdb.query(
          connection,
          `COPY sensor_sample TO '${outputPath.replace(/'/g, "''")}' (FORMAT PARQUET)`,
        );
      } finally {
        cleanup();
      }
    },

    close() {
      cleanup();
    },
  };
}

/**
 * Write sensor sample rows to a Parquet file using DuckDB as the writer engine.
 *
 * Creates an in-memory DuckDB instance, inserts all rows via the appender API,
 * then uses COPY ... TO to write a Parquet file. The `vector` column is stored
 * as a native DOUBLE[] (list of floats) in Parquet, not as a string.
 */
export async function writeParquet(rows: SensorSampleRow[], outputPath: string): Promise<void> {
  const writer = await createParquetWriter();
  await writer.appendRows(rows);
  await writer.finalize(outputPath);
}

// ── Manifest ──

export interface TrainingExportManifest {
  exportedAt: string;
  since: string | null;
  until: string | null;
  files: {
    path: string;
    table: string;
    rowCount: number;
  }[];
  totalRows: number;
}

export function buildManifest(
  timestamp: string,
  since: string | undefined,
  until: string | undefined,
  rowCount: number,
): TrainingExportManifest {
  const manifest: TrainingExportManifest = {
    exportedAt: timestamp,
    since: since ?? null,
    until: until ?? null,
    files: [],
    totalRows: rowCount,
  };

  if (rowCount > 0) {
    manifest.files.push({
      path: `sensor_sample/${timestamp}.parquet`,
      table: "sensor_sample",
      rowCount,
    });
  }

  return manifest;
}

export function computeProgress(
  exported: number,
  totalRows: number,
  basePercent: number,
  rangePercent: number,
): number {
  return basePercent + Math.round((exported / totalRows) * rangePercent);
}

// ── Batch fetching (cursor-based pagination) ──

/**
 * Fetch a batch of sensor samples using keyset (cursor-based) pagination.
 * Unlike OFFSET which re-scans all preceding rows, cursor pagination jumps
 * directly to the next page via the (recorded_at, user_id, provider_id, channel) tuple.
 *
 * Joins activities both by direct FK and by time overlap (LATERAL) so unlinked
 * BLE sensor data (e.g., WHOOP IMU) gets correct activity labels for ML training.
 */
async function fetchBatch(
  db: SyncDatabase,
  since: string | undefined,
  until: string | undefined,
  cursor: Cursor | undefined,
): Promise<SensorSampleRow[]> {
  const conditions = buildConditions(since, until, cursor);
  const whereClause = buildWhereClause(conditions);

  return executeWithSchema(
    db,
    sensorSampleRowSchema,
    sql`SELECT
          ss.recorded_at::text AS recorded_at,
          ss.user_id::text AS user_id,
          ss.provider_id,
          ss.device_id,
          ss.source_type,
          ss.channel,
          COALESCE(ss.activity_id, a_time.id)::text AS activity_id,
          COALESCE(a_direct.activity_type, a_time.activity_type) AS activity_type,
          ss.scalar,
          ss.vector
        FROM fitness.sensor_sample ss
        LEFT JOIN fitness.activity a_direct ON a_direct.id = ss.activity_id
        LEFT JOIN LATERAL (
          SELECT a.id, a.activity_type
          FROM fitness.activity a
          WHERE ss.activity_id IS NULL
            AND a.user_id = ss.user_id
            AND ss.recorded_at >= a.started_at
            AND ss.recorded_at <= a.ended_at
          ORDER BY a.started_at DESC
          LIMIT 1
        ) a_time ON TRUE
        ${whereClause}
        ORDER BY ss.recorded_at, ss.user_id, ss.provider_id, ss.channel
        LIMIT ${BATCH_SIZE}`,
  );
}

// ── Core export logic ──

async function exportSensorSamples(
  db: SyncDatabase,
  outputDir: string,
  timestamp: string,
  since?: string,
  until?: string,
  onProgress?: (info: { percentage: number; message: string }) => void,
  extendLock?: (duration: number) => Promise<void>,
): Promise<number> {
  const timeConditions = buildConditions(since, until);
  const timeWhere = buildWhereClause(timeConditions);

  // Count total rows for progress reporting
  const countResult = await executeWithSchema(
    db,
    countRowSchema,
    sql`SELECT COUNT(*)::text AS count FROM fitness.sensor_sample ss ${timeWhere}`,
  );
  const totalRows = parseInt(countResult[0]?.count ?? "0", 10);

  // Extend lock after the potentially slow COUNT query
  await extendLock?.(LOCK_EXTENSION_MS);

  if (totalRows === 0) {
    logger.info("[training-export] No sensor_sample rows to export");
    return 0;
  }

  logger.info(`[training-export] Exporting ${totalRows} sensor_sample rows`);

  const parquetDir = join(outputDir, "sensor_sample");
  mkdirSync(parquetDir, { recursive: true });
  const parquetPath = join(parquetDir, `${timestamp}.parquet`);

  // Open streaming Parquet writer (avoids accumulating all rows in memory)
  const writer = await createParquetWriter();

  let exported = 0;
  let cursor: Cursor | undefined;

  try {
    // Cursor-based pagination with double-buffered fetching:
    // Start the next Postgres query while appending the current batch to DuckDB.
    let currentBatch = await fetchBatch(db, since, until, undefined);

    while (currentBatch.length > 0) {
      // Update cursor from last row of current batch
      const lastRow = currentBatch[currentBatch.length - 1];
      if (!lastRow) break;
      cursor = {
        recordedAt: lastRow.recorded_at,
        userId: lastRow.user_id,
        providerId: lastRow.provider_id,
        channel: lastRow.channel,
      };

      // Start fetching next batch while we append current (double-buffer)
      const nextBatchPromise =
        currentBatch.length === BATCH_SIZE
          ? fetchBatch(db, since, until, cursor)
          : Promise.resolve([]);

      // Append to Parquet writer (streams directly to DuckDB, no JS array accumulation)
      await writer.appendRows(currentBatch);

      exported += currentBatch.length;

      // Extend lock after each batch to prevent stalling during long exports
      await extendLock?.(LOCK_EXTENSION_MS);

      const percentage = computeProgress(exported, totalRows, 0, 90);
      onProgress?.({
        percentage,
        message: `Exporting sensor_sample: ${exported}/${totalRows} rows`,
      });

      currentBatch = await nextBatchPromise;
    }

    await writer.finalize(parquetPath);
  } catch (error) {
    writer.close();
    throw error;
  }

  logger.info(`[training-export] Wrote ${exported} sensor_sample rows to ${parquetPath}`);
  return exported;
}

export async function processTrainingExportJob(
  job: TrainingExportJob,
  db: SyncDatabase,
): Promise<void> {
  const { since, until } = job.data;
  const timestamp = new Date().toISOString().replace(/\.\d+Z$/, "Z");

  logger.info(
    `[training-export] Starting training data export (since=${since ?? "all"}, until=${until ?? "now"})`,
  );

  const outputDir = TRAINING_EXPORT_DIR;
  mkdirSync(outputDir, { recursive: true });

  const updateProgress = (info: { percentage: number; message: string }) => {
    job
      .updateProgress({ percentage: info.percentage, message: info.message })
      .catch((error: unknown) => {
        logger.warn("Failed to update training export progress: %s", error);
      });
  };

  updateProgress({ percentage: 0, message: "Starting training data export..." });

  // Export sensor_sample joined with activity (direct FK + time-overlap LATERAL)
  const rowCount = await exportSensorSamples(
    db,
    outputDir,
    timestamp,
    since,
    until,
    updateProgress,
    (duration) => job.extendLock(duration),
  );

  // Write manifest
  updateProgress({ percentage: 95, message: "Writing manifest..." });

  const manifest = buildManifest(timestamp, since, until, rowCount);
  const manifestPath = join(outputDir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

  updateProgress({ percentage: 100, message: "Training export complete" });

  logger.info(
    `[training-export] Export complete: ${manifest.totalRows} total rows, ${manifest.files.length} files`,
  );
}
