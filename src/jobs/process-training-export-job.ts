import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { SyncDatabase } from "../db/index.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { logger } from "../logger.ts";
import type { TrainingExportJobData } from "./queues.ts";

/** Minimal Job interface — only the subset processTrainingExportJob actually uses. */
interface TrainingExportJob {
  data: TrainingExportJobData;
  updateProgress: (data: object) => Promise<void>;
}

/**
 * Shared directory for job files. In production, both web and worker containers
 * mount the `job_files` volume at /app/job-files. Falls back to OS temp dir for
 * local development.
 */
const JOB_FILES_DIR = process.env.JOB_FILES_DIR || join(tmpdir(), "dofek-job-files");

const TRAINING_EXPORT_DIR = join(JOB_FILES_DIR, "training-export");

const BATCH_SIZE = 100_000;

// ── Zod schema for sensor_sample query results ──

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

// ── Parquet writer ──

/**
 * Write sensor sample rows to a Parquet file using DuckDB as the writer engine.
 *
 * Creates an in-memory DuckDB instance, inserts all rows via the appender API,
 * then uses COPY ... TO to write a Parquet file. The `vector` column is stored
 * as a native DOUBLE[] (list of floats) in Parquet, not as a string.
 */
export async function writeParquet(rows: SensorSampleRow[], outputPath: string): Promise<void> {
  // DuckDB native bindings can crash on some host/arch combinations if imported at module load time.
  // Load lazily so worker startup does not depend on this optional export path.
  const duckdb = await import("@duckdb/node-bindings");
  const db = await duckdb.open();
  const conn = await duckdb.connect(db);

  try {
    await duckdb.query(
      conn,
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

    const appender = duckdb.appender_create(conn, null, "sensor_sample");

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
        // Encode the float array as a DuckDB list literal string via a Value
        const listLiteral = `[${row.vector.join(",")}]`;
        const listValue = duckdb.create_varchar(listLiteral);
        duckdb.append_value(appender, listValue);
      } else {
        duckdb.append_null(appender);
      }
      duckdb.appender_end_row(appender);
    }

    duckdb.appender_flush_sync(appender);
    duckdb.appender_close_sync(appender);

    await duckdb.query(
      conn,
      `COPY sensor_sample TO '${outputPath.replace(/'/g, "''")}' (FORMAT PARQUET)`,
    );
  } finally {
    duckdb.disconnect_sync(conn);
    duckdb.close_sync(db);
  }
}

// ── Time filter builder ──

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

// ── Core export logic ──

async function exportSensorSamples(
  db: SyncDatabase,
  outputDir: string,
  timestamp: string,
  since?: string,
  until?: string,
  onProgress?: (info: { percentage: number; message: string }) => void,
): Promise<number> {
  const timeFilter = buildTimeFilter(since, until);

  // Count total rows for progress reporting
  const countResult = await executeWithSchema(
    db,
    countRowSchema,
    sql`SELECT COUNT(*)::text AS count FROM fitness.sensor_sample ss ${timeFilter}`,
  );
  const totalRows = parseInt(countResult[0]?.count ?? "0", 10);

  if (totalRows === 0) {
    logger.info("[training-export] No sensor_sample rows to export");
    return 0;
  }

  logger.info(`[training-export] Exporting ${totalRows} sensor_sample rows in batches`);

  const parquetDir = join(outputDir, "sensor_sample");
  mkdirSync(parquetDir, { recursive: true });

  const parquetPath = join(parquetDir, `${timestamp}.parquet`);
  const allRows: SensorSampleRow[] = [];
  let offset = 0;
  let exported = 0;

  while (offset < totalRows) {
    const rows = await executeWithSchema(
      db,
      sensorSampleRowSchema,
      sql`SELECT
            ss.recorded_at::text AS recorded_at,
            ss.user_id::text AS user_id,
            ss.provider_id,
            ss.device_id,
            ss.source_type,
            ss.channel,
            ss.activity_id::text AS activity_id,
            a.activity_type,
            ss.scalar,
            ss.vector
          FROM fitness.sensor_sample ss
          LEFT JOIN fitness.activity a ON a.id = ss.activity_id
          ${timeFilter}
          ORDER BY ss.recorded_at
          LIMIT ${BATCH_SIZE} OFFSET ${offset}`,
    );

    for (const row of rows) {
      allRows.push(row);
    }

    exported += rows.length;
    offset += rows.length;

    const percentage = computeProgress(exported, totalRows, 0, 90);
    onProgress?.({ percentage, message: `Exporting sensor_sample: ${exported}/${totalRows} rows` });

    if (rows.length < BATCH_SIZE) break;
  }

  await writeParquet(allRows, parquetPath);
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

  // Export sensor_sample (joined with activity for activity_type label)
  const rowCount = await exportSensorSamples(
    db,
    outputDir,
    timestamp,
    since,
    until,
    updateProgress,
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
