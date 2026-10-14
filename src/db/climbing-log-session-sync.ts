import { and, eq, isNull, notInArray, or } from "drizzle-orm";
import { persistClimbingLogEntries, type SourceClimbingLogEntry } from "./climbing-log-sync.ts";
import type { SyncDatabase } from "./index.ts";
import { climbingLogEntry } from "./schema/climbing.ts";

export interface ClimbingLogSessionsSyncInput {
  userId: string;
  providerId: string;
  standaloneEntries: readonly SourceClimbingLogEntry[];
  sessions: readonly {
    activityId: string;
    entries: readonly SourceClimbingLogEntry[];
    complete: boolean;
  }[];
}

/** Resolve every occurrence before interpreting qualifiers; reconcile only complete session lists. */
export function persistClimbingLogSessions(db: SyncDatabase, input: ClimbingLogSessionsSyncInput) {
  return db.transaction(async (tx) => {
    const result = await persistClimbingLogEntries(tx, {
      userId: input.userId,
      providerId: input.providerId,
      entries: [
        ...input.standaloneEntries,
        ...input.sessions.flatMap((session) =>
          session.entries.map((entry) => ({ ...entry, activityId: session.activityId })),
        ),
      ],
    });
    for (const session of input.sessions) {
      if (!session.complete) continue;
      const present = session.entries.map((entry) => entry.externalId);
      await tx
        .update(climbingLogEntry)
        .set({ providerAbsentAt: new Date() })
        .where(
          and(
            eq(climbingLogEntry.userId, input.userId),
            eq(climbingLogEntry.providerId, input.providerId),
            eq(climbingLogEntry.activityId, session.activityId),
            isNull(climbingLogEntry.providerAbsentAt),
            present.length === 0
              ? undefined
              : or(
                  isNull(climbingLogEntry.externalId),
                  notInArray(climbingLogEntry.externalId, present),
                ),
          ),
        );
    }
    return result;
  });
}
