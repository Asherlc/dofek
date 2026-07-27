import {
  createMetricStreamDeletePartitionKey,
  type MetricStreamDeleteScopeInput,
  type MetricStreamProcessingContext,
  type MetricStreamRowInput,
  metricStreamRowInputSchema,
} from "../metric-stream/events.ts";
import {
  getDefaultMetricStreamEventPublisher,
  type MetricStreamEventPublisher,
  type MetricStreamReplacementPublishResult,
} from "../metric-stream/redpanda-producer.ts";
import {
  prepareMetricStreamRows,
  withAccountErasureMetricStreamWriteFence,
} from "../metric-stream/write-metric-stream.ts";
import { DRIZZLE_FIELD_TO_CHANNEL, LOCATION } from "./sensor-channels.ts";
import { getTokenUserId } from "./token-user-context.ts";
import type { Database } from "./typed-sql.ts";

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
    operationRevision: string,
    processing?: MetricStreamProcessingContext,
  ): Promise<MetricStreamReplacementPublishResult>;
}

export interface MetricStreamReplacementReceipt {
  deletedEventId: string;
  rowCount: number;
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

function scopeWithUserId(
  scope: MetricStreamDeleteScopeInput,
  rows: readonly MetricStreamRowInput[],
): MetricStreamDeleteScopeInput & { userId: string } {
  if (scope.userId) return { ...scope, userId: scope.userId };
  const userIds = [...new Set(rows.map((row) => row.userId))];
  if (userIds.length !== 1 || !userIds[0]) {
    throw new Error(
      "Metric stream replacement scope requires userId when rows do not identify exactly one user",
    );
  }
  return { ...scope, userId: userIds[0] };
}

/**
 * Convert a source row (camelCase keys) into per-channel metric stream events.
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
 * Converts an array of source rows into per-channel metric stream events
 * and batch-inserts them.
 */
export async function writeMetricStreamBatch(
  db: Database,
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
  return withAccountErasureMetricStreamWriteFence(
    db,
    publishRows.map((row) => row.userId),
    async (transaction) => {
      const prepared = await prepareMetricStreamRows(transaction, publishRows);
      let published = 0;
      for (let offset = 0; offset < prepared.rows.length; offset += batchSize) {
        const events = await resolvedPublisher.publishRows(
          prepared.rows.slice(offset, offset + batchSize),
          { operationRevision: prepared.operationRevision },
        );
        published += events.length;
      }
      return published;
    },
  );
}

export async function writeMetricStreamBatchForScope(
  db: Database,
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
  const publishRows = rows.map(toPublishRow);
  const attributedScope = scopeWithUserId(scope, publishRows);
  const partitionKey = createMetricStreamDeletePartitionKey(attributedScope);
  return withAccountErasureMetricStreamWriteFence(
    db,
    [attributedScope.userId, ...publishRows.map((row) => row.userId)],
    async (transaction) => {
      const prepared = await prepareMetricStreamRows(transaction, publishRows);
      const events = await resolvedPublisher.publishRows(prepared.rows, {
        operationRevision: prepared.operationRevision,
        partitionKey,
      });
      return events.length;
    },
  );
}

export async function replaceMetricStreamBatch(
  db: Database,
  scope: MetricStreamDeleteScopeInput,
  metricRows: MetricStreamSourceRow[],
  sourceType: string,
  publisher?: MetricStreamEventPublisher,
): Promise<MetricStreamReplacementReceipt> {
  const rows = metricRows.flatMap((row) => sourceRowToMetricStream(row, sourceType));
  const rowWithoutExternalId = rows.find((row) => !hasExternalId(row.externalId));
  if (rowWithoutExternalId) {
    throw new Error("metric_stream ingestion rows require externalId for idempotency");
  }

  const resolvedPublisher = requireReplacementPublisher(
    publisher ?? (await getDefaultMetricStreamEventPublisher()),
  );
  const publishRows = rows.map(toPublishRow);
  const attributedScope = scopeWithUserId(scope, publishRows);
  return withAccountErasureMetricStreamWriteFence(
    db,
    [attributedScope.userId, ...publishRows.map((row) => row.userId)],
    async (transaction) => {
      const prepared = await prepareMetricStreamRows(transaction, publishRows);
      const result = await resolvedPublisher.replaceRows(
        attributedScope,
        prepared.rows,
        prepared.operationRevision,
      );
      return {
        deletedEventId: result.deleted.eventId,
        rowCount: result.rows.length,
      };
    },
  );
}
