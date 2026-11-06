/**
 * Canonical metric-stream CONSUMER route definitions shared by the deploy
 * environment renderer and account-erasure drain composition.
 * Neutral: topic env keys + exact subscription names only — no Pulsar SDK,
 * admin, offset, or proof logic.
 */

export type MetricStreamConsumerRouteId = "legacy" | "live" | "history";

export type MetricStreamConsumerTopicEnvKey =
  | "METRIC_STREAM_LEGACY_TOPIC"
  | "METRIC_STREAM_LIVE_TOPIC"
  | "METRIC_STREAM_HISTORY_TOPIC";

export interface MetricStreamConsumerRouteDefinition {
  id: MetricStreamConsumerRouteId;
  topicKey: MetricStreamConsumerTopicEnvKey;
  sinkSubscription: string;
  archiveSubscription: string;
}

/** Exact sink/archive subscription names from the deploy service renderer. */
export const METRIC_STREAM_CONSUMER_ROUTES: readonly MetricStreamConsumerRouteDefinition[] = [
  {
    id: "legacy",
    topicKey: "METRIC_STREAM_LEGACY_TOPIC",
    sinkSubscription: "metric-stream-clickhouse-sink",
    archiveSubscription: "metric-stream-r2-archive",
  },
  {
    id: "live",
    topicKey: "METRIC_STREAM_LIVE_TOPIC",
    sinkSubscription: "metric-stream-live-clickhouse-sink",
    archiveSubscription: "metric-stream-live-r2-archive",
  },
  {
    id: "history",
    topicKey: "METRIC_STREAM_HISTORY_TOPIC",
    sinkSubscription: "metric-stream-history-clickhouse-sink",
    archiveSubscription: "metric-stream-history-r2-archive",
  },
] as const;

const PERSISTENT_TOPIC_PATTERN = /^persistent:\/\/[^/\s]+\/[^/\s]+\/\S+$/;

export function assertConcretePersistentPulsarTopic(topic: string): string {
  const trimmed = topic.trim();
  if (!PERSISTENT_TOPIC_PATTERN.test(trimmed) || trimmed.includes("\n") || trimmed.includes("\r")) {
    throw new Error("METRIC_STREAM_TOPIC must name one concrete persistent Pulsar topic");
  }
  return trimmed;
}

export interface ResolvedMetricStreamConsumerRoute {
  id: MetricStreamConsumerRouteId;
  topicKey: MetricStreamConsumerTopicEnvKey;
  topic: string;
  sinkSubscription: string;
  archiveSubscription: string;
  /** Sink then archive — caller-explicit drain subscription list. */
  subscriptions: readonly [string, string];
}

/**
 * Resolve the three consumer routes from env. Missing/blank topic keys or
 * non-persistent URIs fail closed. Does not invent subscription names.
 */
export function resolveMetricStreamConsumerRoutes(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedMetricStreamConsumerRoute[] {
  return METRIC_STREAM_CONSUMER_ROUTES.map((route) => {
    const raw = env[route.topicKey];
    if (typeof raw !== "string" || raw.trim() === "") {
      throw new Error(`${route.topicKey} is required`);
    }
    const topic = assertConcretePersistentPulsarTopic(raw);
    return {
      id: route.id,
      topicKey: route.topicKey,
      topic,
      sinkSubscription: route.sinkSubscription,
      archiveSubscription: route.archiveSubscription,
      subscriptions: [route.sinkSubscription, route.archiveSubscription],
    };
  });
}
