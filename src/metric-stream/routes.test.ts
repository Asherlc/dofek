import { describe, expect, it } from "vitest";
import {
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
});
