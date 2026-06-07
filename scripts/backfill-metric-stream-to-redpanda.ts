import { pathToFileURL } from "node:url";
import * as Sentry from "@sentry/node";
import { type SQLWrapper, sql } from "drizzle-orm";
import { createDatabaseFromEnv } from "../src/db/index.ts";
import {
  type MetricStreamRowInput,
  metricStreamRowInputSchema,
} from "../src/metric-stream/events.ts";
import { createKafkaMetricStreamEventPublisherFromEnv } from "../src/metric-stream/redpanda-producer.ts";
import { writeMetricStreamRows } from "../src/metric-stream/write-metric-stream.ts";

export interface PostgresMetricStreamBackfillDatabase {
  execute(query: SQLWrapper | string): Promise<unknown[]>;
}

export interface MetricStreamBackfillCursor {
  recordedAt: Date;
  id: string;
}

export interface MetricStreamBackfillOptions {
  start: Date;
  end: Date;
  batchSize: number;
}

export interface MetricStreamBackfillRunOptions extends MetricStreamBackfillOptions {
  db: PostgresMetricStreamBackfillDatabase;
  publisher: Parameters<typeof writeMetricStreamRows>[0]["publisher"];
}

export interface MetricStreamBackfillResult {
  scanned: number;
  published: number;
  batches: number;
  lastCursor: { recordedAt: string; id: string } | null;
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

const DEFAULT_BATCH_SIZE = 5000;

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

export function parseMetricStreamBackfillOptions(
  args: readonly string[],
): MetricStreamBackfillOptions {
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

export async function backfillMetricStreamToRedpanda(
  options: MetricStreamBackfillRunOptions,
): Promise<MetricStreamBackfillResult> {
  let cursor: MetricStreamBackfillCursor | null = null;
  let scanned = 0;
  let published = 0;
  let batches = 0;

  while (true) {
    const rows = await options.db.execute(
      buildMetricStreamBackfillQuery({
        batchSize: options.batchSize,
        cursor,
        end: options.end,
        start: options.start,
      }),
    );
    if (rows.length === 0) {
      break;
    }

    const parsedRows = rows.map(parseBackfillRow);
    const metricStreamRows = parsedRows.map(mapBackfillRowToMetricStreamInput);
    const result = await writeMetricStreamRows({
      publisher: options.publisher,
      rows: metricStreamRows,
    });
    const lastRow = parsedRows[parsedRows.length - 1];
    if (!lastRow) {
      throw new Error("metric_stream backfill batch unexpectedly had no rows");
    }

    cursor = {
      id: lastRow.id,
      recordedAt: new Date(normalizeRecordedAt(lastRow.recorded_at)),
    };
    scanned += parsedRows.length;
    published += result.published;
    batches += 1;
  }

  return {
    batches,
    published,
    scanned,
    lastCursor:
      cursor === null ? null : { id: cursor.id, recordedAt: cursor.recordedAt.toISOString() },
  };
}

export async function runMetricStreamBackfillFromEnv(args: readonly string[]): Promise<void> {
  const options = parseMetricStreamBackfillOptions(args);
  const db = createDatabaseFromEnv();
  const publisher = await createKafkaMetricStreamEventPublisherFromEnv();

  try {
    const result = await backfillMetricStreamToRedpanda({
      ...options,
      db,
      publisher,
    });
    console.info(JSON.stringify(result));
  } finally {
    await publisher.disconnect();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMetricStreamBackfillFromEnv(process.argv.slice(2)).catch((error: unknown) => {
    Sentry.captureException(error);
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
