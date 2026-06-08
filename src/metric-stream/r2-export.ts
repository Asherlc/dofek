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

function compareEvents(left: MetricStreamEventV1, right: MetricStreamEventV1): number {
  if (left.recordedAt !== right.recordedAt) {
    return left.recordedAt < right.recordedAt ? -1 : 1;
  }
  if (left.id !== right.id) {
    return left.id < right.id ? -1 : 1;
  }
  return 0;
}

interface EventBucket {
  bucket: BucketKey;
  events: MetricStreamEventV1[];
}

function groupByBucket(events: readonly MetricStreamEventV1[]): Map<string, EventBucket> {
  const groups = new Map<string, EventBucket>();
  for (const event of events) {
    const bucket = bucketOf(event);
    const bucketId = `${bucket.date}/${bucket.hour}`;
    const group = groups.get(bucketId);
    if (group) {
      group.events.push(event);
    } else {
      groups.set(bucketId, { bucket, events: [event] });
    }
  }
  return groups;
}

function lineBytes(line: string): number {
  return Buffer.byteLength(line, "utf8");
}

/**
 * Split one (date, hour) bucket's events into object-sized chunks. Boundaries
 * depend only on the bucket's own event set (sorted by recordedAt, id) and the
 * byte budget, never on offsets or surrounding windows. So as long as a bucket
 * is fully contained in one export run — guaranteed by day-aligned windows —
 * re-running produces identical keys and content, making PUTs idempotent (an
 * overwrite, never a duplicate object).
 */
function buildBucketObjects(
  events: readonly MetricStreamEventV1[],
  bucket: BucketKey,
  options: BuildMetricStreamArchiveOptions,
): MetricStreamArchiveObject[] {
  const sorted = [...events].sort(compareEvents);
  const objects: MetricStreamArchiveObject[] = [];

  let chunkLines: string[] = [];
  let chunkBytes = 0;
  let firstIndex = 0;

  const flush = (lastIndex: number): void => {
    if (chunkLines.length === 0) {
      return;
    }
    const key = `metric-stream/v1/date=${bucket.date}/hour=${bucket.hour}/${options.topic}-${options.partition}-${firstIndex}-${lastIndex}.jsonl.gz`;
    objects.push({ key, body: gzipSync(chunkLines.join("\n")) });
    chunkLines = [];
    chunkBytes = 0;
  };

  for (let index = 0; index < sorted.length; index += 1) {
    const line = JSON.stringify(sorted[index]);
    const bytes = lineBytes(line);
    // +1 per existing line for the joining newline. A single line over budget
    // can't be split (one event is atomic), so it gets its own object.
    if (chunkLines.length > 0 && chunkBytes + bytes + 1 > options.maxObjectBytes) {
      flush(index - 1);
      firstIndex = index;
    }
    chunkLines.push(line);
    chunkBytes += bytes + (chunkLines.length > 1 ? 1 : 0);
  }
  flush(sorted.length - 1);

  return objects;
}

/**
 * Convert metric-stream events into gzipped JSONL archive objects matching the
 * live Redpanda→R2 archive layout. Events are grouped by (date, hour); each
 * bucket is chunked to stay under `maxObjectBytes`. Output object order is
 * stable (sorted by date/hour then in-bucket index).
 */
export function buildMetricStreamArchiveObjects(
  events: readonly MetricStreamEventV1[],
  options: BuildMetricStreamArchiveOptions,
): MetricStreamArchiveObject[] {
  const groups = groupByBucket(events);
  const sortedBucketIds = [...groups.keys()].sort();

  const objects: MetricStreamArchiveObject[] = [];
  for (const bucketId of sortedBucketIds) {
    const group = groups.get(bucketId);
    if (!group) {
      continue;
    }
    objects.push(...buildBucketObjects(group.events, group.bucket, options));
  }
  return objects;
}
