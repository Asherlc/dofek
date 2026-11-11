import { captureException } from "dofek/lib/error-reporting";
import { z } from "zod";
import { logger } from "../logger.ts";

export const sensorUploadTelemetrySchema = z.object({
  batchId: z.uuid(),
  bufferInstanceId: z.uuid().optional(),
});

interface TimestampedSample {
  timestamp: string;
}

interface SensorUploadTelemetryInput {
  stream: "imu" | "realtime" | "sensorRecords";
  userId: string;
  deviceId: string;
  appVersion?: string;
  assetsVersion?: string;
  telemetry?: z.infer<typeof sensorUploadTelemetrySchema>;
  inputSamples: readonly TimestampedSample[];
  acceptedSamples: readonly TimestampedSample[];
}

/** Operational sample bounds and publication facts, without sensor values. */
export class SensorUploadTelemetry {
  readonly #startedAt = Date.now();
  readonly #attributes;

  constructor(input: SensorUploadTelemetryInput) {
    let firstTimestampMs = Number.POSITIVE_INFINITY;
    let lastTimestampMs = Number.NEGATIVE_INFINITY;
    for (const sample of input.acceptedSamples) {
      const timestampMs = Date.parse(sample.timestamp);
      firstTimestampMs = Math.min(firstTimestampMs, timestampMs);
      lastTimestampMs = Math.max(lastTimestampMs, timestampMs);
    }
    this.#attributes = {
      stream: input.stream,
      userId: input.userId,
      deviceId: input.deviceId,
      appVersion: input.appVersion,
      assetsVersion: input.assetsVersion,
      batchId: input.telemetry?.batchId,
      bufferInstanceId: input.telemetry?.bufferInstanceId,
      inputSampleCount: input.inputSamples.length,
      acceptedSampleCount: input.acceptedSamples.length,
      filteredSampleCount: input.inputSamples.length - input.acceptedSamples.length,
      firstTimestamp: Number.isFinite(firstTimestampMs)
        ? new Date(firstTimestampMs).toISOString()
        : undefined,
      lastTimestamp: Number.isFinite(lastTimestampMs)
        ? new Date(lastTimestampMs).toISOString()
        : undefined,
    };
    logger.info("[sensor-upload] upload_received", {
      event: "upload_received",
      ...this.#attributes,
    });
  }

  get firstTimestamp(): string | undefined {
    return this.#attributes.firstTimestamp;
  }

  get lastTimestamp(): string | undefined {
    return this.#attributes.lastTimestamp;
  }

  published(publishedRowCount: number): void {
    logger.info("[sensor-upload] upload_published", {
      event: "upload_published",
      ...this.#attributes,
      publishedRowCount,
      boundary: publishedRowCount > 0 ? "redpanda" : "no_metric_rows",
      elapsedMs: Date.now() - this.#startedAt,
    });
  }

  failed(error: unknown): void {
    const attributes = { ...this.#attributes, elapsedMs: Date.now() - this.#startedAt };
    logger.error("[sensor-upload] upload_failed", { event: "upload_failed", ...attributes });
    captureException(error, {
      tags: {
        source: {
          imu: "imu-push-samples",
          realtime: "whoop-ble-push-realtime-data",
          sensorRecords: "whoop-ble-push-sensor-records",
        }[this.#attributes.stream],
      },
      extra: attributes,
    });
  }
}
