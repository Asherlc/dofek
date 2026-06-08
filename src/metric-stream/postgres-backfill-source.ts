import { type SQLWrapper, sql } from "drizzle-orm";
import { type MetricStreamRowInput, metricStreamRowInputSchema } from "./events.ts";

/**
 * Minimal database surface the backfill needs: run a query, get rows back. Kept
 * narrow so unit tests can supply a stub without a real connection. Both the
 * Redpanda backfill and the direct R2 export read `fitness.metric_stream`
 * through this one source so the query and row parsing have a single home.
 */
export interface PostgresMetricStreamBackfillDatabase {
  execute(query: SQLWrapper | string): Promise<unknown[]>;
}

export interface MetricStreamBackfillCursor {
  recordedAt: Date;
  id: string;
}

export interface MetricStreamBackfillWindow {
  start: Date;
  end: Date;
  batchSize: number;
}

export interface MetricStreamBackfillBatch {
  rows: MetricStreamRowInput[];
  cursor: MetricStreamBackfillCursor;
}

interface PostgresMetricStreamBackfillRow {
  id: string;
  recorded_at: Date | string;
  user_id: string;
  provider_id: string;
  external_id: string | null;
  device_id: string | null;
  source_type: string;
  channel: string;
  activity_id: string | null;
  scalar: number | null;
  vector: number[] | null;
  point: string | null;
  metadata: unknown;
}

const DEFAULT_BATCH_SIZE = 500;

function readOptionValue(
  args: readonly string[],
  argumentIndex: number,
  optionName: string,
): string {
  const value = args[argumentIndex + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

function parseTimestampOption(value: string, optionName: string): Date {
  const parsedDate = new Date(value);
  if (Number.isNaN(parsedDate.getTime())) {
    throw new Error(`${optionName} must be a valid timestamp`);
  }
  return parsedDate;
}

function parsePositiveInteger(value: string, optionName: string): number {
  if (!/^[1-9]\d*$/.test(value)) {
    throw new Error(`${optionName} must be a positive integer`);
  }
  return Number.parseInt(value, 10);
}

export function parseMetricStreamBackfillWindow(
  args: readonly string[],
): MetricStreamBackfillWindow {
  let startValue: string | undefined;
  let endValue: string | undefined;
  let batchSize = DEFAULT_BATCH_SIZE;

  for (let argumentIndex = 0; argumentIndex < args.length; argumentIndex += 1) {
    const argument = args[argumentIndex];
    switch (argument) {
      case "--start":
        startValue = readOptionValue(args, argumentIndex, "--start");
        argumentIndex += 1;
        break;
      case "--end":
        endValue = readOptionValue(args, argumentIndex, "--end");
        argumentIndex += 1;
        break;
      case "--batch-size":
        batchSize = parsePositiveInteger(
          readOptionValue(args, argumentIndex, "--batch-size"),
          "--batch-size",
        );
        argumentIndex += 1;
        break;
      default:
        throw new Error(`Unknown option: ${argument}`);
    }
  }

  if (!startValue) {
    throw new Error("--start is required");
  }
  if (!endValue) {
    throw new Error("--end is required");
  }

  const start = parseTimestampOption(startValue, "--start");
  const end = parseTimestampOption(endValue, "--end");
  if (start.getTime() >= end.getTime()) {
    throw new Error("--start must be before --end");
  }

  return { batchSize, end, start };
}

export function buildMetricStreamBackfillQuery(options: {
  start: Date;
  end: Date;
  batchSize: number;
  cursor: MetricStreamBackfillCursor | null;
}): SQLWrapper {
  const cursorClause =
    options.cursor === null
      ? sql``
      : sql`AND (recorded_at, id) > (${options.cursor.recordedAt.toISOString()}::timestamptz, ${options.cursor.id}::uuid)`;

  return sql`SELECT
      id::text,
      recorded_at,
      user_id::text,
      provider_id,
      external_id,
      device_id,
      source_type,
      channel,
      activity_id::text,
      scalar::double precision AS scalar,
      vector::double precision[] AS vector,
      ST_AsEWKT(point) AS point,
      metadata
    FROM fitness.metric_stream
    WHERE recorded_at >= ${options.start.toISOString()}::timestamptz
      AND recorded_at < ${options.end.toISOString()}::timestamptz
      ${cursorClause}
    ORDER BY recorded_at ASC, id ASC
    LIMIT ${options.batchSize}`;
}

function normalizeRecordedAt(value: Date | string): string {
  const recordedAt = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(recordedAt.getTime())) {
    throw new Error("recorded_at must be a valid timestamp");
  }
  return recordedAt.toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function nullableString(value: unknown, label: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error(`${label} must be a string or null`);
  return value;
}

function nullableNumber(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number or null`);
  }
  return value;
}

function nullableNumberArray(value: unknown, label: string): number[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) throw new Error(`${label} must be a number array or null`);
  return value.map((item) => {
    if (typeof item !== "number" || !Number.isFinite(item)) {
      throw new Error(`${label} must contain only finite numbers`);
    }
    return item;
  });
}

function parseBackfillRow(value: unknown): PostgresMetricStreamBackfillRow {
  if (!isRecord(value)) {
    throw new Error("metric_stream backfill row must be an object");
  }
  const id = value.id;
  const recordedAt = value.recorded_at;
  const userId = value.user_id;
  const providerId = value.provider_id;
  const sourceType = value.source_type;
  const channel = value.channel;
  if (typeof id !== "string") throw new Error("metric_stream id must be a string");
  if (!(recordedAt instanceof Date) && typeof recordedAt !== "string") {
    throw new Error("metric_stream recorded_at must be a timestamp");
  }
  if (typeof userId !== "string") throw new Error("metric_stream user_id must be a string");
  if (typeof providerId !== "string") throw new Error("metric_stream provider_id must be a string");
  if (typeof sourceType !== "string") throw new Error("metric_stream source_type must be a string");
  if (typeof channel !== "string") throw new Error("metric_stream channel must be a string");

  return {
    id,
    recorded_at: recordedAt,
    user_id: userId,
    provider_id: providerId,
    external_id: nullableString(value.external_id, "metric_stream external_id"),
    device_id: nullableString(value.device_id, "metric_stream device_id"),
    source_type: sourceType,
    channel,
    activity_id: nullableString(value.activity_id, "metric_stream activity_id"),
    scalar: nullableNumber(value.scalar, "metric_stream scalar"),
    vector: nullableNumberArray(value.vector, "metric_stream vector"),
    point: nullableString(value.point, "metric_stream point"),
    metadata: value.metadata ?? null,
  };
}

function mapBackfillRowToMetricStreamInput(
  row: PostgresMetricStreamBackfillRow,
): MetricStreamRowInput {
  return metricStreamRowInputSchema.parse({
    id: row.id,
    recordedAt: normalizeRecordedAt(row.recorded_at),
    userId: row.user_id,
    providerId: row.provider_id,
    externalId: row.external_id,
    deviceId: row.device_id,
    sourceType: row.source_type,
    channel: row.channel,
    activityId: row.activity_id,
    scalar: row.scalar,
    vector: row.vector,
    point: row.point,
    metadata: row.metadata,
  });
}

/**
 * Keyset-paginate `fitness.metric_stream` over [start, end) ordered by
 * (recorded_at, id), yielding one parsed batch at a time plus the cursor to
 * resume after it. Streaming keeps memory bounded for the ~423M-row historical
 * backfill and preserves the original Postgres ids (so deterministic event ids
 * round-trip unchanged).
 */
export async function* streamMetricStreamBackfillBatches(
  db: PostgresMetricStreamBackfillDatabase,
  window: MetricStreamBackfillWindow,
): AsyncGenerator<MetricStreamBackfillBatch> {
  let cursor: MetricStreamBackfillCursor | null = null;

  while (true) {
    const rawRows = await db.execute(
      buildMetricStreamBackfillQuery({
        batchSize: window.batchSize,
        cursor,
        end: window.end,
        start: window.start,
      }),
    );
    if (rawRows.length === 0) {
      break;
    }

    const parsedRows = rawRows.map(parseBackfillRow);
    const rows = parsedRows.map(mapBackfillRowToMetricStreamInput);
    const lastRow = parsedRows[parsedRows.length - 1];
    if (!lastRow) {
      throw new Error("metric_stream backfill batch unexpectedly had no rows");
    }

    cursor = {
      id: lastRow.id,
      recordedAt: new Date(normalizeRecordedAt(lastRow.recorded_at)),
    };
    yield { rows, cursor };
  }
}
