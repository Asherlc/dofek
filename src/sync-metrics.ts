import { metrics } from "@opentelemetry/api";

const meter = metrics.getMeter("dofek-sync", "1.0.0");

/** Total number of records synced or imported (by provider, data_type, status). */
export const syncRecordsTotal = meter.createCounter("sync.records.total", {
  description: "Total number of records synced or imported",
  unit: "{records}",
});

/** Total number of sync or import operations (by provider, data_type, status). */
export const syncOperationsTotal = meter.createCounter("sync.operations.total", {
  description: "Total number of sync or import operations",
  unit: "{operations}",
});

/** Duration of sync or import operations in milliseconds (by provider, data_type). */
export const syncDuration = meter.createHistogram("sync.duration", {
  description: "Duration of sync or import operations",
  unit: "ms",
  advice: {
    explicitBucketBoundaries: [100, 500, 1_000, 5_000, 10_000, 30_000, 60_000, 300_000, 600_000],
  },
});

/** Total number of degraded sync or import steps (by provider, step_name, degradation_kind). */
export const syncDegradationsTotal = meter.createCounter("sync.degradations.total", {
  description: "Total number of degraded sync or import steps",
  unit: "{degradations}",
});

/** Total number of errors during sync or import (by provider, data_type). */
export const syncErrorsTotal = meter.createCounter("sync.errors.total", {
  description: "Total number of errors during sync or import",
  unit: "{errors}",
});

/** Total occurrences of decoded FIT fields that were intentionally not persisted. */
export const fitImportDroppedFieldOccurrencesTotal = meter.createCounter(
  "fit.import.dropped_field_occurrences.total",
  {
    description: "Total occurrences of decoded FIT fields that were not persisted",
    unit: "{fields}",
  },
);

/** Total FIT files containing each decoded field that was intentionally not persisted. */
export const fitImportFilesWithDroppedFieldTotal = meter.createCounter(
  "fit.import.files_with_dropped_field.total",
  {
    description: "Total FIT files containing each decoded field that was not persisted",
    unit: "{files}",
  },
);

/** Total number of records pushed via HealthKit sync (by endpoint, category). */
export const healthKitRecordsTotal = meter.createCounter("healthkit.records.total", {
  description: "Total number of records pushed via HealthKit sync",
  unit: "{records}",
});

/** Total number of HealthKit push operations (by endpoint, status). */
export const healthKitPushTotal = meter.createCounter("healthkit.push.total", {
  description: "Total number of HealthKit push operations",
  unit: "{operations}",
});
