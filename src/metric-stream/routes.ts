import type { SyncJobData } from "../jobs/queues.ts";

export type MetricStreamRoute = "live" | "history";

/** Retired v1 topic names — consume-only until retention; never produce. */
export const RETIRED_METRIC_STREAM_TOPIC_NAMES = new Set([
  "metric-stream-v1",
  "metric-stream-live-v1",
  "metric-stream-history-v1",
]);

export function metricStreamRouteForSyncJob(
  targetRefreshWindow: SyncJobData["targetRefreshWindow"],
): MetricStreamRoute {
  return targetRefreshWindow?.type === "full" ? "history" : "live";
}

export function assertWritableMetricStreamTopic(topic: string): void {
  if (RETIRED_METRIC_STREAM_TOPIC_NAMES.has(topic)) {
    throw new Error(
      `Refusing to produce to retired topic generation ${topic}; configure METRIC_STREAM_*_TOPIC to a distinct v2 name`,
    );
  }
}

export function metricStreamTopicForRoute(route: MetricStreamRoute, env = process.env): string {
  const key = route === "live" ? "METRIC_STREAM_LIVE_TOPIC" : "METRIC_STREAM_HISTORY_TOPIC";
  const topic = env[key];
  if (!topic) throw new Error(`${key} is required`);
  return topic;
}

export function validateMetricStreamTopicConfiguration(env = process.env): void {
  metricStreamTopicForRoute("live", env);
  metricStreamTopicForRoute("history", env);
}
