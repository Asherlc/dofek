import { describe, expect, it } from "vitest";
import {
  assertWritableMetricStreamTopic,
  metricStreamRouteForSyncJob,
  metricStreamTopicForRoute,
  validateMetricStreamTopicConfiguration,
} from "./routes.ts";

describe("metric stream routes", () => {
  it("routes full refreshes to history and other jobs to live", () => {
    expect(metricStreamRouteForSyncJob({ type: "full" })).toBe("history");
    expect(metricStreamRouteForSyncJob({ type: "days", days: 7 })).toBe("live");
    expect(metricStreamRouteForSyncJob(undefined)).toBe("live");
  });

  it("requires the configured topic for each route", () => {
    expect(() => metricStreamTopicForRoute("live", {})).toThrow(
      "METRIC_STREAM_LIVE_TOPIC is required",
    );
    expect(() => metricStreamTopicForRoute("history", {})).toThrow(
      "METRIC_STREAM_HISTORY_TOPIC is required",
    );
  });

  it("selects the configured topic for each route", () => {
    const env = {
      METRIC_STREAM_LIVE_TOPIC: "metric-stream-live",
      METRIC_STREAM_HISTORY_TOPIC: "metric-stream-history",
    };

    expect(metricStreamTopicForRoute("live", env)).toBe("metric-stream-live");
    expect(metricStreamTopicForRoute("history", env)).toBe("metric-stream-history");
  });

  it.each([
    ["METRIC_STREAM_LIVE_TOPIC", { METRIC_STREAM_HISTORY_TOPIC: "metric-stream-history" }],
    ["METRIC_STREAM_HISTORY_TOPIC", { METRIC_STREAM_LIVE_TOPIC: "metric-stream-live" }],
  ])("rejects a missing %s during startup configuration validation", (key, env) => {
    expect(() => validateMetricStreamTopicConfiguration(env)).toThrow(`${key} is required`);
  });

  it("refuses retired v1 topic names for producers", () => {
    for (const topic of ["metric-stream-v1", "metric-stream-live-v1", "metric-stream-history-v1"]) {
      expect(() => assertWritableMetricStreamTopic(topic)).toThrow(/retired topic generation/);
    }
    expect(() => assertWritableMetricStreamTopic("metric-stream-live-v2")).not.toThrow();
  });

  it("matches retired produce refuse by exact name only", () => {
    for (const topic of [
      "metric-stream-v10",
      "metric-stream-v1-extra",
      "prefix-metric-stream-v1",
      "metric-stream-live-v2",
      "metric-stream-history-v2",
    ]) {
      expect(() => assertWritableMetricStreamTopic(topic)).not.toThrow();
    }
  });
});
