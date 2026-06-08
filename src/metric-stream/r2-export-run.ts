import { pathToFileURL } from "node:url";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import * as Sentry from "@sentry/node";
import { Client } from "pg";
import { logger } from "../logger.ts";
import { createMetricStreamEvent } from "./events.ts";
import type {
  MetricStreamBackfillBatch,
  MetricStreamBackfillWindow,
} from "./postgres-backfill-source.ts";
import { parseMetricStreamBackfillWindow } from "./postgres-backfill-source.ts";
import { streamMetricStreamWindowViaCursor } from "./postgres-cursor-source.ts";
import { MetricStreamArchiveChunker, type MetricStreamArchiveObject } from "./r2-export.ts";

/** Streams one [start, end) window's rows as batches (cursor- or keyset-based). */
export type MetricStreamWindowReader = (
  window: MetricStreamBackfillWindow,
) => AsyncGenerator<MetricStreamBackfillBatch>;

/** The live archive uses a single-partition topic; backfill objects share it. */
const ARCHIVE_TOPIC = "metric-stream-v1";
const ARCHIVE_PARTITION = 0;
const DEFAULT_MAX_OBJECT_BYTES = 8_000_000;
const DEFAULT_CONCURRENCY = 16;

export interface MetricStreamR2ExportOptions extends MetricStreamBackfillWindow {
  streamWindow: MetricStreamWindowReader;
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

  // fitness.metric_stream is a TimescaleDB-compressed hypertable with daily
  // chunks. Step the range one UTC day at a time so each window's cursor sorts
  // exactly one chunk (chunk exclusion prunes the rest). A (date,hour) bucket
  // lives within one day, so the shared chunker's per-bucket determinism holds.
  for (const dayWindow of stepWindowsByUtcDay(options.start, options.end)) {
    for await (const batch of options.streamWindow({
      batchSize: options.batchSize,
      end: dayWindow.end,
      start: dayWindow.start,
    })) {
      for (const row of batch.rows) {
        // Backfill rows carry their Postgres id, so createMetricStreamEvent
        // keeps the existing deterministic id rather than re-deriving it.
        for (const object of chunker.push(createMetricStreamEvent(row))) {
          await enqueue(object);
        }
      }
      scanned += batch.rows.length;
      lastCursor = { id: batch.cursor.id, recordedAt: batch.cursor.recordedAt };
    }
  }
  for (const object of chunker.flush()) {
    await enqueue(object);
  }
  await drain();

  return { lastCursor, objects, scanned };
}

/**
 * Yield [start, end) split on UTC-day boundaries so each sub-window aligns with
 * the hypertable's daily chunks. Empty days are cheap (chunk exclusion returns
 * no chunks), so a wide range with sparse data costs little.
 */
export function* stepWindowsByUtcDay(
  start: Date,
  end: Date,
): Generator<{ start: Date; end: Date }> {
  let cursor = start;
  while (cursor < end) {
    const nextMidnight = new Date(
      Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth(), cursor.getUTCDate() + 1),
    );
    const windowEnd = nextMidnight < end ? nextMidnight : end;
    yield { end: windowEnd, start: cursor };
    cursor = windowEnd;
  }
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

interface R2ObjectPutter {
  putObject: (object: MetricStreamArchiveObject) => Promise<void>;
  /** Tears down the S3 client's keep-alive sockets so the one-shot exits. */
  close: () => void;
}

function createR2ObjectPutter(): R2ObjectPutter {
  const bucket = requiredEnv("METRIC_STREAM_R2_BUCKET");
  const client = new S3Client({
    credentials: {
      accessKeyId: requiredEnv("R2_ACCESS_KEY_ID"),
      secretAccessKey: requiredEnv("R2_SECRET_ACCESS_KEY"),
    },
    endpoint: requiredEnv("R2_ENDPOINT"),
    region: "auto",
  });

  return {
    putObject: async (object) => {
      await client.send(
        new PutObjectCommand({ Body: object.body, Bucket: bucket, Key: object.key }),
      );
    },
    close: () => {
      client.destroy();
    },
  };
}

export async function runMetricStreamR2ExportFromEnv(args: readonly string[]): Promise<void> {
  const options = parseMetricStreamR2ExportOptions(args);
  // Validate R2 config (and build the S3 client) before opening Postgres, so a
  // misconfiguration fails fast without leaving a connection open.
  const putter = createR2ObjectPutter();
  try {
    // A dedicated client (not a pool) holds the server-side cursor's
    // transaction open across FETCH pages.
    const client = new Client({ connectionString: requiredEnv("DATABASE_URL") });
    await client.connect();
    try {
      const result = await exportMetricStreamToR2({
        ...options,
        putObject: putter.putObject,
        streamWindow: (window) => streamMetricStreamWindowViaCursor(client, window),
      });
      logger.info(`[metric-stream-r2-export] ${JSON.stringify(result)}`);
    } finally {
      await client.end();
    }
  } finally {
    // Tear down the S3 client's keep-alive sockets so the one-shot exits
    // instead of hanging after the work is done.
    putter.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // The result is logged before the promise resolves; exit explicitly so the
  // one-shot terminates even though the pg Pool's idle sockets would otherwise
  // keep the event loop alive.
  runMetricStreamR2ExportFromEnv(process.argv.slice(2))
    .then(() => {
      process.exit(0);
    })
    .catch((error: unknown) => {
      Sentry.captureException(error);
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`[metric-stream-r2-export] ${message}`);
      process.exit(1);
    });
}
