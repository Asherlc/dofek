import {
  compareMetricStreamPositions,
  type MetricStreamPosition,
} from "../metric-stream/transport-position.ts";

export interface AnalyticsStream {
  transport: MetricStreamPosition["transport"];
  epoch: string;
  topic: string;
  partition: number;
}

export function assertPositionStream(position: MetricStreamPosition, stream: AnalyticsStream) {
  compareMetricStreamPositions(position, {
    ...position,
    ...stream,
  });
}

export function metricStreamPositionIdentity(position: MetricStreamPosition): string {
  return position.offset;
}
