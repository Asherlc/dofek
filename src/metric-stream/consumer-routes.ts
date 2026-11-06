/**
 * Canonical metric-stream CONSUMER route definitions shared by the deploy
 * environment renderer and account-erasure drain composition.
 * Neutral: topic env keys + exact consumer-group subscription names only.
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

/** Exact sink/archive consumer group names from the deploy service renderer. */
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

export function assertKafkaMetricStreamTopicName(topic: string): string {
  const trimmed = topic.trim();
  if (!trimmed || trimmed.includes("\n") || trimmed.includes("\r") || /\s/.test(trimmed)) {
    throw new Error("METRIC_STREAM_TOPIC must be a nonempty Kafka topic name without whitespace");
  }
  if (trimmed.startsWith("persistent://")) {
    throw new Error("METRIC_STREAM_TOPIC must be a Kafka topic name, not a Pulsar persistent URI");
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
 * Resolve the three consumer routes from env. Missing/blank topic keys fail closed.
 * Does not invent subscription names. Legacy v1 topic values remain valid for
 * consume-only drain until retention; producers refuse those names separately.
 */
export function resolveMetricStreamConsumerRoutes(
  env: NodeJS.ProcessEnv = process.env,
): ResolvedMetricStreamConsumerRoute[] {
  return METRIC_STREAM_CONSUMER_ROUTES.map((route) => {
    const raw = env[route.topicKey];
    if (typeof raw !== "string" || raw.trim() === "") {
      throw new Error(`${route.topicKey} is required`);
    }
    const topic = assertKafkaMetricStreamTopicName(raw);
    return {
      id: route.id,
      topicKey: route.topicKey,
      topic,
      sinkSubscription: route.sinkSubscription,
      archiveSubscription: route.archiveSubscription,
      subscriptions: [route.sinkSubscription, route.archiveSubscription] as const,
    };
  });
}
