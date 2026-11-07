import {
  closeAllKafkaMetricStreamEventPublishers,
  createKafkaMetricStreamEventPublisherForRoute,
  getDefaultMetricStreamEventPublisher as getDefaultKafkaPublisher,
} from "./kafka-producer.ts";
import type { MetricStreamEventPublisher } from "./publisher.ts";
import type { MetricStreamRoute } from "./routes.ts";

export function getDefaultMetricStreamEventPublisher(): Promise<MetricStreamEventPublisher> {
  return getDefaultKafkaPublisher();
}

export function createMetricStreamEventPublisherForRoute(
  route: MetricStreamRoute,
  env: NodeJS.ProcessEnv = process.env,
): Promise<MetricStreamEventPublisher> {
  return createKafkaMetricStreamEventPublisherForRoute(route, env);
}

export function closeAllMetricStreamEventPublishers(): Promise<void> {
  return closeAllKafkaMetricStreamEventPublishers();
}
