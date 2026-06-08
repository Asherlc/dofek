import { pathToFileURL } from "node:url";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import * as Sentry from "@sentry/node";
import { createDatabaseFromEnv } from "../db/index.ts";
import { logger } from "../logger.ts";
import { createMetricStreamEvent } from "./events.ts";
import {
  type MetricStreamBackfillWindow,
  type PostgresMetricStreamBackfillDatabase,
  parseMetricStreamBackfillWindow,
  streamMetricStreamBackfillBatches,
} from "./postgres-backfill-source.ts";
import { MetricStreamArchiveChunker, type MetricStreamArchiveObject } from "./r2-export.ts";

/** The live archive uses a single-partition topic; backfill objects share it. */
const ARCHIVE_TOPIC = "metric-stream-v1";
const ARCHIVE_PARTITION = 0;
const DEFAULT_MAX_OBJECT_BYTES = 8_000_000;
const DEFAULT_CONCURRENCY = 16;

export interface MetricStreamR2ExportOptions extends MetricStreamBackfillWindow {
  db: PostgresMetricStreamBackfillDatabase;
  putObject: (object: MetricStreamArchiveObject) => Promise<void>;
  maxObjectBytes: number;
  concurrency: number;
}

export interface MetricStreamR2ExportResult {
  scanned: number;
  objects: number;
  lastCursor: { recordedAt: string; id: string } | null;
}

/**
 * Stream `fitness.metric_stream` over [start, end) straight into gzipped JSONL
 * R2 objects, byte-compatible with the live Redpanda→R2 archive. Object keys are
 * deterministic, so re-running a window overwrites the same objects rather than
 * writing duplicates — the R2 archive has no read-side dedup, so this is what
 * keeps it free of duplicate rows. Bounded memory (one open chunk) and bounded
 * PUT concurrency keep it safe to run as a one-shot container on the production
 * host.
 */
export async function exportMetricStreamToR2(
  options: MetricStreamR2ExportOptions,
): Promise<MetricStreamR2ExportResult> {
  const chunker = new MetricStreamArchiveChunker({
    topic: ARCHIVE_TOPIC,
    partition: ARCHIVE_PARTITION,
    maxObjectBytes: options.maxObjectBytes,
  });

  let scanned = 0;
  let objects = 0;
  let lastCursor: { recordedAt: string; id: string } | null = null;
  let inFlight: MetricStreamArchiveObject[] = [];

  const drain = async (): Promise<void> => {
    if (inFlight.length === 0) {
      return;
    }
    // Promise.all rejects on the first failed PUT, so a transient R2 error
    // aborts the run loudly instead of silently skipping objects.
    await Promise.all(inFlight.map((object) => options.putObject(object)));
    inFlight = [];
  };

  const enqueue = async (object: MetricStreamArchiveObject): Promise<void> => {
    inFlight.push(object);
    objects += 1;
    if (inFlight.length >= options.concurrency) {
      await drain();
    }
  };

  for await (const batch of streamMetricStreamBackfillBatches(options.db, options)) {
    for (const row of batch.rows) {
      // Backfill rows carry their Postgres id, so createMetricStreamEvent keeps
      // the existing deterministic id rather than re-deriving it.
      for (const object of chunker.push(createMetricStreamEvent(row))) {
        await enqueue(object);
      }
    }
    scanned += batch.rows.length;
    lastCursor = { id: batch.cursor.id, recordedAt: batch.cursor.recordedAt.toISOString() };
  }
  for (const object of chunker.flush()) {
    await enqueue(object);
  }
  await drain();

  return { lastCursor, objects, scanned };
}

interface MetricStreamR2ExportCliOptions extends MetricStreamBackfillWindow {
  maxObjectBytes: number;
  concurrency: number;
}

function readNumericFlag(args: readonly string[], flag: string, fallback: number): number {
  const flagIndex = args.indexOf(flag);
  if (flagIndex === -1) {
    return fallback;
  }
  const value = args[flagIndex + 1];
  if (!value || !/^[1-9]\d*$/.test(value)) {
    throw new Error(`${flag} must be a positive integer`);
  }
  return Number.parseInt(value, 10);
}

export function parseMetricStreamR2ExportOptions(
  args: readonly string[],
): MetricStreamR2ExportCliOptions {
  const maxObjectBytes = readNumericFlag(args, "--max-object-bytes", DEFAULT_MAX_OBJECT_BYTES);
  const concurrency = readNumericFlag(args, "--concurrency", DEFAULT_CONCURRENCY);

  // Strip the export-only flags before delegating the window flags so the shared
  // parser does not reject them as unknown.
  const windowArgs: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--max-object-bytes" || argument === "--concurrency") {
      index += 1;
      continue;
    }
    if (argument !== undefined) {
      windowArgs.push(argument);
    }
  }

  return { ...parseMetricStreamBackfillWindow(windowArgs), concurrency, maxObjectBytes };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

function createR2ObjectPutter(): (object: MetricStreamArchiveObject) => Promise<void> {
  const bucket = requiredEnv("METRIC_STREAM_R2_BUCKET");
  const client = new S3Client({
    credentials: {
      accessKeyId: requiredEnv("R2_ACCESS_KEY_ID"),
      secretAccessKey: requiredEnv("R2_SECRET_ACCESS_KEY"),
    },
    endpoint: requiredEnv("R2_ENDPOINT"),
    region: "auto",
  });

  return async (object) => {
    await client.send(new PutObjectCommand({ Body: object.body, Bucket: bucket, Key: object.key }));
  };
}

export async function runMetricStreamR2ExportFromEnv(args: readonly string[]): Promise<void> {
  const options = parseMetricStreamR2ExportOptions(args);
  const db = createDatabaseFromEnv();
  const putObject = createR2ObjectPutter();

  const result = await exportMetricStreamToR2({ ...options, db, putObject });
  logger.info(`[metric-stream-r2-export] ${JSON.stringify(result)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runMetricStreamR2ExportFromEnv(process.argv.slice(2)).catch((error: unknown) => {
    Sentry.captureException(error);
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[metric-stream-r2-export] ${message}`);
    process.exitCode = 1;
  });
}
