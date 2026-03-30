import type { InferInsertModel } from "drizzle-orm";
import type { SyncDatabase } from "./index.ts";
import type { metricStream, sensorSample } from "./schema.ts";
import { DRIZZLE_FIELD_TO_CHANNEL, METRIC_STREAM_COLUMN_TO_CHANNEL } from "./sensor-channels.ts";

type MetricStreamInsert = InferInsertModel<typeof metricStream>;

export type SensorSampleInsert = InferInsertModel<typeof sensorSample>;

const DEFAULT_BATCH_SIZE = 5000;

/**
 * Callback that receives a batch of rows to insert.
 * The default implementation uses Drizzle's `db.insert(sensorSample).values(batch)`.
 * Tests can supply a lightweight mock without needing the full Drizzle type.
 */
export type BatchInsertFn = (batch: SensorSampleInsert[]) => Promise<void>;

/**
 * Create the default batch insert function using a Drizzle DB instance.
 */
export function createBatchInsert(db: Pick<SyncDatabase, "insert">): BatchInsertFn {
  return async (batch) => {
    const { sensorSample: table } = await import("./schema.ts");
    await db.insert(table).values(batch);
  };
}

/**
 * Batch-insert sensor sample rows.
 */
export async function writeSensorSamples(
  insertBatch: BatchInsertFn,
  rows: SensorSampleInsert[],
  batchSize = DEFAULT_BATCH_SIZE,
): Promise<number> {
  if (rows.length === 0) return 0;

  for (let offset = 0; offset < rows.length; offset += batchSize) {
    await insertBatch(rows.slice(offset, offset + batchSize));
  }
  return rows.length;
}

/**
 * Common fields shared by every sensor_sample row in a batch.
 */
interface MetricStreamBase {
  recordedAt: Date;
  userId?: string;
  providerId: string;
  activityId?: string | null;
  sourceName?: string | null;
  sourceType: string;
}

/**
 * Convert a wide-format metric_stream record into multiple sensor_sample rows.
 *
 * For each non-null scalar column (heart_rate, power, cadence, ...),
 * produces one sensor_sample row with the matching channel name.
 *
 * Used during the dual-write transition so existing provider mapping functions
 * (fitRecordsToMetricStream, stravaStreamsToMetricStream, etc.) can continue
 * producing the old shape and have it fanned out to sensor_sample.
 */
export function metricStreamRowToSensorSamples(
  base: MetricStreamBase,
  columns: Record<string, number | null | undefined>,
): SensorSampleInsert[] {
  const rows: SensorSampleInsert[] = [];

  for (const [columnName, value] of Object.entries(columns)) {
    if (value == null) continue;
    const channel = METRIC_STREAM_COLUMN_TO_CHANNEL[columnName];
    if (!channel) continue;

    rows.push({
      recordedAt: base.recordedAt,
      userId: base.userId,
      providerId: base.providerId,
      activityId: base.activityId,
      deviceId: base.sourceName ?? null,
      sourceType: base.sourceType,
      channel,
      scalar: value,
    });
  }

  return rows;
}

/**
 * Convert a Drizzle metricStream insert object (camelCase keys) into
 * sensor_sample rows. This is the main entry point for dual-write —
 * providers pass the same row objects they already build for metricStream.
 */
export function drizzleRowToSensorSamples(
  row: MetricStreamInsert,
  sourceType: string,
): SensorSampleInsert[] {
  const samples: SensorSampleInsert[] = [];

  for (const [field, value] of Object.entries(row)) {
    if (value == null) continue;
    if (typeof value !== "number") continue;
    const channel = DRIZZLE_FIELD_TO_CHANNEL[field];
    if (!channel) continue;

    samples.push({
      recordedAt: row.recordedAt,
      userId: row.userId,
      providerId: row.providerId,
      activityId: row.activityId,
      deviceId: row.sourceName ?? null,
      sourceType,
      channel,
      scalar: value,
    });
  }

  return samples;
}

/**
 * Dual-write helper: converts an array of Drizzle metricStream insert objects
 * into sensor_sample rows and batch-inserts them. Call this alongside the
 * existing `db.insert(metricStream).values(rows)` during the migration period.
 */
export async function dualWriteToSensorSample(
  db: Pick<SyncDatabase, "insert">,
  metricRows: MetricStreamInsert[],
  sourceType: string,
  batchSize = DEFAULT_BATCH_SIZE,
): Promise<number> {
  const sensorRows = metricRows.flatMap((row) => drizzleRowToSensorSamples(row, sourceType));
  if (sensorRows.length === 0) return 0;

  const insertBatch = createBatchInsert(db);
  return writeSensorSamples(insertBatch, sensorRows, batchSize);
}
