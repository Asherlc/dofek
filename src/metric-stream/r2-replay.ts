import protobuf from "protobufjs";
import Pulsar from "pulsar-client";
import { z } from "zod";
import {
  compareMetricStreamPositions,
  metricStreamPosition,
  type PulsarMetricStreamPosition,
} from "./transport-position.ts";

/** Endpoints describe the original upload, not surviving lines after erasure. */
export type MetricStreamArchiveObjectKey =
  | {
      transport: "kafka";
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
      first: PulsarMetricStreamPosition;
      last: PulsarMetricStreamPosition;
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

// Exact MessageIdData fields from the pinned C++ client's proto2 schema:
// https://github.com/apache/pulsar-client-cpp/blob/v4.2.0/proto/PulsarApi.proto#L53-L62
const nativeMessageIdType = protobuf.Root.fromJSON({
  nested: {
    pulsar: {
      nested: {
        proto: {
          nested: {
            MessageIdData: {
              edition: "proto2",
              fields: {
                ledgerId: { type: "uint64", id: 1, rule: "required" },
                entryId: { type: "uint64", id: 2, rule: "required" },
                partition: { type: "int32", id: 3, options: { default: -1 } },
                batch_index: { type: "int32", id: 4, options: { default: -1 } },
                ack_set: { type: "int64", id: 5, rule: "repeated" },
                batch_size: { type: "int32", id: 6 },
                first_chunk_message_id: { type: "MessageIdData", id: 7 },
              },
            },
          },
        },
      },
    },
  },
}).lookupType("pulsar.proto.MessageIdData");
const deliveredCoordinateSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);
const nativeMessageIdFieldsSchema = z.object({
  ledgerId: deliveredCoordinateSchema,
  entryId: deliveredCoordinateSchema,
  partition: z.number().int().min(-1).max(2147483647).optional(),
  batch_index: z.number().int().min(-1).max(2147483647).optional(),
  batch_size: z.number().int().nonnegative().max(2147483647).optional(),
  ack_set: z
    .array(
      z
        .string()
        .regex(/^-?(0|[1-9]\d*)$/)
        .refine(
          (value) =>
            BigInt(value) >= -9223372036854775808n && BigInt(value) <= 9223372036854775807n,
        ),
    )
    .optional(),
});

function deserializeArchiveMessageId(hex: string): InstanceType<typeof Pulsar.MessageId> {
  const bytes = Buffer.from(hex, "hex");
  // The native Node binding does not catch C++ protobuf parse failures, which
  // terminate the process. Validate and canonicalize with the JS schema first:
  // https://github.com/apache/pulsar-client-node/blob/v1.18.0/src/MessageId.cc#L92-L108
  const decoded = nativeMessageIdType.decode(bytes);
  const verificationError = nativeMessageIdType.verify(decoded);
  if (verificationError) throw new Error(`Invalid native archive message ID: ${verificationError}`);
  if (Object.hasOwn(decoded, "first_chunk_message_id")) {
    throw new Error("Chunked native archive message IDs are not qualified");
  }
  const fields = nativeMessageIdFieldsSchema.parse(
    nativeMessageIdType.toObject(decoded, { longs: String }),
  );
  // Pinned MessageId::serialize emits no acknowledgement set:
  // https://github.com/apache/pulsar-client-cpp/blob/v4.2.0/lib/MessageId.cc#L55-L79
  if (fields.ack_set?.length) {
    throw new Error("Acknowledgement-set native archive message IDs are not qualified");
  }
  if (!Buffer.from(nativeMessageIdType.encode(decoded).finish()).equals(bytes)) {
    throw new Error("Native archive requires canonical protobuf message IDs");
  }
  // Deserialization creates fixed-size acknowledgement state via create(0), irrespective of
  // batch_size; it does not allocate a bitmap of the advertised batch size:
  // https://github.com/apache/pulsar-client-cpp/blob/v4.2.0/lib/MessageIdBuilder.cc#L40-L45
  const id = Pulsar.MessageId.deserialize(bytes);
  if (!id.serialize().equals(bytes)) {
    throw new Error("Native archive requires canonical serialized message IDs");
  }
  return id;
}

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
    if (Buffer.byteLength(key) > 1024) {
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
    if (!/^persistent:\/\/[^/]+\/[^/]+\/[^/]+$/.test(topic)) {
      throw new Error("Native archive requires a concrete persistent topic");
    }
    const suffix = /-partition-(0|[1-9]\d*)$/.exec(topic);
    const partition = suffix ? Number(suffix[1]) : -1;
    const position = (hex: string): PulsarMetricStreamPosition => {
      const id = deserializeArchiveMessageId(hex);
      // Message IDs carry a partition, not a topic: this checks only suffix consistency.
      return metricStreamPosition({ epoch, topic, partition }, id);
    };
    const first = position(firstHex);
    const last = position(lastHex);
    if (compareMetricStreamPositions(first, last) > 0) {
      throw new Error("Native archive endpoints are reversed");
    }
    return { transport: "pulsar", date, hour, first, last };
  }
  const match = ARCHIVE_KEY_PATTERN.exec(key);
  if (!match) {
    throw new Error(`Invalid metric-stream archive key: ${key}`);
  }

  const [date, hour, topic, partitionValue, firstOffsetValue, lastOffsetValue] =
    archiveKeyCaptureSchema.parse(match.slice(1));
  return {
    transport: "kafka",
    date,
    hour,
    topic,
    partition: Number.parseInt(partitionValue, 10),
    firstOffset: BigInt(firstOffsetValue),
    lastOffset: BigInt(lastOffsetValue),
  };
}
