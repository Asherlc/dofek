import { metrics } from "@opentelemetry/api";

const meter = metrics.getMeter("dofek-file-upload", "1.0.0");

export const fileUploadLifecycleTotal = meter.createCounter("file_upload.lifecycle.total", {
  description: "File upload lifecycle transitions",
  unit: "{uploads}",
});

export const fileUploadBytesTotal = meter.createCounter("file_upload.bytes.total", {
  description: "Bytes accepted in completed R2 uploads",
  unit: "By",
});

export const fileUploadCompletionDuration = meter.createHistogram(
  "file_upload.completion.duration",
  {
    description: "Time from upload initiation to queue handoff",
    unit: "s",
    advice: { explicitBucketBoundaries: [1, 5, 15, 30, 60, 300, 900, 3600] },
  },
);

export const fileUploadChecksumMismatchesTotal = meter.createCounter(
  "file_upload.checksum_mismatches.total",
  { description: "Full-object SHA-256 mismatches", unit: "{uploads}" },
);

export const fileUploadReconciliationTotal = meter.createCounter(
  "file_upload.reconciliation.total",
  { description: "Upload records repaired by reconciliation", unit: "{uploads}" },
);
