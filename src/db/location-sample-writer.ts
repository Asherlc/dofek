import { sql } from "drizzle-orm";
import type { SyncDatabase } from "./index.ts";
import type { MetricStreamSourceRow } from "./metric-stream-writer.ts";

const DEFAULT_BATCH_SIZE = 1000;

export interface LocationSampleSourceRow extends MetricStreamSourceRow {
  lat?: number | null;
  lng?: number | null;
  horizontalAccuracy?: number | null;
  gpsAccuracy?: number | null;
  raw?: unknown;
}

export interface LocationSampleInsert {
  recordedAt: Date;
  userId?: string;
  providerId: string;
  activityId?: string | null;
  deviceId: string | null;
  sourceType: string;
  latitude: number;
  longitude: number;
  horizontalAccuracyM: number | null;
  gpsAccuracyM: number | null;
  raw: unknown | null;
}

export type LocationBatchInsertFn = (batch: LocationSampleInsert[]) => Promise<void>;

export function sourceRowToLocationSample(
  row: LocationSampleSourceRow,
  sourceType: string,
): LocationSampleInsert | null {
  if (typeof row.lat !== "number" || typeof row.lng !== "number") return null;

  return {
    recordedAt: row.recordedAt,
    userId: row.userId,
    providerId: row.providerId,
    activityId: row.activityId,
    deviceId: row.sourceName ?? null,
    sourceType,
    latitude: row.lat,
    longitude: row.lng,
    horizontalAccuracyM: typeof row.horizontalAccuracy === "number" ? row.horizontalAccuracy : null,
    gpsAccuracyM: typeof row.gpsAccuracy === "number" ? row.gpsAccuracy : null,
    raw: row.raw ?? null,
  };
}

export async function writeLocationSamples(
  insertBatch: LocationBatchInsertFn,
  rows: LocationSampleInsert[],
  batchSize = DEFAULT_BATCH_SIZE,
): Promise<number> {
  if (rows.length === 0) return 0;

  for (let offset = 0; offset < rows.length; offset += batchSize) {
    await insertBatch(rows.slice(offset, offset + batchSize));
  }
  return rows.length;
}

export function createLocationBatchInsert(
  db: Pick<SyncDatabase, "execute">,
): LocationBatchInsertFn {
  return async (batch) => {
    await db.execute(
      sql`INSERT INTO fitness.location_sample
            (recorded_at, user_id, provider_id, activity_id, device_id, source_type, position,
             horizontal_accuracy_m, gps_accuracy_m, raw)
          VALUES ${sql.join(
            batch.map(
              (row) => sql`(
                ${row.recordedAt}::timestamptz,
                ${row.userId},
                ${row.providerId},
                ${row.activityId ?? null}::uuid,
                ${row.deviceId},
                ${row.sourceType},
                ST_SetSRID(ST_MakePoint(${row.longitude}, ${row.latitude}), 4326),
                ${row.horizontalAccuracyM}::real,
                ${row.gpsAccuracyM}::real,
                ${row.raw == null ? null : JSON.stringify(row.raw)}::jsonb
              )`,
            ),
            sql`, `,
          )}`,
    );
  };
}

export async function writeLocationSamplesBatch(
  db: Pick<SyncDatabase, "execute">,
  metricRows: LocationSampleSourceRow[],
  sourceType: string,
  batchSize = DEFAULT_BATCH_SIZE,
): Promise<number> {
  const rows = metricRows
    .map((row) => sourceRowToLocationSample(row, sourceType))
    .filter((row): row is LocationSampleInsert => row !== null);
  if (rows.length === 0) return 0;

  return writeLocationSamples(createLocationBatchInsert(db), rows, batchSize);
}
