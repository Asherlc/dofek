import type { InferInsertModel } from "drizzle-orm";
import type { SyncDatabase } from "./index.ts";
import type { sensorSample } from "./schema.ts";
import { METRIC_STREAM_COLUMN_TO_CHANNEL } from "./sensor-channels.ts";

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
