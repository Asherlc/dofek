import { afterEach, describe, expect, it } from "vitest";
import {
  assertKafkaMetricStreamTopicName,
  resolveMetricStreamConsumerRoutes,
} from "./consumer-routes.ts";

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("assertKafkaMetricStreamTopicName", () => {
  it("accepts nonempty Kafka topic names", () => {
    expect(assertKafkaMetricStreamTopicName("metric-stream-live-v2")).toBe("metric-stream-live-v2");
  });

  it("rejects blank, whitespace, and Pulsar persistent URIs", () => {
    expect(() => assertKafkaMetricStreamTopicName("")).toThrow(/nonempty Kafka topic/);
    expect(() => assertKafkaMetricStreamTopicName("metric stream")).toThrow(/without whitespace/);
    expect(() => assertKafkaMetricStreamTopicName("persistent://public/default/sensor")).toThrow(
      /not a Pulsar persistent URI/,
    );
  });
});

describe("resolveMetricStreamConsumerRoutes", () => {
  it("resolves legacy, live, and history routes from env", () => {
    const routes = resolveMetricStreamConsumerRoutes({
      METRIC_STREAM_LEGACY_TOPIC: "metric-stream-v1",
      METRIC_STREAM_LIVE_TOPIC: "metric-stream-live-v2",
      METRIC_STREAM_HISTORY_TOPIC: "metric-stream-history-v2",
    });

    expect(routes.map((route) => route.id)).toEqual(["legacy", "live", "history"]);
    expect(routes[0]).toMatchObject({
      topic: "metric-stream-v1",
      sinkSubscription: "metric-stream-clickhouse-sink",
      archiveSubscription: "metric-stream-r2-archive",
    });
    expect(routes[1]?.topic).toBe("metric-stream-live-v2");
    expect(routes[2]?.topic).toBe("metric-stream-history-v2");
  });

  it("fails closed when any consumer topic env is missing", () => {
    expect(() =>
      resolveMetricStreamConsumerRoutes({
        METRIC_STREAM_LEGACY_TOPIC: "metric-stream-v1",
        METRIC_STREAM_LIVE_TOPIC: "metric-stream-live-v2",
      }),
    ).toThrow(/METRIC_STREAM_HISTORY_TOPIC is required/);
  });
});
