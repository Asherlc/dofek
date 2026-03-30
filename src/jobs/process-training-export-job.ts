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

// ── Zod schemas for query results ──

const metricStreamRowSchema = z.object({
  recorded_at: z.string(),
  user_id: z.string(),
  activity_id: z.string().nullable(),
  provider_id: z.string(),
  heart_rate: z.number().nullable(),
  power: z.number().nullable(),
  cadence: z.number().nullable(),
  speed: z.number().nullable(),
  lat: z.number().nullable(),
  lng: z.number().nullable(),
  altitude: z.number().nullable(),
  temperature: z.number().nullable(),
  grade: z.number().nullable(),
  vertical_speed: z.number().nullable(),
  spo2: z.number().nullable(),
  respiratory_rate: z.number().nullable(),
  gps_accuracy: z.number().nullable(),
  accumulated_power: z.number().nullable(),
  stress: z.number().nullable(),
  left_right_balance: z.number().nullable(),
  vertical_oscillation: z.number().nullable(),
  stance_time: z.number().nullable(),
  stance_time_percent: z.number().nullable(),
  step_length: z.number().nullable(),
  vertical_ratio: z.number().nullable(),
  stance_time_balance: z.number().nullable(),
  ground_contact_time: z.number().nullable(),
  stride_length: z.number().nullable(),
  form_power: z.number().nullable(),
  leg_spring_stiff: z.number().nullable(),
  air_power: z.number().nullable(),
  left_torque_effectiveness: z.number().nullable(),
  right_torque_effectiveness: z.number().nullable(),
  left_pedal_smoothness: z.number().nullable(),
  right_pedal_smoothness: z.number().nullable(),
  combined_pedal_smoothness: z.number().nullable(),
  blood_glucose: z.number().nullable(),
  audio_exposure: z.number().nullable(),
  skin_temperature: z.number().nullable(),
  electrodermal_activity: z.number().nullable(),
  source_name: z.string().nullable(),
  activity_type: z.string().nullable(),
});

const imuRowSchema = z.object({
  recorded_at: z.string(),
  user_id: z.string(),
  device_id: z.string(),
  device_type: z.string(),
  provider_id: z.string(),
  x: z.number(),
  y: z.number(),
  z: z.number(),
  gyroscope_x: z.number().nullable(),
  gyroscope_y: z.number().nullable(),
  gyroscope_z: z.number().nullable(),
});

const countRowSchema = z.object({ count: z.string() });

export type MetricStreamRow = z.infer<typeof metricStreamRowSchema>;
export type ImuRow = z.infer<typeof imuRowSchema>;

// ── CSV helpers ──

export function metricStreamCsvHeader(): string {
  return [
    "recorded_at",
    "user_id",
    "activity_id",
    "provider_id",
    "activity_type",
    "heart_rate",
    "power",
    "cadence",
    "speed",
    "lat",
    "lng",
    "altitude",
    "temperature",
    "grade",
    "vertical_speed",
    "spo2",
    "respiratory_rate",
    "gps_accuracy",
    "accumulated_power",
    "stress",
    "left_right_balance",
    "vertical_oscillation",
    "stance_time",
    "stance_time_percent",
    "step_length",
    "vertical_ratio",
    "stance_time_balance",
    "ground_contact_time",
    "stride_length",
    "form_power",
    "leg_spring_stiff",
    "air_power",
    "left_torque_effectiveness",
    "right_torque_effectiveness",
    "left_pedal_smoothness",
    "right_pedal_smoothness",
    "combined_pedal_smoothness",
    "blood_glucose",
    "audio_exposure",
    "skin_temperature",
    "electrodermal_activity",
    "source_name",
  ].join(",");
}

export function metricStreamRowToCsv(row: MetricStreamRow): string {
  return [
    row.recorded_at,
    row.user_id,
    row.activity_id ?? "",
    row.provider_id,
    row.activity_type ?? "",
    row.heart_rate ?? "",
    row.power ?? "",
    row.cadence ?? "",
    row.speed ?? "",
    row.lat ?? "",
    row.lng ?? "",
    row.altitude ?? "",
    row.temperature ?? "",
    row.grade ?? "",
    row.vertical_speed ?? "",
    row.spo2 ?? "",
    row.respiratory_rate ?? "",
    row.gps_accuracy ?? "",
    row.accumulated_power ?? "",
    row.stress ?? "",
    row.left_right_balance ?? "",
    row.vertical_oscillation ?? "",
    row.stance_time ?? "",
    row.stance_time_percent ?? "",
    row.step_length ?? "",
    row.vertical_ratio ?? "",
    row.stance_time_balance ?? "",
    row.ground_contact_time ?? "",
    row.stride_length ?? "",
    row.form_power ?? "",
    row.leg_spring_stiff ?? "",
    row.air_power ?? "",
    row.left_torque_effectiveness ?? "",
    row.right_torque_effectiveness ?? "",
    row.left_pedal_smoothness ?? "",
    row.right_pedal_smoothness ?? "",
    row.combined_pedal_smoothness ?? "",
    row.blood_glucose ?? "",
    row.audio_exposure ?? "",
    row.skin_temperature ?? "",
    row.electrodermal_activity ?? "",
    row.source_name ?? "",
  ].join(",");
}

export function imuCsvHeader(): string {
  return [
    "recorded_at",
    "user_id",
    "device_id",
    "device_type",
    "provider_id",
    "x",
    "y",
    "z",
    "gyroscope_x",
    "gyroscope_y",
    "gyroscope_z",
  ].join(",");
}

export function imuRowToCsv(row: ImuRow): string {
  return [
    row.recorded_at,
    row.user_id,
    row.device_id,
    row.device_type,
    row.provider_id,
    row.x,
    row.y,
    row.z,
    row.gyroscope_x ?? "",
    row.gyroscope_y ?? "",
    row.gyroscope_z ?? "",
  ].join(",");
}

// ── Time filter builder ──

export function buildTimeFilter(
  since?: string,
  until?: string,
): {
  metricStreamFilter: ReturnType<typeof sql>;
  imuFilter: ReturnType<typeof sql>;
} {
  if (since && until) {
    return {
      metricStreamFilter: sql`WHERE ms.recorded_at >= ${since}::timestamptz AND ms.recorded_at < ${until}::timestamptz`,
      imuFilter: sql`WHERE recorded_at >= ${since}::timestamptz AND recorded_at < ${until}::timestamptz`,
    };
  }
  if (since) {
    return {
      metricStreamFilter: sql`WHERE ms.recorded_at >= ${since}::timestamptz`,
      imuFilter: sql`WHERE recorded_at >= ${since}::timestamptz`,
    };
  }
  if (until) {
    return {
      metricStreamFilter: sql`WHERE ms.recorded_at < ${until}::timestamptz`,
      imuFilter: sql`WHERE recorded_at < ${until}::timestamptz`,
    };
  }
  return {
    metricStreamFilter: sql``,
    imuFilter: sql``,
  };
}

// ── Core export logic ──

async function exportMetricStream(
  db: SyncDatabase,
  outputDir: string,
  timestamp: string,
  since?: string,
  until?: string,
  onProgress?: (info: { percentage: number; message: string }) => void,
): Promise<number> {
  const { metricStreamFilter } = buildTimeFilter(since, until);

  // Count total rows for progress reporting
  const countResult = await executeWithSchema(
    db,
    countRowSchema,
    sql`SELECT COUNT(*)::text AS count FROM fitness.metric_stream ms ${metricStreamFilter}`,
  );
  const totalRows = parseInt(countResult[0]?.count ?? "0", 10);

  if (totalRows === 0) {
    logger.info("[training-export] No metric_stream rows to export");
    return 0;
  }

  logger.info(`[training-export] Exporting ${totalRows} metric_stream rows in batches`);

  const csvDir = join(outputDir, "metric_stream");
  mkdirSync(csvDir, { recursive: true });

  const csvPath = join(csvDir, `${timestamp}.csv`);
  const lines: string[] = [metricStreamCsvHeader()];
  let offset = 0;
  let exported = 0;

  while (offset < totalRows) {
    const rows = await executeWithSchema(
      db,
      metricStreamRowSchema,
      sql`SELECT
            ms.recorded_at::text AS recorded_at,
            ms.user_id::text AS user_id,
            ms.activity_id::text AS activity_id,
            ms.provider_id,
            a.activity_type,
            ms.heart_rate,
            ms.power,
            ms.cadence,
            ms.speed,
            ms.lat,
            ms.lng,
            ms.altitude,
            ms.temperature,
            ms.grade,
            ms.vertical_speed,
            ms.spo2,
            ms.respiratory_rate,
            ms.gps_accuracy,
            ms.accumulated_power,
            ms.stress,
            ms.left_right_balance,
            ms.vertical_oscillation,
            ms.stance_time,
            ms.stance_time_percent,
            ms.step_length,
            ms.vertical_ratio,
            ms.stance_time_balance,
            ms.ground_contact_time,
            ms.stride_length,
            ms.form_power,
            ms.leg_spring_stiff,
            ms.air_power,
            ms.left_torque_effectiveness,
            ms.right_torque_effectiveness,
            ms.left_pedal_smoothness,
            ms.right_pedal_smoothness,
            ms.combined_pedal_smoothness,
            ms.blood_glucose,
            ms.audio_exposure,
            ms.skin_temperature,
            ms.electrodermal_activity,
            ms.source_name
          FROM fitness.metric_stream ms
          LEFT JOIN fitness.activity a ON a.id = ms.activity_id
          ${metricStreamFilter}
          ORDER BY ms.recorded_at
          LIMIT ${BATCH_SIZE} OFFSET ${offset}`,
    );

    for (const row of rows) {
      lines.push(metricStreamRowToCsv(row));
    }

    exported += rows.length;
    offset += rows.length;

    const percentage = Math.round((exported / totalRows) * 40); // metric_stream is 0-40% of total
    onProgress?.({ percentage, message: `Exporting metric_stream: ${exported}/${totalRows} rows` });

    if (rows.length < BATCH_SIZE) break;
  }

  writeFileSync(csvPath, lines.join("\n"), "utf-8");
  logger.info(`[training-export] Wrote ${exported} metric_stream rows to ${csvPath}`);

  return exported;
}

async function exportImuData(
  db: SyncDatabase,
  outputDir: string,
  timestamp: string,
  since?: string,
  until?: string,
  onProgress?: (info: { percentage: number; message: string }) => void,
): Promise<number> {
  const { imuFilter } = buildTimeFilter(since, until);

  const countResult = await executeWithSchema(
    db,
    countRowSchema,
    sql`SELECT COUNT(*)::text AS count FROM fitness.inertial_measurement_unit_sample ${imuFilter}`,
  );
  const totalRows = parseInt(countResult[0]?.count ?? "0", 10);

  if (totalRows === 0) {
    logger.info("[training-export] No IMU rows to export");
    return 0;
  }

  logger.info(`[training-export] Exporting ${totalRows} IMU rows in batches`);

  const csvDir = join(outputDir, "device_stream");
  mkdirSync(csvDir, { recursive: true });

  const csvPath = join(csvDir, `${timestamp}.csv`);
  const lines: string[] = [imuCsvHeader()];
  let offset = 0;
  let exported = 0;

  while (offset < totalRows) {
    const rows = await executeWithSchema(
      db,
      imuRowSchema,
      sql`SELECT
            recorded_at::text AS recorded_at,
            user_id::text AS user_id,
            device_id,
            device_type,
            provider_id,
            x,
            y,
            z,
            gyroscope_x,
            gyroscope_y,
            gyroscope_z
          FROM fitness.inertial_measurement_unit_sample
          ${imuFilter}
          ORDER BY recorded_at
          LIMIT ${BATCH_SIZE} OFFSET ${offset}`,
    );

    for (const row of rows) {
      lines.push(imuRowToCsv(row));
    }

    exported += rows.length;
    offset += rows.length;

    const percentage = 40 + Math.round((exported / totalRows) * 50); // IMU is 40-90% of total
    onProgress?.({ percentage, message: `Exporting IMU data: ${exported}/${totalRows} rows` });

    if (rows.length < BATCH_SIZE) break;
  }

  writeFileSync(csvPath, lines.join("\n"), "utf-8");
  logger.info(`[training-export] Wrote ${exported} IMU rows to ${csvPath}`);

  return exported;
}

// ── Manifest ──

interface TrainingExportManifest {
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

  // Export metric_stream (joined with activity for activity_type label)
  const metricStreamCount = await exportMetricStream(
    db,
    outputDir,
    timestamp,
    since,
    until,
    updateProgress,
  );

  // Export inertial_measurement_unit_sample
  const imuCount = await exportImuData(db, outputDir, timestamp, since, until, updateProgress);

  // Write manifest
  updateProgress({ percentage: 95, message: "Writing manifest..." });

  const manifest: TrainingExportManifest = {
    exportedAt: timestamp,
    since: since ?? null,
    until: until ?? null,
    files: [],
    totalRows: metricStreamCount + imuCount,
  };

  if (metricStreamCount > 0) {
    manifest.files.push({
      path: `metric_stream/${timestamp}.csv`,
      table: "metric_stream",
      rowCount: metricStreamCount,
    });
  }

  if (imuCount > 0) {
    manifest.files.push({
      path: `device_stream/${timestamp}.csv`,
      table: "inertial_measurement_unit_sample",
      rowCount: imuCount,
    });
  }

  const manifestPath = join(outputDir, "manifest.json");
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");

  updateProgress({ percentage: 100, message: "Training export complete" });

  logger.info(
    `[training-export] Export complete: ${manifest.totalRows} total rows, ${manifest.files.length} files`,
  );
}
