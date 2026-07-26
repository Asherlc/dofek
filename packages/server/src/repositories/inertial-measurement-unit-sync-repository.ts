import type { InertialMeasurementUnitSample } from "@dofek/imu";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { Database } from "dofek/db";
import { SOURCE_TYPE_API } from "../../../../src/db/sensor-channels.ts";
import type { MetricStreamRowInput } from "../../../../src/metric-stream/events.ts";
import {
  getDefaultMetricStreamEventPublisher,
  type MetricStreamEventPublisher,
} from "../../../../src/metric-stream/redpanda-producer.ts";
import { writeMetricStreamRows } from "../../../../src/metric-stream/write-metric-stream.ts";
import { canonicalizeTimestampForExternalId } from "../lib/canonical-timestamp.ts";
import { ensurePushProvider } from "./push-provider-repository.ts";

const tracer = trace.getTracer("dofek-server");

const PROVIDER_ID = "apple_motion";
const INSERT_BATCH_SIZE = 5000;

export class InertialMeasurementUnitSyncRepository {
  readonly #database: Pick<Database, "execute">;
  readonly #userId: string;
  readonly #metricStreamPublisher?: MetricStreamEventPublisher;

  constructor(
    database: Pick<Database, "execute">,
    userId: string,
    metricStreamPublisher?: MetricStreamEventPublisher,
  ) {
    this.#database = database;
    this.#userId = userId;
    this.#metricStreamPublisher = metricStreamPublisher;
  }

  async #publisher(): Promise<MetricStreamEventPublisher> {
    return this.#metricStreamPublisher ?? getDefaultMetricStreamEventPublisher();
  }

  async ensureProvider(): Promise<void> {
    await ensurePushProvider({
      database: this.#database,
      providerId: PROVIDER_ID,
      providerName: "Apple Motion",
      userId: this.#userId,
    });
  }

  async insertBatch(
    deviceId: string,
    _deviceType: string,
    samples: InertialMeasurementUnitSample[],
  ): Promise<number> {
    if (samples.length === 0) return 0;

    let totalInserted = 0;

    for (let offset = 0; offset < samples.length; offset += INSERT_BATCH_SIZE) {
      const batch = samples.slice(offset, offset + INSERT_BATCH_SIZE);

      const rows: MetricStreamRowInput[] = batch.map((sample) => {
        const sampleHasGyro =
          sample.gyroscopeX != null || sample.gyroscopeY != null || sample.gyroscopeZ != null;
        const channel = sampleHasGyro ? "imu" : "accel";
        const recordedAt = canonicalizeTimestampForExternalId(sample.timestamp);
        const externalId = `${PROVIDER_ID}:${deviceId}:${channel}:${recordedAt}`;
        const vector = sampleHasGyro
          ? [
              sample.x,
              sample.y,
              sample.z,
              sample.gyroscopeX ?? 0,
              sample.gyroscopeY ?? 0,
              sample.gyroscopeZ ?? 0,
            ]
          : [sample.x, sample.y, sample.z];
        return {
          recordedAt: sample.timestamp,
          userId: this.#userId,
          providerId: PROVIDER_ID,
          externalId,
          deviceId,
          sourceType: SOURCE_TYPE_API,
          channel,
          vector,
        };
      });

      await tracer.startActiveSpan("imu.writeMetricStreamRows", async (span) => {
        try {
          span.setAttributes({
            "imu.batchOffset": offset,
            "imu.batchRowCount": rows.length,
          });

          const publisher = await this.#publisher();
          const result = await writeMetricStreamRows({
            database: this.#database,
            publisher,
            rows,
          });
          totalInserted += result.published;

          span.setStatus({ code: SpanStatusCode.OK });
        } catch (error) {
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: error instanceof Error ? error.message : String(error),
          });
          if (error instanceof Error) {
            span.recordException(error);
          }
          throw error;
        } finally {
          span.end();
        }
      });
    }

    return totalInserted;
  }
}
