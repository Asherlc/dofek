import type { MetricStreamEventPublisher } from "./publisher.ts";
import {
  closePulsarMetricStreamEventPublishers,
  createPulsarMetricStreamEventPublisherForRoute,
} from "./pulsar-producer.ts";
import type { MetricStreamRoute } from "./routes.ts";

export function getDefaultMetricStreamEventPublisher(): Promise<MetricStreamEventPublisher> {
  return createMetricStreamEventPublisherForRoute("live");
}

export function createMetricStreamEventPublisherForRoute(
  route: MetricStreamRoute,
  env: NodeJS.ProcessEnv = process.env,
): Promise<MetricStreamEventPublisher> {
  return createPulsarMetricStreamEventPublisherForRoute(route, env);
}

export function closeAllMetricStreamEventPublishers(): Promise<void> {
  return closePulsarMetricStreamEventPublishers();
}
