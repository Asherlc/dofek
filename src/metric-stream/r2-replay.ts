import { z } from "zod";

export interface MetricStreamArchiveObjectKey {
  date: string;
  firstOffset: bigint;
  hour: string;
  lastOffset: bigint;
  partition: number;
  topic: string;
}

const ARCHIVE_KEY_PATTERN =
  /^metric-stream\/v1\/date=(\d{4}-\d{2}-\d{2})\/hour=(\d{2})\/(.+)-(\d+)-(\d+)-(\d+)\.jsonl\.gz$/;
const archiveKeyCaptureSchema = z.tuple([
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
]);

export function parseMetricStreamArchiveObjectKey(key: string): MetricStreamArchiveObjectKey {
  const match = ARCHIVE_KEY_PATTERN.exec(key);
  if (!match) {
    throw new Error(`Invalid metric-stream archive key: ${key}`);
  }

  const [date, hour, topic, partitionValue, firstOffsetValue, lastOffsetValue] =
    archiveKeyCaptureSchema.parse(match.slice(1));
  return {
    date,
    hour,
    topic,
    partition: Number.parseInt(partitionValue, 10),
    firstOffset: BigInt(firstOffsetValue),
    lastOffset: BigInt(lastOffsetValue),
  };
}
