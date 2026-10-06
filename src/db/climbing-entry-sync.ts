import { and, eq, isNotNull, isNull, notInArray, or, sql } from "drizzle-orm";
import type { SyncDatabase } from "./index.ts";
import { climbingEntry } from "./schema/activity.ts";

type SessionEntry = Omit<
  typeof climbingEntry.$inferInsert,
  "id" | "userId" | "providerId" | "activityId" | "createdAt"
> & { externalId: string };

/** Called inside the importing session's transaction, after validating its source records. */
export async function persistClimbingSessionEntries(
  db: SyncDatabase,
  session: {
    userId: string;
    providerId: string;
    activityId: string;
    entries: SessionEntry[];
    complete: boolean;
  },
): Promise<void> {
  const { userId, providerId, activityId, entries, complete } = session;
  if (entries.length > 0) {
    const written = await db
      .insert(climbingEntry)
      .values(
        entries.map((entry) => ({
          ...entry,
          userId,
          providerId,
          activityId,
          providerAbsentAt: null,
        })),
      )
      .onConflictDoUpdate({
        target: [climbingEntry.activityId, climbingEntry.externalId],
        targetWhere: isNotNull(climbingEntry.externalId),
        setWhere: and(eq(climbingEntry.userId, userId), eq(climbingEntry.providerId, providerId)),
        set: {
          climbType: sql`excluded.climb_type`,
          gradeSystem: sql`excluded.grade_system`,
          grade: sql`excluded.grade`,
          resultStyle: sql`excluded.result_style`,
          climbStyle: sql`excluded.climb_style`,
          locationPath: sql`excluded.location_path`,
          board: sql`excluded.board`,
          wallAngle: sql`excluded.wall_angle`,
          attemptCount: sql`excluded.attempt_count`,
          routeName: sql`excluded.route_name`,
          sourceName: sql`excluded.source_name`,
          raw: sql`excluded.raw`,
          providerAbsentAt: null,
        },
      })
      .returning({ id: climbingEntry.id });
    if (written.length !== entries.length) {
      throw new Error(
        "Climbing entry identities conflict with another source; existing records were preserved.",
      );
    }
  }
  if (!complete) return;
  const missing =
    entries.length > 0
      ? or(
          isNull(climbingEntry.externalId),
          notInArray(
            climbingEntry.externalId,
            entries.map((entry) => entry.externalId),
          ),
        )
      : undefined;
  await db.execute(sql`
    UPDATE ${climbingEntry} SET provider_absent_at = NOW()
    WHERE ${and(eq(climbingEntry.userId, userId), eq(climbingEntry.providerId, providerId), eq(climbingEntry.activityId, activityId), isNull(climbingEntry.providerAbsentAt), missing)}
  `);
}
