import { z } from "zod";
import {
  compareMetricStreamPositions,
  kafkaMetricStreamPositionSchema,
  type MetricStreamPosition,
  metricStreamPositionSchema,
  pulsarMetricStreamPositionSchema,
} from "../metric-stream/transport-position.ts";

export interface AnalyticsStream {
  transport: MetricStreamPosition["transport"];
  epoch: string;
  topic: string;
  partition: number;
}

export const journalDeliveryKeySchema = z.union([
  pulsarMetricStreamPositionSchema.shape.delivery.strict(),
  z.strictObject({ offset: kafkaMetricStreamPositionSchema.shape.offset }),
]);
export type JournalDeliveryKey = z.infer<typeof journalDeliveryKeySchema>;

export interface AnalyticsEffectCursor {
  delivery: JournalDeliveryKey;
  effectOrdinal: string;
}

export function assertPositionStream(position: MetricStreamPosition, stream: AnalyticsStream) {
  metricStreamPositionSchema.parse(position);
  if (position.transport !== stream.transport)
    throw new Error("Analytics position transport must match its stream");
  compareMetricStreamPositions(position, {
    ...position,
    epoch: stream.epoch,
    topic: stream.topic,
    partition: stream.partition,
  });
}

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
