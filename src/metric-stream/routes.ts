import type { SyncJobData } from "../jobs/queues.ts";

export type MetricStreamRoute = "live" | "history";

export function metricStreamRouteForSyncJob(
  targetRefreshWindow: SyncJobData["targetRefreshWindow"],
): MetricStreamRoute {
  return targetRefreshWindow?.type === "full" ? "history" : "live";
}

export function metricStreamTopicForRoute(route: MetricStreamRoute, env = process.env): string {
  const key = route === "live" ? "METRIC_STREAM_LIVE_TOPIC" : "METRIC_STREAM_HISTORY_TOPIC";
  const topic = env[key];
  if (!topic) throw new Error(`${key} is required`);
  return topic;
}
