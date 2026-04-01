import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";

const PROVIDER_ID = "dofek";
const BATCH_SIZE = 500;

const activityIdRowSchema = z.object({
  id: z.string(),
});

export interface GpsSample {
  recordedAt: string;
  lat: number | null;
  lng: number | null;
  gpsAccuracy: number | null;
  altitude: number | null;
  speed: number | null;
}

export interface SaveActivityInput {
  activityType: string;
  startedAt: string;
  endedAt: string;
  name: string | null;
  notes: string | null;
  sourceName: string;
  samples: GpsSample[];
}

/** Data access for recording activities from the mobile app. */
export class ActivityRecordingRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;

  constructor(db: Pick<Database, "execute">, userId: string) {
    this.#db = db;
    this.#userId = userId;
  }

  /** Ensure the "dofek" provider row exists. */
  async ensureProvider(): Promise<void> {
    await this.#db.execute(
      sql`INSERT INTO fitness.provider (id, name)
          VALUES (${PROVIDER_ID}, 'Dofek')
          ON CONFLICT (id) DO NOTHING`,
    );
  }

  /** Insert or upsert an activity with GPS samples, returning the activity ID. */
  async saveActivity(input: SaveActivityInput): Promise<string> {
    await this.ensureProvider();

    const externalId = `dofek:${input.startedAt}:${this.#userId}`;

    const rows = await executeWithSchema(
      this.#db,
      activityIdRowSchema,
      sql`INSERT INTO fitness.activity (
              user_id, provider_id, external_id, activity_type,
              started_at, ended_at, name, notes, source_name
            )
            VALUES (
              ${this.#userId},
              ${PROVIDER_ID},
              ${externalId},
              ${input.activityType},
              ${input.startedAt}::timestamptz,
              ${input.endedAt}::timestamptz,
              ${input.name},
              ${input.notes},
              ${input.sourceName}
            )
            ON CONFLICT (provider_id, external_id) DO UPDATE SET
              activity_type = EXCLUDED.activity_type,
              started_at = EXCLUDED.started_at,
              ended_at = EXCLUDED.ended_at,
              name = EXCLUDED.name,
              notes = EXCLUDED.notes,
              source_name = EXCLUDED.source_name
            RETURNING id`,
    );

    const row = rows[0];
    if (!row) throw new Error("Failed to insert activity");
    const activityId = row.id;

    // Batch-insert GPS samples into sensor_sample
    for (let index = 0; index < input.samples.length; index += BATCH_SIZE) {
      const batch = input.samples.slice(index, index + BATCH_SIZE);

      if (batch.length === 0) continue;

      // Dual-write GPS samples to sensor_sample (one row per channel per sample)
      const channelMapping: Array<{ channel: string; key: keyof GpsSample }> = [
        { channel: "lat", key: "lat" },
        { channel: "lng", key: "lng" },
        { channel: "gps_accuracy", key: "gpsAccuracy" },
        { channel: "altitude", key: "altitude" },
        { channel: "speed", key: "speed" },
      ];
      for (const { channel, key } of channelMapping) {
        const channelValues = batch
          .filter((sample) => sample[key] != null)
          .map(
            (sample) =>
              sql`(${sample.recordedAt}::timestamptz, ${this.#userId}::uuid, ${activityId}::uuid, ${PROVIDER_ID}, ${input.sourceName}, ${"api"}, ${channel}, ${sample[key]}::real)`,
          );
        if (channelValues.length > 0) {
          await this.#db.execute(
            sql`INSERT INTO fitness.sensor_sample
                (recorded_at, user_id, activity_id, provider_id, device_id, source_type, channel, scalar)
                VALUES ${sql.join(channelValues, sql`, `)}`,
          );
        }
      }
    }

    return activityId;
  }
}
