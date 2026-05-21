import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { RR_INTERVAL_MS } from "../../../../src/db/sensor-channels.ts";
import { canonicalizeTimestampForExternalId } from "../lib/canonical-timestamp.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";

const PROVIDER_ID = "whoop_ble";
const INSERT_BATCH_SIZE = 2000;

const insertedMetricStreamRowSchema = z.object({
  id: z.string(),
});

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

  constructor(database: Pick<Database, "execute">, userId: string) {
    this.#database = database;
    this.#userId = userId;
  }

  async ensureProvider(): Promise<void> {
    await this.#database.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES (${PROVIDER_ID}, 'WHOOP BLE', ${this.#userId})
          ON CONFLICT (id) DO NOTHING`,
    );
  }

  async insertRealtimeDataBatch(
    deviceId: string,
    samples: WhoopBleRealtimeDataSample[],
  ): Promise<number> {
    if (samples.length === 0) return 0;

    let totalInserted = 0;

    for (let offset = 0; offset < samples.length; offset += INSERT_BATCH_SIZE) {
      const batch = samples.slice(offset, offset + INSERT_BATCH_SIZE);

      const beatIntervalSamples = batch.filter((sample) => sample.rrIntervalMs > 0);
      if (beatIntervalSamples.length > 0) {
        const beatIntervalValues = beatIntervalSamples.map((sample) => {
          const recordedAt = canonicalizeTimestampForExternalId(sample.timestamp);
          const externalId = `${PROVIDER_ID}:${deviceId}:${RR_INTERVAL_MS}:${recordedAt}`;
          return sql`(${sample.timestamp}::timestamptz, ${this.#userId}::uuid, ${PROVIDER_ID}, ${externalId}, ${deviceId}, ${"ble"}, ${RR_INTERVAL_MS}, ${sample.rrIntervalMs}::real)`;
        });
        const insertedRows = await executeWithSchema(
          this.#database,
          insertedMetricStreamRowSchema,
          sql`INSERT INTO fitness.metric_stream
              (recorded_at, user_id, provider_id, external_id, device_id, source_type, channel, scalar)
              VALUES ${sql.join(beatIntervalValues, sql`, `)}
              ON CONFLICT (user_id, provider_id, external_id, channel, recorded_at) DO NOTHING
              RETURNING id`,
        );
        totalInserted += insertedRows.length;
      }

      const orientationSamples = batch.filter(
        (sample) =>
          sample.quaternionW !== 0 ||
          sample.quaternionX !== 0 ||
          sample.quaternionY !== 0 ||
          sample.quaternionZ !== 0,
      );
      if (orientationSamples.length > 0) {
        const orientationSensorValues = orientationSamples.map((sample) => {
          const recordedAt = canonicalizeTimestampForExternalId(sample.timestamp);
          const externalId = `${PROVIDER_ID}:${deviceId}:orientation:${recordedAt}`;
          return sql`(${sample.timestamp}::timestamptz, ${this.#userId}::uuid, ${PROVIDER_ID}, ${externalId}, ${deviceId}, ${"ble"}, ${"orientation"}, ARRAY[${sample.quaternionW}, ${sample.quaternionX}, ${sample.quaternionY}, ${sample.quaternionZ}]::real[])`;
        });
        const insertedRows = await executeWithSchema(
          this.#database,
          insertedMetricStreamRowSchema,
          sql`INSERT INTO fitness.metric_stream
              (recorded_at, user_id, provider_id, external_id, device_id, source_type, channel, vector)
              VALUES ${sql.join(orientationSensorValues, sql`, `)}
              ON CONFLICT (user_id, provider_id, external_id, channel, recorded_at) DO NOTHING
              RETURNING id`,
        );
        totalInserted += insertedRows.length;
      }
    }

    return totalInserted;
  }
}
