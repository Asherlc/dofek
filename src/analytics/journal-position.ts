import {
  compareMetricStreamPositions,
  type MetricStreamPosition,
  metricStreamPositionSchema,
} from "../metric-stream/transport-position.ts";

export interface AnalyticsStream {
  transport: MetricStreamPosition["transport"];
  epoch: string;
  topic: string;
  partition: number;
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

export function metricStreamPositionIdentity(position: MetricStreamPosition): string {
  return position.offset;
}
