import { resolveRawProviderActivityType } from "@dofek/training/activity-types";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { MetricStreamRowInput } from "../../../../src/metric-stream/events.ts";
import {
  getDefaultMetricStreamEventPublisher,
  type MetricStreamEventPublisher,
} from "../../../../src/metric-stream/redpanda-producer.ts";
import { writeMetricStreamRows } from "../../../../src/metric-stream/write-metric-stream.ts";
import { canonicalizeTimestampForExternalId } from "../lib/canonical-timestamp.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { ensurePushProvider } from "./push-provider-repository.ts";

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
  readonly #metricStreamPublisher?: MetricStreamEventPublisher;

  constructor(
    db: Pick<Database, "execute">,
    userId: string,
    metricStreamPublisher?: MetricStreamEventPublisher,
  ) {
    this.#db = db;
    this.#userId = userId;
    this.#metricStreamPublisher = metricStreamPublisher;
  }

  async #publisher(): Promise<MetricStreamEventPublisher> {
    return this.#metricStreamPublisher ?? getDefaultMetricStreamEventPublisher();
  }

  /** Ensure the "dofek" provider row exists. */
  async ensureProvider(): Promise<void> {
    await ensurePushProvider({
      database: this.#db,
      providerId: PROVIDER_ID,
      providerName: "Dofek",
      userId: this.#userId,
    });
  }

  /** Insert or upsert an activity with GPS samples, returning the activity ID. */
  async saveActivity(input: SaveActivityInput): Promise<string> {
    await this.ensureProvider();

    const activityStartedAt = canonicalizeTimestampForExternalId(input.startedAt);
    const externalId = `dofek:${activityStartedAt}:${this.#userId}`;
    const activityType = resolveRawProviderActivityType(input.activityType);

    const rows = await executeWithSchema(
      this.#db,
      activityIdRowSchema,
      sql`INSERT INTO fitness.activity (
              user_id, provider_id, external_id, canonical_type, provider_type, modality,
              started_at, ended_at, name, notes, source_name
            )
            VALUES (
              ${this.#userId},
              ${PROVIDER_ID},
              ${externalId},
              ${activityType.canonicalType},
              ${activityType.providerType},
              ${activityType.modality},
              ${input.startedAt}::timestamptz,
              ${input.endedAt}::timestamptz,
              ${input.name},
              ${input.notes},
              ${input.sourceName}
            )
            ON CONFLICT (user_id, provider_id, external_id) DO UPDATE SET
              canonical_type = EXCLUDED.canonical_type,
              provider_type = EXCLUDED.provider_type,
              modality = EXCLUDED.modality,
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

    for (let index = 0; index < input.samples.length; index += BATCH_SIZE) {
      const batch = input.samples.slice(index, index + BATCH_SIZE);

      if (batch.length === 0) continue;

      const rows: MetricStreamRowInput[] = [];
      for (const sample of batch) {
        if (sample.lat != null && sample.lng != null) {
          const metadata =
            sample.gpsAccuracy == null ? undefined : { horizontal_accuracy_m: sample.gpsAccuracy };
          const recordedAt = canonicalizeTimestampForExternalId(sample.recordedAt);
          const sampleExternalId = `${externalId}:location:${recordedAt}`;
          rows.push({
            recordedAt: sample.recordedAt,
            userId: this.#userId,
            activityId,
            providerId: PROVIDER_ID,
            externalId: sampleExternalId,
            deviceId: input.sourceName,
            sourceType: "api",
            channel: "location",
            point: `SRID=4326;POINT(${sample.lng} ${sample.lat})`,
            metadata,
          });
        }

        const channelMapping: Array<{ channel: string; key: keyof GpsSample }> = [
          { channel: "altitude", key: "altitude" },
          { channel: "speed", key: "speed" },
        ];
        for (const { channel, key } of channelMapping) {
          const value = sample[key];
          if (value == null || typeof value !== "number") continue;
          const recordedAt = canonicalizeTimestampForExternalId(sample.recordedAt);
          const sampleExternalId = `${externalId}:${channel}:${recordedAt}`;
          rows.push({
            recordedAt: sample.recordedAt,
            userId: this.#userId,
            activityId,
            providerId: PROVIDER_ID,
            externalId: sampleExternalId,
            deviceId: input.sourceName,
            sourceType: "api",
            channel,
            scalar: value,
          });
        }
      }
      if (rows.length > 0) {
        const publisher = await this.#publisher();
        await writeMetricStreamRows({ database: this.#db, publisher, rows });
      }
    }

    return activityId;
  }
}
