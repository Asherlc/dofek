export interface MetricStreamArchiveObjectKey {
  date: string;
  firstOffset: number;
  hour: string;
  lastOffset: number;
  partition: number;
  topic: string;
}

const ARCHIVE_KEY_PATTERN =
  /^metric-stream\/v1\/date=(\d{4}-\d{2}-\d{2})\/hour=(\d{2})\/(.+)-(\d+)-(\d+)-(\d+)\.jsonl\.gz$/;

export function parseMetricStreamArchiveObjectKey(key: string): MetricStreamArchiveObjectKey {
  const match = ARCHIVE_KEY_PATTERN.exec(key);
  if (!match) {
    throw new Error(`Invalid metric-stream archive key: ${key}`);
  }

  const [, date, hour, topic, partitionValue, firstOffsetValue, lastOffsetValue] = match;
  if (!date || !hour || !topic || !partitionValue || !firstOffsetValue || !lastOffsetValue) {
    throw new Error(`Invalid metric-stream archive key: ${key}`);
  }

  return {
    date,
    hour,
    topic,
    partition: Number.parseInt(partitionValue, 10),
    firstOffset: Number.parseInt(firstOffsetValue, 10),
    lastOffset: Number.parseInt(lastOffsetValue, 10),
  };
}
