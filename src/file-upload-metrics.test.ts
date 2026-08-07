import { describe, expect, it, vi } from "vitest";

const telemetry = vi.hoisted(() => {
  const lifecycleCounter = { add: vi.fn() };
  const bytesCounter = { add: vi.fn() };
  const checksumCounter = { add: vi.fn() };
  const reconciliationCounter = { add: vi.fn() };
  const counters = new Map([
    ["file_upload.lifecycle.total", lifecycleCounter],
    ["file_upload.bytes.total", bytesCounter],
    ["file_upload.checksum_mismatches.total", checksumCounter],
    ["file_upload.reconciliation.total", reconciliationCounter],
  ]);
  const histogram = { record: vi.fn() };
  return {
    bytesCounter,
    checksumCounter,
    lifecycleCounter,
    reconciliationCounter,
    histogram,
    createCounter: vi.fn((name: string, _options: object) => counters.get(name)),
    createHistogram: vi.fn((_name: string, _options: object) => histogram),
    getMeter: vi.fn(),
  };
});

vi.mock("@opentelemetry/api", () => ({
  metrics: {
    getMeter: telemetry.getMeter.mockReturnValue({
      createCounter: telemetry.createCounter,
      createHistogram: telemetry.createHistogram,
    }),
  },
}));

describe("file upload metrics", () => {
  it("registers the lifecycle instruments with their canonical metadata", async () => {
    vi.resetModules();
    const {
      fileUploadBytesTotal,
      fileUploadChecksumMismatchesTotal,
      fileUploadCompletionDuration,
      fileUploadLifecycleTotal,
      fileUploadReconciliationTotal,
    } = await import("./file-upload-metrics.ts");

    expect(telemetry.getMeter).toHaveBeenCalledWith("dofek-file-upload", "1.0.0");
    expect(telemetry.createCounter).toHaveBeenNthCalledWith(1, "file_upload.lifecycle.total", {
      description: "File upload lifecycle transitions",
      unit: "{uploads}",
    });
    expect(telemetry.createCounter).toHaveBeenNthCalledWith(2, "file_upload.bytes.total", {
      description: "Bytes accepted in completed R2 uploads",
      unit: "By",
    });
    expect(telemetry.createHistogram).toHaveBeenCalledWith("file_upload.completion.duration", {
      description: "Time from upload initiation to queue handoff",
      unit: "s",
      advice: { explicitBucketBoundaries: [1, 5, 15, 30, 60, 300, 900, 3600] },
    });
    expect(telemetry.createCounter).toHaveBeenNthCalledWith(
      3,
      "file_upload.checksum_mismatches.total",
      { description: "Full-object SHA-256 mismatches", unit: "{uploads}" },
    );
    expect(telemetry.createCounter).toHaveBeenNthCalledWith(4, "file_upload.reconciliation.total", {
      description: "Upload records repaired by reconciliation",
      unit: "{uploads}",
    });
    expect(fileUploadLifecycleTotal).toBe(telemetry.lifecycleCounter);
    expect(fileUploadBytesTotal).toBe(telemetry.bytesCounter);
    expect(fileUploadChecksumMismatchesTotal).toBe(telemetry.checksumCounter);
    expect(fileUploadReconciliationTotal).toBe(telemetry.reconciliationCounter);
    expect(fileUploadCompletionDuration).toBe(telemetry.histogram);
  });
});
