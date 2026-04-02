import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PROVIDER_ID = "apple_motion";
const INSERT_BATCH_SIZE = 5000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AccelerometerSample {
  timestamp: string;
  x: number;
  y: number;
  z: number;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Data access for accelerometer sample ingestion from Apple Motion. */
export class AccelerometerSyncRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;

  constructor(db: Pick<Database, "execute">, userId: string) {
    this.#db = db;
    this.#userId = userId;
  }

  /** Ensure the apple_motion provider row exists. */
  async ensureProvider(): Promise<void> {
    await this.#db.execute(
      sql`INSERT INTO fitness.provider (id, name, user_id)
          VALUES (${PROVIDER_ID}, 'Apple Motion', ${this.#userId})
          ON CONFLICT (id) DO NOTHING`,
    );
  }

  /**
   * Bulk-insert accelerometer samples using multi-row VALUES.
   * At 50 Hz, a 12-hour sync produces ~2.16M samples.
   * Single-row inserts would be unacceptably slow — multi-row is critical.
   */
  async insertBatch(
    deviceId: string,
    deviceType: string,
    samples: AccelerometerSample[],
  ): Promise<number> {
    if (samples.length === 0) return 0;

    let totalInserted = 0;

    for (let offset = 0; offset < samples.length; offset += INSERT_BATCH_SIZE) {
      const batch = samples.slice(offset, offset + INSERT_BATCH_SIZE);

      const valuesClauses = batch.map(
        (sample) =>
          sql`(${sample.timestamp}::timestamptz, ${this.#userId}::uuid, ${deviceId}, ${deviceType}, ${PROVIDER_ID}, ${sample.x}, ${sample.y}, ${sample.z})`,
      );

      await this.#db.execute(
        sql`INSERT INTO fitness.accelerometer_sample
            (recorded_at, user_id, device_id, device_type, provider_id, x, y, z)
            VALUES ${sql.join(valuesClauses, sql`, `)}`,
      );

      totalInserted += batch.length;
    }

    return totalInserted;
  }
}
