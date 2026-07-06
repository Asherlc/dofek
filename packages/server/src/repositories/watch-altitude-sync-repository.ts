import { ALTITUDE, SOURCE_TYPE_API } from "../../../../src/db/sensor-channels.ts";
import type { MetricStreamRowInput } from "../../../../src/metric-stream/events.ts";
import {
  getDefaultMetricStreamEventPublisher,
  type MetricStreamEventPublisher,
} from "../../../../src/metric-stream/redpanda-producer.ts";
import { writeMetricStreamRows } from "../../../../src/metric-stream/write-metric-stream.ts";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { canonicalizeTimestampForExternalId } from "../lib/canonical-timestamp.ts";

const PROVIDER_ID = "apple_motion";
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

  async ensureProvider(): Promise<void> {
    await this.#database.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES (${PROVIDER_ID}, 'Apple Motion', ${this.#userId})
          ON CONFLICT (id) DO NOTHING`,
    );
  }

  async insertSampleBatch(deviceId: string, samples: WatchAltitudeSample[]): Promise<number> {
    if (samples.length === 0) return 0;

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
          providerId: PROVIDER_ID,
          externalId: `${PROVIDER_ID}:${deviceId}:${ALTITUDE}:${canonicalRecordedAt}`,
          deviceId,
          sourceType: SOURCE_TYPE_API,
          channel: ALTITUDE,
          scalar: sample.altitudeM,
          metadata,
        };
      });

      const publisher = await this.#publisher();
      const result = await writeMetricStreamRows({ publisher, rows });
      totalInserted += result.published;
    }

    return totalInserted;
  }
}
