import {
  createMetricStreamDeletedEvent,
  type MetricStreamDeleteScopeInput,
  type MetricStreamRowInput,
  metricStreamRowInputSchema,
} from "../metric-stream/events.ts";
import {
  getDefaultMetricStreamEventPublisher,
  type MetricStreamEventPublisher,
  type MetricStreamReplacementPublishResult,
} from "../metric-stream/redpanda-producer.ts";
import { DRIZZLE_FIELD_TO_CHANNEL, LOCATION } from "./sensor-channels.ts";
import { getTokenUserId } from "./token-user-context.ts";

export interface MetricStreamInsert {
  id?: string;
  recordedAt: Date;
  userId?: string;
  providerId: string;
  externalId?: string | null;
  deviceId?: string | null;
  sourceType: string;
  channel: string;
  activityId?: string | null;
  scalar?: number | null;
  vector?: number[] | null;
  point?: string | null;
  metadata?: unknown;
}

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

function hasExternalId(externalId: string | null | undefined): externalId is string {
  return externalId != null && externalId.trim() !== "";
}

function metricStreamExternalId(row: MetricStreamSourceRow, channel: string): string {
  if (hasExternalId(row.externalId)) return row.externalId;

  const activitySegment = row.activityId ?? "no-activity";
  const sourceSegment = row.sourceName ?? "no-source";
  return `${row.providerId}:${activitySegment}:${sourceSegment}:${channel}:${row.recordedAt.toISOString()}`;
}

function requireMetricStreamUserId(row: MetricStreamInsert): string {
  const userId = row.userId ?? getTokenUserId();
  if (!hasExternalId(userId)) {
    throw new Error("metric_stream ingestion rows require userId");
  }
  return userId;
}

function toPublishRow(row: MetricStreamInsert): MetricStreamRowInput {
  return metricStreamRowInputSchema.parse({
    ...row,
    userId: requireMetricStreamUserId(row),
  });
}

interface ReplacementCapableMetricStreamPublisher extends MetricStreamEventPublisher {
  replaceRows(
    scope: MetricStreamDeleteScopeInput,
    rows: readonly MetricStreamRowInput[],
  ): Promise<MetricStreamReplacementPublishResult>;
}

function hasReplacementPublisher(
  publisher: MetricStreamEventPublisher,
): publisher is ReplacementCapableMetricStreamPublisher {
  return typeof publisher.replaceRows === "function";
}

function requireReplacementPublisher(
  publisher: MetricStreamEventPublisher,
): ReplacementCapableMetricStreamPublisher {
  if (!hasReplacementPublisher(publisher)) {
    throw new Error("Metric stream publisher does not support scoped replacement");
  }
  return publisher;
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
      externalId: metricStreamExternalId(row, channel),
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
      externalId: metricStreamExternalId(row, LOCATION),
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
  _db: unknown,
  metricRows: MetricStreamSourceRow[],
  sourceType: string,
  batchSize = DEFAULT_BATCH_SIZE,
  publisher?: MetricStreamEventPublisher,
): Promise<number> {
  const rows = metricRows.flatMap((row) => sourceRowToMetricStream(row, sourceType));
  if (rows.length === 0) return 0;

  const rowWithoutExternalId = rows.find((row) => !hasExternalId(row.externalId));
  if (rowWithoutExternalId) {
    throw new Error("metric_stream ingestion rows require externalId for idempotency");
  }

  const resolvedPublisher = publisher ?? (await getDefaultMetricStreamEventPublisher());
  const publishRows = rows.map(toPublishRow);

  let published = 0;
  for (let offset = 0; offset < publishRows.length; offset += batchSize) {
    const events = await resolvedPublisher.publishRows(
      publishRows.slice(offset, offset + batchSize),
    );
    published += events.length;
  }
  return published;
}

export async function writeMetricStreamBatchForScope(
  _db: unknown,
  scope: MetricStreamDeleteScopeInput,
  metricRows: MetricStreamSourceRow[],
  sourceType: string,
  publisher?: MetricStreamEventPublisher,
): Promise<number> {
  const rows = metricRows.flatMap((row) => sourceRowToMetricStream(row, sourceType));
  if (rows.length === 0) return 0;

  const rowWithoutExternalId = rows.find((row) => !hasExternalId(row.externalId));
  if (rowWithoutExternalId) {
    throw new Error("metric_stream ingestion rows require externalId for idempotency");
  }

  const resolvedPublisher = publisher ?? (await getDefaultMetricStreamEventPublisher());
  const partitionKey = createMetricStreamDeletedEvent(scope).partitionKey;
  const events = await resolvedPublisher.publishRows(rows.map(toPublishRow), partitionKey);
  return events.length;
}

export async function replaceMetricStreamBatch(
  _db: unknown,
  scope: MetricStreamDeleteScopeInput,
  metricRows: MetricStreamSourceRow[],
  sourceType: string,
  publisher?: MetricStreamEventPublisher,
): Promise<number> {
  const rows = metricRows.flatMap((row) => sourceRowToMetricStream(row, sourceType));
  const rowWithoutExternalId = rows.find((row) => !hasExternalId(row.externalId));
  if (rowWithoutExternalId) {
    throw new Error("metric_stream ingestion rows require externalId for idempotency");
  }

  const resolvedPublisher = requireReplacementPublisher(
    publisher ?? (await getDefaultMetricStreamEventPublisher()),
  );
  const result = await resolvedPublisher.replaceRows(scope, rows.map(toPublishRow));
  return result.rows.length;
}
