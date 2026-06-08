import { pathToFileURL } from "node:url";
import * as Sentry from "@sentry/node";
import { createDatabaseFromEnv } from "../src/db/index.ts";
import {
  type MetricStreamBackfillWindow,
  type PostgresMetricStreamBackfillDatabase,
  parseMetricStreamBackfillWindow,
  streamMetricStreamBackfillBatches,
} from "../src/metric-stream/postgres-backfill-source.ts";
import { createKafkaMetricStreamEventPublisherFromEnv } from "../src/metric-stream/redpanda-producer.ts";
import { writeMetricStreamRows } from "../src/metric-stream/write-metric-stream.ts";

export interface MetricStreamBackfillRunOptions extends MetricStreamBackfillWindow {
  db: PostgresMetricStreamBackfillDatabase;
  publisher: Parameters<typeof writeMetricStreamRows>[0]["publisher"];
}

export interface MetricStreamBackfillResult {
  scanned: number;
  published: number;
  batches: number;
  lastCursor: { recordedAt: string; id: string } | null;
}

export async function backfillMetricStreamToRedpanda(
  options: MetricStreamBackfillRunOptions,
): Promise<MetricStreamBackfillResult> {
  let scanned = 0;
  let published = 0;
  let batches = 0;
  let lastCursor: { recordedAt: string; id: string } | null = null;

  for await (const batch of streamMetricStreamBackfillBatches(options.db, options)) {
    const result = await writeMetricStreamRows({
      publisher: options.publisher,
      rows: batch.rows,
    });
    scanned += batch.rows.length;
    published += result.published;
    batches += 1;
    lastCursor = { id: batch.cursor.id, recordedAt: batch.cursor.recordedAt.toISOString() };
  }

  return { batches, published, scanned, lastCursor };
}

export async function runMetricStreamBackfillFromEnv(args: readonly string[]): Promise<void> {
  const window = parseMetricStreamBackfillWindow(args);
  const db = createDatabaseFromEnv();
  const publisher = await createKafkaMetricStreamEventPublisherFromEnv();

  try {
    const result = await backfillMetricStreamToRedpanda({ ...window, db, publisher });
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
