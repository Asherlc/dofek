import { describe, expect, it } from "vitest";
import {
  healthKitPushTotal,
  healthKitRecordsTotal,
  syncDuration,
  syncErrorsTotal,
  syncOperationsTotal,
  syncRecordsTotal,
} from "./sync-metrics.ts";

describe("sync-metrics", () => {
  it("exports all sync metric instruments", () => {
    expect(syncRecordsTotal).toBeDefined();
    expect(syncOperationsTotal).toBeDefined();
    expect(syncDuration).toBeDefined();
    expect(syncErrorsTotal).toBeDefined();
  });

  it("exports all HealthKit metric instruments", () => {
    expect(healthKitRecordsTotal).toBeDefined();
    expect(healthKitPushTotal).toBeDefined();
  });

  it("records counter values without throwing (no-op when no MeterProvider)", () => {
    expect(() => {
      syncRecordsTotal.add(10, { provider: "garmin", data_type: "sync", status: "success" });
      syncOperationsTotal.add(1, { provider: "garmin", data_type: "sync", status: "success" });
      syncErrorsTotal.add(1, { provider: "garmin", data_type: "sync" });
      healthKitRecordsTotal.add(50, { endpoint: "pushQuantitySamples", category: "dailyMetric" });
      healthKitPushTotal.add(1, { endpoint: "pushQuantitySamples", status: "success" });
    }).not.toThrow();
  });

  it("records histogram values without throwing (no-op when no MeterProvider)", () => {
    expect(() => {
      syncDuration.record(1500, { provider: "whoop", data_type: "sync" });
    }).not.toThrow();
  });
});
