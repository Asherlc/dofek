import { z } from "zod";

export type MetricStreamArchiveObjectKey = {
  date: string;
  firstOffset: bigint;
  hour: string;
  lastOffset: bigint;
  partition: number;
  topic: string;
};

/**
 * Canonical Kafka/Connect archive object grammar (production).
 * Pulsar-native key grammar was never deployed; not retained.
 * Evidence: no production Pulsar objects; Node Pulsar archive writer removed with transport rollback.
 */
const ARCHIVE_KEY_PATTERN =
  /^metric-stream\/v1\/date=(\d{4}-\d{2}-\d{2})\/hour=(\d{2})\/([^/]+)-(\d+)-(\d+)-(\d+)\.jsonl\.gz$/;

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
