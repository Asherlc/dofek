import type { MetricStreamEventV1, MetricStreamRowInput } from "./events.ts";
import type { MetricStreamEventPublisher } from "./redpanda-producer.ts";

export interface WriteMetricStreamRowsOptions {
  publisher: MetricStreamEventPublisher;
  rows: readonly MetricStreamRowInput[];
}

export interface WriteMetricStreamRowsResult {
  events: MetricStreamEventV1[];
  published: number;
}

export async function writeMetricStreamRows(
  options: WriteMetricStreamRowsOptions,
): Promise<WriteMetricStreamRowsResult> {
  const events = await options.publisher.publishRows(options.rows);
  return {
    events,
    published: events.length,
  };
}
