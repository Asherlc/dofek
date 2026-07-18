import { WHOOP_BLE_PROVIDER_ID } from "@dofek/providers/push-providers";
import type { Database } from "dofek/db";
import { RR_INTERVAL_MS } from "../../../../src/db/sensor-channels.ts";
import type { MetricStreamRowInput } from "../../../../src/metric-stream/events.ts";
import {
  getDefaultMetricStreamEventPublisher,
  type MetricStreamEventPublisher,
} from "../../../../src/metric-stream/redpanda-producer.ts";
import { writeMetricStreamRows } from "../../../../src/metric-stream/write-metric-stream.ts";
import { canonicalizeTimestampForExternalId } from "../lib/canonical-timestamp.ts";
import { ensurePushProvider } from "./push-provider-repository.ts";

const INSERT_BATCH_SIZE = 2000;

export interface WhoopBleRealtimeDataSample {
  timestamp: string;
  rrIntervalMs: number;
  quaternionW: number;
  quaternionX: number;
  quaternionY: number;
  quaternionZ: number;
}

export class WhoopBleSyncRepository {
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
      providerId: WHOOP_BLE_PROVIDER_ID,
      userId: this.#userId,
    });
  }

  async insertRealtimeDataBatch(
    deviceId: string,
    samples: WhoopBleRealtimeDataSample[],
  ): Promise<number> {
    if (samples.length === 0) return 0;

    let totalInserted = 0;

    for (let offset = 0; offset < samples.length; offset += INSERT_BATCH_SIZE) {
      const batch = samples.slice(offset, offset + INSERT_BATCH_SIZE);
      const rows: MetricStreamRowInput[] = [];

      const beatIntervalSamples = batch.filter((sample) => sample.rrIntervalMs > 0);
      for (const sample of beatIntervalSamples) {
        const recordedAt = canonicalizeTimestampForExternalId(sample.timestamp);
        const externalId = `${WHOOP_BLE_PROVIDER_ID}:${deviceId}:${RR_INTERVAL_MS}:${recordedAt}`;
        rows.push({
          recordedAt: sample.timestamp,
          userId: this.#userId,
          providerId: WHOOP_BLE_PROVIDER_ID,
          externalId,
          deviceId,
          sourceType: "ble",
          channel: RR_INTERVAL_MS,
          scalar: sample.rrIntervalMs,
        });
      }

      const orientationSamples = batch.filter(
        (sample) =>
          sample.quaternionW !== 0 ||
          sample.quaternionX !== 0 ||
          sample.quaternionY !== 0 ||
          sample.quaternionZ !== 0,
      );
      for (const sample of orientationSamples) {
        const recordedAt = canonicalizeTimestampForExternalId(sample.timestamp);
        const externalId = `${WHOOP_BLE_PROVIDER_ID}:${deviceId}:orientation:${recordedAt}`;
        rows.push({
          recordedAt: sample.timestamp,
          userId: this.#userId,
          providerId: WHOOP_BLE_PROVIDER_ID,
          externalId,
          deviceId,
          sourceType: "ble",
          channel: "orientation",
          vector: [sample.quaternionW, sample.quaternionX, sample.quaternionY, sample.quaternionZ],
        });
      }

      if (rows.length > 0) {
        const publisher = await this.#publisher();
        const result = await writeMetricStreamRows({ database: this.#database, publisher, rows });
        totalInserted += result.published;
      }
    }

    return totalInserted;
  }
}
