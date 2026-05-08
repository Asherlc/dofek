import { type InferInsertModel, sql } from "drizzle-orm";
import type { SyncDatabase } from "./index.ts";
import { writeLocationSamplesBatch } from "./location-sample-writer.ts";
import type { metricStream } from "./schema.ts";
import { DRIZZLE_FIELD_TO_CHANNEL } from "./sensor-channels.ts";

export type MetricStreamInsert = InferInsertModel<typeof metricStream>;
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

/**
 * Callback that receives a batch of rows to insert.
 * The default implementation uses Drizzle's `db.insert(metricStream).values(batch)`.
 * Tests can supply a lightweight mock without needing the full Drizzle type.
 */
export type BatchInsertFn = (batch: MetricStreamInsert[]) => Promise<void>;

/**
 * Create the default batch insert function using a Drizzle DB instance.
 */
export function createBatchInsert(db: Pick<SyncDatabase, "insert">): BatchInsertFn {
  return async (batch) => {
    const { metricStream: table } = await import("./schema.ts");
    await db
      .insert(table)
      .values(batch)
      .onConflictDoUpdate({
        target: [table.userId, table.providerId, table.externalId, table.channel, table.recordedAt],
        set: {
          activityId: sql`excluded.activity_id`,
          deviceId: sql`excluded.device_id`,
          sourceType: sql`excluded.source_type`,
          scalar: sql`excluded.scalar`,
          vector: sql`excluded.vector`,
        },
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

  return samples;
}

/**
 * Converts an array of source rows into per-channel metric_stream rows
 * and batch-inserts them.
 */
export async function writeMetricStreamBatch(
  db: Pick<SyncDatabase, "insert"> & Partial<Pick<SyncDatabase, "execute">>,
  metricRows: MetricStreamSourceRow[],
  sourceType: string,
  batchSize = DEFAULT_BATCH_SIZE,
): Promise<number> {
  const rows = metricRows.flatMap((row) => sourceRowToMetricStream(row, sourceType));
  let writtenRows = 0;

  if (rows.length > 0) {
    const insertBatch = createBatchInsert(db);
    writtenRows += await writeMetricStream(insertBatch, rows, batchSize);
  }

  if (db.execute) {
    writtenRows += await writeLocationSamplesBatch(
      { execute: db.execute },
      metricRows,
      sourceType,
      batchSize,
    );
  }

  return writtenRows;
}
