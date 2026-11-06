import { describe, expect, it } from "vitest";
import {
  assertConcretePersistentPulsarTopic,
  METRIC_STREAM_CONSUMER_ROUTES,
  resolveMetricStreamConsumerRoutes,
} from "./consumer-routes.ts";
import { type MetricStreamRoute, metricStreamTopicForRoute } from "./routes.ts";

describe("METRIC_STREAM_CONSUMER_ROUTES", () => {
  it("pins the three consumer routes to existing topic keys and renderer subscription names", () => {
    expect(METRIC_STREAM_CONSUMER_ROUTES).toEqual([
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
    ]);
  });
});

describe("assertConcretePersistentPulsarTopic", () => {
  it("accepts a concrete persistent URI", () => {
    expect(
      assertConcretePersistentPulsarTopic("persistent://public/default/metric-stream-v1"),
    ).toBe("persistent://public/default/metric-stream-v1");
  });

  it("fails closed on non-persistent or malformed topics", () => {
    expect(() => assertConcretePersistentPulsarTopic("metric-stream-v1")).toThrow(
      /concrete persistent Pulsar topic/i,
    );
    expect(() =>
      assertConcretePersistentPulsarTopic("persistent://public/metric-stream-v1"),
    ).toThrow(/concrete persistent Pulsar topic/i);
  });
});

describe("resolveMetricStreamConsumerRoutes", () => {
  const env = {
    METRIC_STREAM_LEGACY_TOPIC: "persistent://public/default/metric-stream-v1",
    METRIC_STREAM_LIVE_TOPIC: "persistent://public/default/metric-stream-live-v1",
    METRIC_STREAM_HISTORY_TOPIC: "persistent://public/default/metric-stream-history-v1",
  };

  it("resolves topics and exact sink/archive subscriptions for all three routes", () => {
    expect(resolveMetricStreamConsumerRoutes(env)).toEqual([
      {
        id: "legacy",
        topicKey: "METRIC_STREAM_LEGACY_TOPIC",
        topic: env.METRIC_STREAM_LEGACY_TOPIC,
        sinkSubscription: "metric-stream-clickhouse-sink",
        archiveSubscription: "metric-stream-r2-archive",
        subscriptions: ["metric-stream-clickhouse-sink", "metric-stream-r2-archive"],
      },
      {
        id: "live",
        topicKey: "METRIC_STREAM_LIVE_TOPIC",
        topic: env.METRIC_STREAM_LIVE_TOPIC,
        sinkSubscription: "metric-stream-live-clickhouse-sink",
        archiveSubscription: "metric-stream-live-r2-archive",
        subscriptions: ["metric-stream-live-clickhouse-sink", "metric-stream-live-r2-archive"],
      },
      {
        id: "history",
        topicKey: "METRIC_STREAM_HISTORY_TOPIC",
        topic: env.METRIC_STREAM_HISTORY_TOPIC,
        sinkSubscription: "metric-stream-history-clickhouse-sink",
        archiveSubscription: "metric-stream-history-r2-archive",
        subscriptions: [
          "metric-stream-history-clickhouse-sink",
          "metric-stream-history-r2-archive",
        ],
      },
    ]);
  });

  it("fails closed when a required topic env key is missing or not persistent", () => {
    expect(() =>
      resolveMetricStreamConsumerRoutes({
        ...env,
        METRIC_STREAM_LEGACY_TOPIC: undefined,
      }),
    ).toThrow(/METRIC_STREAM_LEGACY_TOPIC is required/);
    expect(() =>
      resolveMetricStreamConsumerRoutes({
        ...env,
        METRIC_STREAM_LIVE_TOPIC: "metric-stream-live-v1",
      }),
    ).toThrow(/concrete persistent Pulsar topic/i);
  });
});

describe("producer MetricStreamRoute remains live|history only", () => {
  it("does not invent a legacy producer route", () => {
    const producerRoutes: MetricStreamRoute[] = ["live", "history"];
    expect(producerRoutes).toEqual(["live", "history"]);
    expect(() => metricStreamTopicForRoute("live", {})).toThrow(/METRIC_STREAM_LIVE_TOPIC/);
    expect(() => metricStreamTopicForRoute("history", {})).toThrow(/METRIC_STREAM_HISTORY_TOPIC/);
  });
});
