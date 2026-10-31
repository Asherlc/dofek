import { resolveProviderActivityType } from "@dofek/training/activity-types";
import { and, eq } from "drizzle-orm";
import { persistClimbingLogEntries } from "../../db/climbing-log-sync.ts";
import { resolveUserExerciseWithProvenance } from "../../db/exercise-provenance.ts";
import type { SyncDatabase } from "../../db/index.ts";
import { upsertProviderActivity } from "../../db/provider-activity-sync.ts";
import { strengthSet } from "../../db/schema/activity.ts";
import { climbingLogEntry } from "../../db/schema/climbing.ts";
import { ensureProvider } from "../../db/tokens.ts";
import type { ImportProvider, SyncResult } from "../types.ts";
import { readCrimpdArchive } from "./archive.ts";
import { parseCrimpdExport } from "./parser.ts";

export class CrimpdProvider implements ImportProvider {
  readonly id = "crimpd";
  readonly name = "Crimpd";
  readonly importOnly = true as const;
  validate(): string | null {
    return null;
  }
}

export async function importCrimpdExportFile(
  db: SyncDatabase,
  filePath: string,
  userId: string,
): Promise<SyncResult> {
  const startedAt = Date.now();
  const archive = await readCrimpdArchive(filePath);
  const workouts = parseCrimpdExport(archive.workoutsCsv, archive.setsCsv);
  const recordsSynced = await db.transaction(async (tx) => {
    await ensureProvider(tx, "crimpd", "Crimpd", undefined, userId);
    let imported = 0;
    for (const workout of workouts) {
      const type =
        workout.climbingEntries.length || workout.raw.TYPE === "Open Climbing"
          ? "rock_climbing"
          : workout.raw.TARGET === "Flexibility"
            ? "flexibility"
            : [
                  "Strength Training",
                  "Compound",
                  "Upper Body",
                  "Lower Body",
                  "Core",
                  "Antagonist Muscles",
                  "Finger Strength",
                ].includes(workout.raw.TARGET ?? "")
              ? "strength"
              : "other";
      // DATE is Crimpd's logged occurrence anchor, not a measured workout start.
      const values = {
        activityType: resolveProviderActivityType(workout.raw.TYPE ?? type, type),
        startedAt: workout.loggedAt,
        endedAt: null,
        name: workout.name,
        notes: workout.notes,
        sourceName: "Crimpd",
        raw: workout.raw,
      };
      const saved = await upsertProviderActivity(
        tx,
        { providerId: "crimpd", userId, externalId: workout.externalId, ...values },
        values,
      );
      if (!saved) continue;
      const entries = [];
      for (const entry of workout.climbingEntries) {
        const [existing] = await tx
          .select({ id: climbingLogEntry.id })
          .from(climbingLogEntry)
          .where(
            and(
              eq(climbingLogEntry.userId, userId),
              eq(climbingLogEntry.providerId, "crimpd"),
              eq(climbingLogEntry.externalId, entry.externalId),
            ),
          )
          .limit(1);
        entries.push(existing ? entry : { ...entry, activityId: saved.id });
      }
      await persistClimbingLogEntries(tx, { userId, providerId: "crimpd", entries });
      for (const set of workout.sets) {
        const exerciseId = await resolveUserExerciseWithProvenance(tx, {
          userId,
          providerId: "crimpd",
          name: set.exerciseName,
          providerExerciseName: set.exerciseName,
          providerExerciseId: null,
          equipment: null,
          exerciseType: null,
          muscleGroups: null,
        });
        const setValues = {
          exerciseId,
          exerciseIndex: set.exerciseIndex,
          setIndex: set.setIndex,
          reps: set.reps,
          distanceMeters: set.distanceMeters,
          notes: set.notes,
          raw: set.raw,
        };
        const [known] = await tx
          .select({ id: strengthSet.id })
          .from(strengthSet)
          .where(
            and(
              eq(strengthSet.activityId, saved.id),
              eq(strengthSet.exerciseIndex, set.exerciseIndex),
              eq(strengthSet.setIndex, set.setIndex),
            ),
          )
          .limit(1);
        if (known) await tx.update(strengthSet).set(setValues).where(eq(strengthSet.id, known.id));
        else await tx.insert(strengthSet).values({ activityId: saved.id, ...setValues });
      }
      imported++;
    }
    return imported;
  });
  return { provider: "crimpd", recordsSynced, errors: [], duration: Date.now() - startedAt };
}
