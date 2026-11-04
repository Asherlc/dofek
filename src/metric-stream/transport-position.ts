import type { MessageId } from "pulsar-client";
import { z } from "zod";

const nativeCoordinateSchema = z
  .string()
  .regex(/^(0|[1-9]\d*)$/)
  .refine((value) => BigInt(value) <= 9223372036854775807n);
export const metricStreamPositionSchema = z.object({
  epoch: z.string().min(1),
  topic: z.string().min(1),
  partition: z.number().int().min(-1).max(2147483647),
  serializedMessageId: z
    .string()
    .min(1)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  delivery: z
    .object({
      major: nativeCoordinateSchema,
      minor: nativeCoordinateSchema,
      batch: z.number().int().min(-1).max(2147483647),
    })
    .refine(
      (delivery) =>
        !(
          delivery.major === "9223372036854775807" &&
          delivery.minor === "9223372036854775807" &&
          delivery.batch === -1
        ),
      "Native latest sentinel is not a delivered message position",
    ),
});

export interface MetricStreamPosition {
  epoch: string;
  topic: string;
  partition: number;
  serializedMessageId: string;
  delivery: { major: string; minor: string; batch: number };
}

export function metricStreamPosition(
  stream: Pick<MetricStreamPosition, "epoch" | "topic" | "partition">,
  messageId: MessageId,
): MetricStreamPosition {
  // pulsar-client 1.18.0 pins C++ 4.2.0. Its MessageId stream operator emits
  // (ledgerId,entryId,partition,batchIndex) using int64/int32 without JS numbers:
  // https://github.com/apache/pulsar-client-cpp/blob/v4.2.0/lib/MessageId.cc
  // Chunked and unknown native representations require separate qualification.
  const match = /^\((0|[1-9]\d*),(0|[1-9]\d*),(-1|0|[1-9]\d*),(-1|0|[1-9]\d*)\)$/.exec(
    messageId.toString(),
  );
  if (!match) throw new Error("Unsupported native Pulsar message ID representation");
  const [, major = "", minor = "", partition = "", batch = ""] = match;
  if (BigInt(major) > 9223372036854775807n || BigInt(minor) > 9223372036854775807n) {
    throw new Error(
      "Unsupported native Pulsar message ID representation: coordinates exceed int64",
    );
  }
  if (
    !stream.epoch ||
    !stream.topic ||
    !Number.isInteger(stream.partition) ||
    Number(partition) !== stream.partition
  ) {
    throw new Error("Pulsar message partition must match a nonempty stream epoch and topic");
  }
  if (Number(partition) > 2147483647 || Number(batch) > 2147483647) {
    throw new Error(
      "Unsupported native Pulsar message ID representation: coordinates exceed int32",
    );
  }
  return metricStreamPositionSchema.parse({
    ...stream,
    serializedMessageId: messageId.serialize().toString("base64"),
    delivery: { major, minor, batch: Number(batch) },
  });
}

export function compareMetricStreamPositions(
  left: MetricStreamPosition,
  right: MetricStreamPosition,
): number {
  metricStreamPositionSchema.parse(left);
  metricStreamPositionSchema.parse(right);
  if (
    left.epoch !== right.epoch ||
    left.topic !== right.topic ||
    left.partition !== right.partition
  ) {
    throw new Error("Cannot compare positions from different metric streams");
  }
  const leftCoordinates = [
    BigInt(left.delivery.major),
    BigInt(left.delivery.minor),
    BigInt(left.delivery.batch),
  ];
  const rightCoordinates = [
    BigInt(right.delivery.major),
    BigInt(right.delivery.minor),
    BigInt(right.delivery.batch),
  ];
  for (const [index, coordinate] of leftCoordinates.entries()) {
    const other = rightCoordinates[index];
    if (other === undefined) throw new Error("Missing native delivery coordinate");
    if (coordinate !== other) return coordinate < other ? -1 : 1;
  }
  return 0;
}
