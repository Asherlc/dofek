import { gzipSync } from "node:zlib";
import type { MetricStreamEventV1 } from "./events.ts";

/**
 * One gzipped JSONL object ready to PUT to the R2 archive. The body is
 * byte-compatible with what the Redpanda Connect `metric-stream-r2-archive`
 * pipeline writes for the live stream: newline-joined `JSON.stringify(event)`
 * lines, gzip-compressed. The key matches the same
 * `metric-stream/v1/date=…/hour=…/{topic}-{partition}-{first}-{last}.jsonl.gz`
 * layout the live path uses, so both paths land in one interchangeable bucket.
 */
export interface MetricStreamArchiveObject {
  key: string;
  body: Buffer;
}

export interface BuildMetricStreamArchiveOptions {
  topic: string;
  partition: number;
  /** Max uncompressed JSONL bytes per object, before gzip. */
  maxObjectBytes: number;
}

interface BucketKey {
  date: string;
  hour: string;
}

function bucketOf(event: MetricStreamEventV1): BucketKey {
  // recordedAt is a strict ISO-8601 UTC string (see metricStreamEventV1Schema),
  // matching the live archive's `recordedAt[0:10]` date / `[11:13]` hour slices.
  return { date: event.recordedAt.slice(0, 10), hour: event.recordedAt.slice(11, 13) };
}

function bucketIdOf(bucket: BucketKey): string {
  return `${bucket.date}/${bucket.hour}`;
}

export function compareMetricStreamEvents(
  left: MetricStreamEventV1,
  right: MetricStreamEventV1,
): number {
  if (left.recordedAt !== right.recordedAt) {
    return left.recordedAt < right.recordedAt ? -1 : 1;
  }
  if (left.id !== right.id) {
    return left.id < right.id ? -1 : 1;
  }
  return 0;
}

/**
 * Turns an ordered stream of metric-stream events into gzipped JSONL archive
 * objects without holding more than one object in memory. The chunker must be
 * fed events grouped by (date, hour) bucket and, within a bucket, in
 * (recordedAt, id) order — exactly what `ORDER BY recorded_at, id` yields, since
 * date/hour are a prefix of recordedAt. The historical backfill streams ~423M
 * rows through one node process on a memory-constrained host, so bounded memory
 * matters.
 *
 * Object boundaries depend only on a bucket's own events under the byte budget,
 * never on Kafka offsets or surrounding windows. Re-running a day-aligned window
 * therefore produces identical keys and content, so PUTs overwrite rather than
 * duplicate — the property that keeps the R2 archive free of duplicate rows.
 */
export class MetricStreamArchiveChunker {
  readonly #options: BuildMetricStreamArchiveOptions;
  #currentBucket: BucketKey | null = null;
  #currentBucketId: string | null = null;
  #chunkLines: string[] = [];
  #chunkBytes = 0;
  /** Index of the first event of the open chunk within the current bucket. */
  #firstIndexInBucket = 0;
  /** Count of events seen so far in the current bucket (= next event's index). */
  #nextIndexInBucket = 0;

  constructor(options: BuildMetricStreamArchiveOptions) {
    this.#options = options;
  }

  push(event: MetricStreamEventV1): MetricStreamArchiveObject[] {
    const bucket = bucketOf(event);
    const bucketId = bucketIdOf(bucket);
    const completed: MetricStreamArchiveObject[] = [];

    if (bucketId !== this.#currentBucketId) {
      const closing = this.#closeChunk();
      if (closing) {
        completed.push(closing);
      }
      this.#currentBucket = bucket;
      this.#currentBucketId = bucketId;
      this.#firstIndexInBucket = 0;
      this.#nextIndexInBucket = 0;
    }

    const line = JSON.stringify(event);
    const bytes = Buffer.byteLength(line, "utf8");
    // +1 per existing line for the joining newline. A single line over budget
    // can't be split (one event is atomic), so it gets its own object.
    if (
      this.#chunkLines.length > 0 &&
      this.#chunkBytes + bytes + 1 > this.#options.maxObjectBytes
    ) {
      const closing = this.#closeChunk();
      if (closing) {
        completed.push(closing);
      }
      this.#firstIndexInBucket = this.#nextIndexInBucket;
    }

    this.#chunkLines.push(line);
    this.#chunkBytes += bytes + (this.#chunkLines.length > 1 ? 1 : 0);
    this.#nextIndexInBucket += 1;

    return completed;
  }

  flush(): MetricStreamArchiveObject[] {
    const closing = this.#closeChunk();
    return closing ? [closing] : [];
  }

  #closeChunk(): MetricStreamArchiveObject | null {
    if (this.#chunkLines.length === 0 || this.#currentBucket === null) {
      return null;
    }
    const lastIndex = this.#nextIndexInBucket - 1;
    const { date, hour } = this.#currentBucket;
    const { topic, partition } = this.#options;
    const key = `metric-stream/v1/date=${date}/hour=${hour}/${topic}-${partition}-${this.#firstIndexInBucket}-${lastIndex}.jsonl.gz`;
    const body = gzipSync(this.#chunkLines.join("\n"));
    this.#chunkLines = [];
    this.#chunkBytes = 0;
    return { key, body };
  }
}

/**
 * Convenience wrapper that builds all archive objects for an in-memory event
 * array. Sorts globally by (recordedAt, id) so buckets are contiguous and
 * in-bucket order is stable, then streams through {@link MetricStreamArchiveChunker}.
 */
export function buildMetricStreamArchiveObjects(
  events: readonly MetricStreamEventV1[],
  options: BuildMetricStreamArchiveOptions,
): MetricStreamArchiveObject[] {
  const chunker = new MetricStreamArchiveChunker(options);
  const objects: MetricStreamArchiveObject[] = [];
  for (const event of [...events].sort(compareMetricStreamEvents)) {
    objects.push(...chunker.push(event));
  }
  objects.push(...chunker.flush());
  return objects;
}
