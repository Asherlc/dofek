import { resolveRawProviderActivityType } from "@dofek/training/activity-types";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { canonicalizeTimestampForExternalId } from "../lib/canonical-timestamp.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { ensurePushProvider } from "./push-provider-repository.ts";

const PROVIDER_ID = "dofek";

const activityIdRowSchema = z.object({
  id: z.string(),
});

export interface SaveActivityInput {
  activityType: string;
  startedAt: string;
  endedAt: string;
  name: string | null;
  notes: string | null;
  sourceName: string;
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
    await ensurePushProvider({
      database: this.#db,
      providerId: PROVIDER_ID,
      providerName: "Dofek",
      userId: this.#userId,
    });
  }

  /** Insert or upsert an activity recorded by the mobile app. */
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

    return activityId;
  }
}
