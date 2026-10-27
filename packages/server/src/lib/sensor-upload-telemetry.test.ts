import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));
vi.mock("dofek/lib/error-reporting", () => ({ captureException: vi.fn() }));

import { captureException } from "dofek/lib/error-reporting";
import { logger } from "../logger.ts";
import { SensorUploadTelemetry, sensorUploadTelemetrySchema } from "./sensor-upload-telemetry.ts";

const batchId = "268dc563-bc67-4d37-8ff1-0067a7f7ce85";
const bufferInstanceId = "9a5b18b9-6037-47b7-ac55-fc2484191178";

function startTelemetry() {
  const acceptedSamples = [
    { timestamp: "2026-10-22T15:00:00.000Z", heartRateBpm: 80 },
    { timestamp: "2026-10-22T07:59:00-07:00", heartRateBpm: 90 },
  ];
  return new SensorUploadTelemetry({
    stream: "realtime",
    userId: "user-1",
    deviceId: "WHOOP Strap",
    appVersion: "1.12.0",
    assetsVersion: "ota-1",
    telemetry: { batchId, bufferInstanceId },
    inputSamples: [...acceptedSamples, { timestamp: "invalid" }],
    acceptedSamples,
  });
}

describe("SensorUploadTelemetry", () => {
  beforeEach(() => vi.clearAllMocks());

  it("records authenticated identity, versions, counts and chronological sample bounds without values", () => {
    startTelemetry();

    expect(logger.info).toHaveBeenCalledWith("[sensor-upload] upload_received", {
      event: "upload_received",
      stream: "realtime",
      userId: "user-1",
      deviceId: "WHOOP Strap",
      appVersion: "1.12.0",
      assetsVersion: "ota-1",
      batchId,
      bufferInstanceId,
      inputSampleCount: 3,
      acceptedSampleCount: 2,
      filteredSampleCount: 1,
      firstTimestamp: "2026-10-22T14:59:00.000Z",
      lastTimestamp: "2026-10-22T15:00:00.000Z",
    });
    expect(JSON.stringify(vi.mocked(logger.info).mock.calls)).not.toContain("heartRateBpm");
  });

  it("labels nonempty publication as broker acknowledgment and reports elapsed time", () => {
    const clock = vi.spyOn(Date, "now").mockReturnValueOnce(1000).mockReturnValueOnce(1123);
    const telemetry = startTelemetry();
    telemetry.published(6);

    expect(logger.info).toHaveBeenLastCalledWith(
      "[sensor-upload] upload_published",
      expect.objectContaining({
        event: "upload_published",
        batchId,
        publishedRowCount: 6,
        boundary: "redpanda",
        elapsedMs: 123,
      }),
    );
    clock.mockRestore();
  });

  it("distinguishes an empty publication from broker acknowledgment", () => {
    startTelemetry().published(0);
    expect(logger.info).toHaveBeenLastCalledWith(
      "[sensor-upload] upload_published",
      expect.objectContaining({ boundary: "no_metric_rows", publishedRowCount: 0 }),
    );
  });

  it("reports failures with correlation while omitting raw exception text from logs", () => {
    const error = new Error("private upstream detail");
    startTelemetry().failed(error);
    expect(logger.error).toHaveBeenCalledWith(
      "[sensor-upload] upload_failed",
      expect.objectContaining({ event: "upload_failed", batchId, bufferInstanceId }),
    );
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(error.message);
    expect(captureException).toHaveBeenCalledWith(error, {
      tags: { source: "whoop-ble-push-realtime-data" },
      extra: expect.objectContaining({ batchId, bufferInstanceId, userId: "user-1" }),
    });
  });

  it("accepts batch metadata without a native buffer identity and rejects malformed correlation IDs", () => {
    expect(sensorUploadTelemetrySchema.parse({ batchId })).toEqual({ batchId });
    expect(sensorUploadTelemetrySchema.safeParse({ batchId: "not-a-uuid" }).success).toBe(false);
    expect(
      sensorUploadTelemetrySchema.safeParse({ batchId, bufferInstanceId: "bad" }).success,
    ).toBe(false);
  });
});
