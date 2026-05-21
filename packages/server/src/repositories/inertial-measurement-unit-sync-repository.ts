import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { SOURCE_TYPE_API } from "../../../../src/db/sensor-channels.ts";
import { canonicalizeTimestampForExternalId } from "../lib/canonical-timestamp.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";

const PROVIDER_ID = "apple_motion";
const INSERT_BATCH_SIZE = 5000;

const insertedMetricStreamRowSchema = z.object({
  id: z.string(),
});

export interface InertialMeasurementUnitSample {
  timestamp: string;
  x: number;
  y: number;
  z: number;
  gyroscopeX?: number;
  gyroscopeY?: number;
  gyroscopeZ?: number;
}

export class InertialMeasurementUnitSyncRepository {
  readonly #database: Pick<Database, "execute">;
  readonly #userId: string;

  constructor(database: Pick<Database, "execute">, userId: string) {
    this.#database = database;
    this.#userId = userId;
  }

  async ensureProvider(): Promise<void> {
    await this.#database.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES (${PROVIDER_ID}, 'Apple Motion', ${this.#userId})
          ON CONFLICT (id) DO NOTHING`,
    );
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

      const sensorValuesClauses = batch.map((sample) => {
        const sampleHasGyro =
          sample.gyroscopeX != null || sample.gyroscopeY != null || sample.gyroscopeZ != null;
        const channel = sampleHasGyro ? "imu" : "accel";
        const recordedAt = canonicalizeTimestampForExternalId(sample.timestamp);
        const externalId = `${PROVIDER_ID}:${deviceId}:${channel}:${recordedAt}`;
        const vector = sampleHasGyro
          ? sql`ARRAY[${sample.x}, ${sample.y}, ${sample.z}, ${sample.gyroscopeX ?? 0}, ${sample.gyroscopeY ?? 0}, ${sample.gyroscopeZ ?? 0}]::real[]`
          : sql`ARRAY[${sample.x}, ${sample.y}, ${sample.z}]::real[]`;
        return sql`(${sample.timestamp}::timestamptz, ${this.#userId}::uuid, ${PROVIDER_ID}, ${externalId}, ${deviceId}, ${SOURCE_TYPE_API}, ${channel}, ${vector})`;
      });
      const insertedRows = await executeWithSchema(
        this.#database,
        insertedMetricStreamRowSchema,
        sql`INSERT INTO fitness.metric_stream
            (recorded_at, user_id, provider_id, external_id, device_id, source_type, channel, vector)
            VALUES ${sql.join(sensorValuesClauses, sql`, `)}
            ON CONFLICT (user_id, provider_id, external_id, channel, recorded_at) DO NOTHING
            RETURNING id`,
      );

      totalInserted += insertedRows.length;
    }

    return totalInserted;
  }
}
