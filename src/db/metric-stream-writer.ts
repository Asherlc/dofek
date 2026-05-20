import type { InferInsertModel } from "drizzle-orm";
import type { SyncDatabase } from "./index.ts";
import { DRIZZLE_FIELD_TO_CHANNEL, LOCATION } from "./sensor-channels.ts";

type MetricStreamTable = typeof import("./schema.ts").metricStream;

export type MetricStreamInsert = InferInsertModel<MetricStreamTable>;

export interface MetricStreamSourceRow {
  recordedAt: Date;
  userId?: string;
  providerId: string;
  externalId?: string | null;
  activityId?: string | null;
  sourceName?: string | null;
  [key: string]: unknown;
}

const DEFAULT_BATCH_SIZE = 1000;

function ewktPoint(longitude: number, latitude: number): string {
  return `SRID=4326;POINT(${longitude} ${latitude})`;
}

function locationMetadata(row: MetricStreamSourceRow): Record<string, unknown> | null {
  const metadata: Record<string, unknown> = {};

  if (typeof row.horizontalAccuracy === "number") {
    metadata.horizontal_accuracy_m = row.horizontalAccuracy;
  }
  if (typeof row.gpsAccuracy === "number") {
    metadata.gps_accuracy_m = row.gpsAccuracy;
  }
  if (row.raw !== undefined && row.raw !== null) {
    metadata.raw = row.raw;
  }

  return Object.keys(metadata).length > 0 ? metadata : null;
}

/**
 * Callback that receives a batch of rows to insert.
 * The default implementation uses Drizzle's `db.insert(metricStream).values(batch)`.
 * Tests can supply a lightweight mock without needing the full Drizzle type.
 */
export type BatchInsertFn = (batch: MetricStreamInsert[]) => Promise<void>;

export function metricStreamConflictTarget(table: MetricStreamTable) {
  return [table.userId, table.providerId, table.externalId, table.channel, table.recordedAt];
}

/**
 * Create the default batch insert function using a Drizzle DB instance.
 */
export function createBatchInsert(db: Pick<SyncDatabase, "insert">): BatchInsertFn {
  return async (batch) => {
    const { metricStream: table } = await import("./schema.ts");
    await db
      .insert(table)
      .values(batch)
      .onConflictDoNothing({
        target: metricStreamConflictTarget(table),
      });
  };
}

/**
 * Batch-insert metric stream rows.
 */
export async function writeMetricStream(
  insertBatch: BatchInsertFn,
  rows: MetricStreamInsert[],
  batchSize = DEFAULT_BATCH_SIZE,
): Promise<number> {
  if (rows.length === 0) return 0;

  for (let offset = 0; offset < rows.length; offset += batchSize) {
    await insertBatch(rows.slice(offset, offset + batchSize));
  }
  return rows.length;
}

/**
 * Convert a source row (camelCase keys) into per-channel metric_stream rows.
 * Providers produce wide-row objects and this helper fans them out by channel.
 */
export function sourceRowToMetricStream(
  row: MetricStreamSourceRow,
  sourceType: string,
): MetricStreamInsert[] {
  const samples: MetricStreamInsert[] = [];

  for (const [field, value] of Object.entries(row)) {
    if (value == null) continue;
    if (typeof value !== "number") continue;
    const channel = DRIZZLE_FIELD_TO_CHANNEL[field];
    if (!channel) continue;

    samples.push({
      recordedAt: row.recordedAt,
      userId: row.userId,
      providerId: row.providerId,
      externalId: row.externalId,
      activityId: row.activityId,
      deviceId: row.sourceName ?? null,
      sourceType,
      channel,
      scalar: value,
    });
  }

  if (typeof row.lat === "number" && typeof row.lng === "number") {
    samples.push({
      recordedAt: row.recordedAt,
      userId: row.userId,
      providerId: row.providerId,
      activityId: row.activityId,
      deviceId: row.sourceName ?? null,
      sourceType,
      channel: LOCATION,
      scalar: null,
      vector: null,
      point: ewktPoint(row.lng, row.lat),
      metadata: locationMetadata(row),
    });
  }

  return samples;
}

/**
 * Converts an array of source rows into per-channel metric_stream rows
 * and batch-inserts them.
 */
export async function writeMetricStreamBatch(
  db: Pick<SyncDatabase, "insert">,
  metricRows: MetricStreamSourceRow[],
  sourceType: string,
  batchSize = DEFAULT_BATCH_SIZE,
): Promise<number> {
  const rows = metricRows.flatMap((row) => sourceRowToMetricStream(row, sourceType));
  if (rows.length === 0) return 0;

  const insertBatch = createBatchInsert(db);
  return writeMetricStream(insertBatch, rows, batchSize);
}
