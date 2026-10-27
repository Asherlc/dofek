import { describe, expect, it, vi } from "vitest";
import {
  fitImportDroppedFieldOccurrencesTotal,
  fitImportFilesWithDroppedFieldTotal,
  healthKitPushTotal,
  healthKitRecordsTotal,
  syncDegradationsTotal,
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
    expect(syncDegradationsTotal).toBeDefined();
    expect(syncErrorsTotal).toBeDefined();
    expect(fitImportDroppedFieldOccurrencesTotal).toBeDefined();
    expect(fitImportFilesWithDroppedFieldTotal).toBeDefined();
  });

  it("exports all HealthKit metric instruments", () => {
    expect(healthKitRecordsTotal).toBeDefined();
    expect(healthKitPushTotal).toBeDefined();
  });

  it("records counter values without throwing (no-op when no MeterProvider)", () => {
    expect(() => {
      syncRecordsTotal.add(10, { provider: "garmin", data_type: "sync", status: "success" });
      syncOperationsTotal.add(1, { provider: "garmin", data_type: "sync", status: "success" });
      syncDegradationsTotal.add(1, {
        provider: "whoop",
        step_name: "developer_workouts",
        degradation_kind: "pagination_stalled",
      });
      syncErrorsTotal.add(1, { provider: "garmin", data_type: "sync" });
      fitImportDroppedFieldOccurrencesTotal.add(4, {
        provider: "fit-file",
        file_type: "monitoringB",
        message_type: "stressLevelMesgs",
        field: "stressLevelValue",
        reason: "derived",
      });
      fitImportFilesWithDroppedFieldTotal.add(1, {
        provider: "fit-file",
        file_type: "monitoringB",
        message_type: "stressLevelMesgs",
        field: "stressLevelValue",
        reason: "derived",
      });
      healthKitRecordsTotal.add(50, { endpoint: "pushQuantitySamples", category: "dailyMetric" });
      healthKitPushTotal.add(1, { endpoint: "pushQuantitySamples", status: "success" });
    }).not.toThrow();
  });

  it("records histogram values without throwing (no-op when no MeterProvider)", () => {
    expect(() => {
      syncDuration.record(1500, { provider: "whoop", data_type: "sync" });
    }).not.toThrow();
  });

  it("declares metric names, metadata, and histogram boundaries", async () => {
    const createCounter = vi.fn(() => ({ add: vi.fn() }));
    const createHistogram = vi.fn(() => ({ record: vi.fn() }));
    const getMeter = vi.fn(() => ({ createCounter, createHistogram }));

    vi.resetModules();
    vi.doMock("@opentelemetry/api", () => ({
      metrics: { getMeter },
    }));

    await import("./sync-metrics.ts");

    expect(createCounter).toHaveBeenCalledWith("sync.records.total", {
      description: "Total number of records synced or imported",
      unit: "{records}",
    });
    expect(createCounter).toHaveBeenCalledWith("sync.operations.total", {
      description: "Total number of sync or import operations",
      unit: "{operations}",
    });
    expect(createCounter).toHaveBeenCalledWith("sync.degradations.total", {
      description: "Total number of degraded sync or import steps",
      unit: "{degradations}",
    });
    expect(createCounter).toHaveBeenCalledWith("sync.errors.total", {
      description: "Total number of errors during sync or import",
      unit: "{errors}",
    });
    expect(createCounter).toHaveBeenCalledWith("fit.import.dropped_field_occurrences.total", {
      description: "Total occurrences of decoded FIT fields that were not persisted",
      unit: "{fields}",
    });
    expect(createCounter).toHaveBeenCalledWith("fit.import.files_with_dropped_field.total", {
      description: "Total FIT files containing each decoded field that was not persisted",
      unit: "{files}",
    });
    expect(createCounter).toHaveBeenCalledWith("healthkit.records.total", {
      description: "Total number of records pushed via HealthKit sync",
      unit: "{records}",
    });
    expect(createCounter).toHaveBeenCalledWith("healthkit.push.total", {
      description: "Total number of HealthKit push operations",
      unit: "{operations}",
    });
    expect(createHistogram).toHaveBeenCalledWith("sync.duration", {
      description: "Duration of sync or import operations",
      unit: "ms",
      advice: {
        explicitBucketBoundaries: [
          100, 500, 1_000, 5_000, 10_000, 30_000, 60_000, 300_000, 600_000,
        ],
      },
    });

    vi.doUnmock("@opentelemetry/api");
    vi.resetModules();
  });
});
