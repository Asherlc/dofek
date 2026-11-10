import { and, eq, sql } from "drizzle-orm";
import { loadUserHomeTimezone } from "./home-timezone.ts";
import type { SyncDatabase } from "./index.ts";
import { markProviderActivityPresent } from "./provider-activity-absence.ts";
import { upsertProviderActivity } from "./provider-activity-sync.ts";
import { activity } from "./schema/activity.ts";

/** Persist a source observation without replacing a user's selected activity. */
export async function persistClimbingLogActivityObservation(
  db: SyncDatabase,
  input: {
    userId: string;
    providerId: string;
    source: {
      externalId: string;
      sourceName?: string | null;
      activityObservation?: {
        recordedAt: string;
        gymExternalId?: string | null;
      };
    };
    activityId: string | null;
  },
): Promise<string | null> {
  const { userId, providerId, source, activityId } = input;
  if (!source.activityObservation) return activityId;
  const [known] = await db
    .select({ id: activity.id })
    .from(activity)
    .where(
      and(
        eq(activity.userId, userId),
        eq(activity.providerId, providerId),
        eq(activity.externalId, source.externalId),
        eq(activity.providerType, "climbing_log"),
      ),
    );
  if (activityId !== null && activityId !== known?.id) {
    if (known)
      await db.execute(sql`UPDATE fitness.activity SET deleted_at = COALESCE(deleted_at, NOW())
        WHERE id = ${known.id}::uuid`);
    return activityId;
  }
  const facts = {
    startedAt: new Date(source.activityObservation.recordedAt),
    endedAt: null,
    activityType: {
      canonicalType: "climbing",
      providerType: "climbing_log",
      modality: null,
    } as const,
    sourceName: source.sourceName ?? null,
    raw: source.activityObservation.gymExternalId
      ? { gymExternalId: source.activityObservation.gymExternalId }
      : null,
  };
  const row = await upsertProviderActivity(
    db,
    {
      userId,
      providerId,
      externalId: source.externalId,
      ...facts,
      homeTimezone: await loadUserHomeTimezone(db, userId),
    },
    facts,
  );
  if (!row) throw new Error("Climbing log activity insert returned no row.");
  await markProviderActivityPresent(db, { userId, providerId, externalId: source.externalId });
  return row.id;
}
