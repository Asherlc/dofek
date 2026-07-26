import type { Database } from "dofek/db";
import { ALTITUDE, SOURCE_TYPE_API } from "../../../../src/db/sensor-channels.ts";
import type { MetricStreamRowInput } from "../../../../src/metric-stream/events.ts";
import {
  getDefaultMetricStreamEventPublisher,
  type MetricStreamEventPublisher,
} from "../../../../src/metric-stream/redpanda-producer.ts";
import { writeMetricStreamRows } from "../../../../src/metric-stream/write-metric-stream.ts";
import { canonicalizeTimestampForExternalId } from "../lib/canonical-timestamp.ts";
import { ensurePushProvider } from "./push-provider-repository.ts";

const PROVIDER_SLUG = "apple_motion";
const INSERT_BATCH_SIZE = 2000;

export interface WatchAltitudeSample {
  timestamp: string;
  altitudeM: number;
  pressureKPa?: number;
}

export class WatchAltitudeSyncRepository {
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

  #getProviderId(): string {
    return `${PROVIDER_SLUG}:${this.#userId}`;
  }

  async ensureProvider(): Promise<void> {
    const providerId = this.#getProviderId();
    await ensurePushProvider({
      database: this.#database,
      providerId,
      providerName: "Apple Motion",
      userId: this.#userId,
    });
  }

  async insertSampleBatch(deviceId: string, samples: WatchAltitudeSample[]): Promise<number> {
    if (samples.length === 0) return 0;

    const providerId = this.#getProviderId();

    let totalInserted = 0;

    for (let offset = 0; offset < samples.length; offset += INSERT_BATCH_SIZE) {
      const batch = samples.slice(offset, offset + INSERT_BATCH_SIZE);
      const rows: MetricStreamRowInput[] = batch.map((sample) => {
        const canonicalRecordedAt = canonicalizeTimestampForExternalId(sample.timestamp);
        const metadata =
          sample.pressureKPa != null ? { pressure_kpa: sample.pressureKPa } : undefined;

        return {
          recordedAt: sample.timestamp,
          userId: this.#userId,
          providerId,
          externalId: `${providerId}:${deviceId}:${ALTITUDE}:${canonicalRecordedAt}`,
          deviceId,
          sourceType: SOURCE_TYPE_API,
          channel: ALTITUDE,
          scalar: sample.altitudeM,
          metadata,
        };
      });

      const publisher = await this.#publisher();
      const result = await writeMetricStreamRows({ database: this.#database, publisher, rows });
      totalInserted += result.published;
    }

    return totalInserted;
  }
}
