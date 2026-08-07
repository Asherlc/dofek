import { BLE_HEART_RATE_PROVIDER_ID } from "@dofek/providers/push-providers";
import type { Database } from "dofek/db";
import { HEART_RATE, RR_INTERVAL_MS } from "../../../../src/db/sensor-channels.ts";
import type { MetricStreamRowInput } from "../../../../src/metric-stream/events.ts";
import {
  getDefaultMetricStreamEventPublisher,
  type MetricStreamEventPublisher,
} from "../../../../src/metric-stream/redpanda-producer.ts";
import { writeMetricStreamRows } from "../../../../src/metric-stream/write-metric-stream.ts";
import { canonicalizeTimestampForExternalId } from "../lib/canonical-timestamp.ts";
import { ensurePushProvider } from "./push-provider-repository.ts";

const INSERT_BATCH_SIZE = 2000;

/**
 * A single heart-rate notification from a Bluetooth Heart Rate Service device.
 *
 * `heartRateBpm` is the mandatory Heart Rate Measurement value (0x2A37); a
 * strap reports 0 before it detects contact. `rrIntervalsMs` carries the
 * optional beat-to-beat (R-R) intervals from the same notification, used for
 * heart-rate variability. A single notification may include several.
 */
export interface BleHeartRateSample {
  timestamp: string;
  heartRateBpm: number;
  rrIntervalsMs: number[];
}

export class BleHeartRateSyncRepository {
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
      providerId: BLE_HEART_RATE_PROVIDER_ID,
      userId: this.#userId,
    });
  }

  async insertSampleBatch(deviceId: string, samples: BleHeartRateSample[]): Promise<number> {
    if (samples.length === 0) return 0;

    let totalInserted = 0;

    for (let offset = 0; offset < samples.length; offset += INSERT_BATCH_SIZE) {
      const batch = samples.slice(offset, offset + INSERT_BATCH_SIZE);
      const rows: MetricStreamRowInput[] = [];

      for (const sample of batch) {
        // Canonicalized only to build stable external IDs; the row's recordedAt
        // keeps the raw sample timestamp.
        const canonicalRecordedAt = canonicalizeTimestampForExternalId(sample.timestamp);

        // A strap reports 0 bpm before it detects a heartbeat — skip those so
        // we never store a misleading zero-bpm reading.
        if (sample.heartRateBpm > 0) {
          rows.push({
            recordedAt: sample.timestamp,
            userId: this.#userId,
            providerId: BLE_HEART_RATE_PROVIDER_ID,
            externalId: `${BLE_HEART_RATE_PROVIDER_ID}:${deviceId}:${HEART_RATE}:${canonicalRecordedAt}`,
            deviceId,
            sourceType: "ble",
            channel: HEART_RATE,
            scalar: sample.heartRateBpm,
          });
        }

        // A single notification can carry multiple R-R intervals; index keeps
        // their external IDs distinct when they share the notification timestamp.
        sample.rrIntervalsMs.forEach((rrIntervalMs, index) => {
          if (rrIntervalMs <= 0) return;
          rows.push({
            recordedAt: sample.timestamp,
            userId: this.#userId,
            providerId: BLE_HEART_RATE_PROVIDER_ID,
            externalId: `${BLE_HEART_RATE_PROVIDER_ID}:${deviceId}:${RR_INTERVAL_MS}:${canonicalRecordedAt}:${index}`,
            deviceId,
            sourceType: "ble",
            channel: RR_INTERVAL_MS,
            scalar: rrIntervalMs,
          });
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
