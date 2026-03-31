import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";
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
  vector: z.string().nullable(),
});

const countRowSchema = z.object({ count: z.string() });

export type SensorSampleRow = z.infer<typeof sensorSampleRowSchema>;

// ── Contract validation ──

/**
 * Load and compile the sensor-export JSON Schema for contract validation.
 * The schema lives in `contracts/sensor-export.schema.json` at the repo root.
 */
function loadContractValidator(): ReturnType<Ajv["compile"]> {
  const schemaPath = resolve(
    import.meta.dirname ?? __dirname,
    "../../contracts/sensor-export.schema.json",
  );
  const schemaText = readFileSync(schemaPath, "utf-8");
  const schema: unknown = JSON.parse(schemaText);

  const ajv = new Ajv({ allErrors: true });
  addFormats(ajv);
  return ajv.compile(schema);
}

export { loadContractValidator };

// ── CSV helpers ──

const CSV_COLUMNS = [
  "recorded_at",
  "user_id",
  "provider_id",
  "device_id",
  "source_type",
  "channel",
  "activity_id",
  "activity_type",
  "scalar",
  "vector",
] as const;

export function sensorSampleCsvHeader(): string {
  return CSV_COLUMNS.join(",");
}

export function sensorSampleRowToCsv(row: SensorSampleRow): string {
  return [
    row.recorded_at,
    row.user_id,
    row.provider_id,
    row.device_id ?? "",
    row.source_type,
    row.channel,
    row.activity_id ?? "",
    row.activity_type ?? "",
    row.scalar ?? "",
    row.vector ?? "",
  ].join(",");
}

export function sensorSampleRowsToCsvContent(rows: SensorSampleRow[]): string {
  const lines = [sensorSampleCsvHeader()];
  for (const row of rows) {
    lines.push(sensorSampleRowToCsv(row));
  }
  return lines.join("\n");
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
      path: `sensor_sample/${timestamp}.csv`,
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

  const csvDir = join(outputDir, "sensor_sample");
  mkdirSync(csvDir, { recursive: true });

  const csvPath = join(csvDir, `${timestamp}.csv`);
  const lines: string[] = [sensorSampleCsvHeader()];
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
            ss.vector::text AS vector
          FROM fitness.sensor_sample ss
          LEFT JOIN fitness.activity a ON a.id = ss.activity_id
          ${timeFilter}
          ORDER BY ss.recorded_at
          LIMIT ${BATCH_SIZE} OFFSET ${offset}`,
    );

    for (const row of rows) {
      lines.push(sensorSampleRowToCsv(row));
    }

    exported += rows.length;
    offset += rows.length;

    const percentage = computeProgress(exported, totalRows, 0, 90);
    onProgress?.({ percentage, message: `Exporting sensor_sample: ${exported}/${totalRows} rows` });

    if (rows.length < BATCH_SIZE) break;
  }

  // Validate a sample row against the contract schema
  if (lines.length > 1) {
    const validate = loadContractValidator();
    const headerFields = lines[0].split(",");
    const sampleValues = lines[1].split(",");
    const sampleObj: Record<string, string | number | null> = {};
    for (let i = 0; i < headerFields.length; i++) {
      const key = headerFields[i];
      const raw = sampleValues[i];
      if (key === "scalar") {
        sampleObj[key] = raw === "" ? null : Number(raw);
      } else if (
        key === "vector" ||
        key === "device_id" ||
        key === "activity_id" ||
        key === "activity_type"
      ) {
        sampleObj[key] = raw === "" ? null : raw;
      } else {
        sampleObj[key] = raw;
      }
    }
    const valid = validate(sampleObj);
    if (!valid) {
      logger.warn(
        "[training-export] Contract validation failed on sample row: %s",
        JSON.stringify(validate.errors),
      );
    }
  }

  writeFileSync(csvPath, lines.join("\n"), "utf-8");
  logger.info(`[training-export] Wrote ${exported} sensor_sample rows to ${csvPath}`);

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
