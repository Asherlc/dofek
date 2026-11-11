import { z } from "zod";

type MetricStreamArchiveObjectKey =
  | {
      date: string;
      firstOffset: bigint;
      hour: string;
      lastOffset: bigint;
      partition: number;
      topic: string;
    }
  | {
      transport: "pulsar";
      date: string;
      hour: string;
      epoch: string;
      topic: string;
      firstHex: string;
      lastHex: string;
    };

const ARCHIVE_KEY_PATTERN =
  /^metric-stream\/v1\/date=(\d{4}-\d{2}-\d{2})\/hour=(\d{2})\/([^/]+)-(\d+)-(\d+)-(\d+)\.jsonl\.gz$/;
const NATIVE_ARCHIVE_KEY_PATTERN =
  /^metric-stream\/v1\/date=(\d{4}-\d{2}-\d{2})\/hour=(\d{2})\/pulsar\/epoch=([^/]+)\/topic=([^/]+)\/first=((?:[a-f0-9]{2})+)\/last=((?:[a-f0-9]{2})+)\.jsonl\.gz$/;
const archiveKeyCaptureSchema = z.tuple([
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
]);

function decodeArchiveComponent(value: string): string {
  const decoded = decodeURIComponent(value);
  if (!decoded || encodeURIComponent(decoded) !== value) {
    throw new Error("Invalid native archive component encoding");
  }
  return decoded;
}

export function parseMetricStreamArchiveObjectKey(key: string): MetricStreamArchiveObjectKey {
  const nativeMatch = NATIVE_ARCHIVE_KEY_PATTERN.exec(key);
  if (nativeMatch) {
    if (Buffer.byteLength(key, "utf8") > 1024) {
      throw new Error("Native archive key exceeds the S3 key byte limit");
    }
    const [date, hour, encodedEpoch, encodedTopic, firstHex, lastHex] =
      archiveKeyCaptureSchema.parse(nativeMatch.slice(1));
    z.iso.date().parse(date);
    z.string()
      .regex(/^(0\d|1\d|2[0-3])$/)
      .parse(hour);
    const epoch = decodeArchiveComponent(encodedEpoch);
    const topic = decodeArchiveComponent(encodedTopic);
    if (/[\r\n\u2028\u2029]/u.test(topic) || !/^persistent:\/\/[^/]+\/[^/]+\/[^/]+$/.test(topic)) {
      throw new Error("Native archive requires a concrete persistent topic");
    }
    // Endpoints are opaque original-upload provenance, including after erasure.
    // This grammar check makes no native ID, partition or ordering assertion.
    return { transport: "pulsar", date, hour, epoch, topic, firstHex, lastHex };
  }
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
