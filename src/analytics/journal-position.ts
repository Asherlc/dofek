import { z } from "zod";
import {
  kafkaMetricStreamPositionSchema,
  type MetricStreamPosition,
  pulsarMetricStreamPositionSchema,
} from "../metric-stream/transport-position.ts";

export const journalDeliveryKeySchema = z.union([
  pulsarMetricStreamPositionSchema.shape.delivery.strict(),
  z.strictObject({ offset: kafkaMetricStreamPositionSchema.shape.offset }),
]);
export type JournalDeliveryKey = z.infer<typeof journalDeliveryKeySchema>;

export function journalDeliveryKey(position: MetricStreamPosition): JournalDeliveryKey {
  return position.transport === "kafka" ? { offset: position.offset } : position.delivery;
}

export function positionAtJournalKey(
  position: MetricStreamPosition,
  key: JournalDeliveryKey,
): MetricStreamPosition {
  if (position.transport === "kafka" && "offset" in key) return { ...position, offset: key.offset };
  if (position.transport === "pulsar" && "major" in key) return { ...position, delivery: key };
  throw new Error("Analytics cursor transport must match its stream");
}

export function journalPositionColumns(position: MetricStreamPosition) {
  return {
    transport: position.transport,
    epoch: position.epoch,
    topic: position.topic,
    partition: position.partition,
    kafka_offset: position.transport === "kafka" ? position.offset : "0",
    major: position.transport === "pulsar" ? position.delivery.major : "0",
    minor: position.transport === "pulsar" ? position.delivery.minor : "0",
    batch: position.transport === "pulsar" ? position.delivery.batch : -1,
  };
}

export function metricStreamPositionIdentity(position: MetricStreamPosition): string {
  return position.transport === "pulsar" ? position.serializedMessageId : position.offset;
}
