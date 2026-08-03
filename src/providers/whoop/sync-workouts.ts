import {
  offsetMinutesFromTimestamp,
  resolveRecordLocalTimeContext,
} from "@dofek/format/record-local-time";
import type { WhoopWorkoutRecord } from "@dofek/whoop/types";
import { parseDuringRange } from "@dofek/whoop/utils";
import { eq, sql } from "drizzle-orm";
import { resolveUserExerciseWithProvenance } from "../../db/exercise-provenance.ts";
import {
  finishProviderActivityListSync,
  upsertProviderActivity,
} from "../../db/provider-activity-sync.ts";
import { strengthSet } from "../../db/schema/activity.ts";
import { withSyncLog } from "../../db/sync-log.ts";
import { resolveScopedUserId } from "../../lib/user-context.ts";
import { SyncWindow } from "../sync-window.ts";
import {
  buildV2ActivityTypeLookup,
  parseWeightliftingWorkout,
  parseWorkout,
  resolveWhoopWorkoutExternalId,
} from "./parsing.ts";
import { isWhoopRateLimitError } from "./rate-limit.ts";
import type { WhoopSyncContext } from "./sync-types.ts";

export type WhoopWorkoutSyncResult = {
  count: number;
  rateLimited: boolean;
};

/** Tombstone reconciliation covers at least this many days even on short sync windows. */
const WHOOP_ACTIVITY_ABSENCE_RECONCILE_DAYS = 30;

function whoopLocalTimeContext(workout: WhoopWorkoutRecord, startedAt: Date, endedAt: Date) {
  const offsetMinutes = offsetMinutesFromTimestamp(workout.timezone_offset);
  if (offsetMinutes == null) {
    return {
      timezone: null,
      startUtcOffsetMinutes: null,
      endUtcOffsetMinutes: null,
      localTimeSource: "unknown" as const,
    };
  }
  const context = resolveRecordLocalTimeContext({
    startedAt,
    endedAt,
    startUtcOffsetMinutes: offsetMinutes,
    endUtcOffsetMinutes: offsetMinutes,
    source: "provider_offset",
  });
  return {
    timezone: context.timezone,
    startUtcOffsetMinutes: context.startUtcOffsetMinutes,
    endUtcOffsetMinutes: context.endUtcOffsetMinutes,
    localTimeSource: context.source,
  };
}

function collectWhoopWorkouts(context: WhoopSyncContext): {
  workouts: WhoopWorkoutRecord[];
  v2ActivityTypeByActivityId: Map<string, string>;
} {
  const workouts: WhoopWorkoutRecord[] = [];
  for (const cycle of context.cycles) {
    workouts.push(...(cycle.workouts ?? cycle.strain?.workouts ?? []));
  }
  return {
    workouts,
    v2ActivityTypeByActivityId: buildV2ActivityTypeLookup(context.cycles),
  };
}

async function resolveWhoopPresentExternalIds(
  context: WhoopSyncContext,
  absenceWindow: SyncWindow,
): Promise<Set<string> | null> {
  try {
    return await context.client.listDeveloperWorkoutIdsInWindow(
      absenceWindow.since,
      absenceWindow.until,
    );
  } catch (err) {
    context.errors.push({
      message: `developer workouts: ${err instanceof Error ? err.message : String(err)}`,
      cause: err,
    });
    return null;
  }
}

export type WhoopDeveloperWorkoutsPageResult = {
  presentIds: string[];
  nextToken: string | null;
  reachedWindowStart: boolean;
};

export async function fetchWhoopDeveloperWorkoutsPage(
  context: WhoopSyncContext,
  absenceWindow: SyncWindow,
  nextToken?: string,
): Promise<WhoopDeveloperWorkoutsPageResult> {
  const page = await context.client.listDeveloperWorkouts({ limit: 25, nextToken });
  const presentIds: string[] = [];
  let oldestStartMs = Number.POSITIVE_INFINITY;

  for (const record of page.records) {
    const workoutStartMs = Date.parse(record.start);
    if (!Number.isFinite(workoutStartMs)) continue;
    oldestStartMs = Math.min(oldestStartMs, workoutStartMs);
    if (
      workoutStartMs >= absenceWindow.since.getTime() &&
      workoutStartMs < absenceWindow.until.getTime() &&
      record.id
    ) {
      presentIds.push(record.id);
    }
  }

  return {
    presentIds,
    nextToken: page.next_token ?? null,
    reachedWindowStart: oldestStartMs <= absenceWindow.since.getTime(),
  };
}

export async function persistWhoopWorkoutsFromCycles(
  context: WhoopSyncContext,
  presentExternalIds: Set<string>,
  persistenceOptions: { reconcileAbsence: boolean } = { reconcileAbsence: true },
): Promise<number> {
  const { db, providerId, options } = context;
  const { workouts, v2ActivityTypeByActivityId } = collectWhoopWorkouts(context);
  const absenceWindow = new SyncWindow({
    since: context.since,
    until: context.windowEnd,
  }).withMinimumLookback(WHOOP_ACTIVITY_ABSENCE_RECONCILE_DAYS);

  let count = 0;
  for (const workoutRecord of workouts) {
    try {
      const externalId = resolveWhoopWorkoutExternalId(workoutRecord);
      const v2TypeName = externalId ? v2ActivityTypeByActivityId.get(externalId) : undefined;
      const parsed = parseWorkout(workoutRecord, v2TypeName);
      if (!parsed) continue;

      await upsertProviderActivity(
        db,
        {
          providerId,
          externalId: parsed.externalId,
          activityType: parsed.activityType,
          startedAt: parsed.startedAt,
          endedAt: parsed.endedAt,
          ...whoopLocalTimeContext(workoutRecord, parsed.startedAt, parsed.endedAt),
          raw: {
            strain: workoutRecord.score,
            avgHeartRate: parsed.avgHeartRate,
            maxHeartRate: parsed.maxHeartRate,
            durationSeconds: parsed.durationSeconds,
          },
        },
        {
          activityType: parsed.activityType,
          startedAt: parsed.startedAt,
          endedAt: parsed.endedAt,
          ...whoopLocalTimeContext(workoutRecord, parsed.startedAt, parsed.endedAt),
          raw: {
            strain: workoutRecord.score,
            avgHeartRate: parsed.avgHeartRate,
            maxHeartRate: parsed.maxHeartRate,
            durationSeconds: parsed.durationSeconds,
          },
        },
      );
      count++;
    } catch (err) {
      const activityId = resolveWhoopWorkoutExternalId(workoutRecord) ?? "unknown-workout";
      context.errors.push({
        message: `Workout ${activityId}: ${err instanceof Error ? err.message : String(err)}`,
        externalId: activityId,
        cause: err,
      });
    }
  }

  if (persistenceOptions.reconcileAbsence) {
    await finishProviderActivityListSync(db, {
      providerId,
      userId: options?.userId,
      windowStart: absenceWindow.since,
      windowEnd: absenceWindow.until,
      presentExternalIds,
    });
  }
  return count;
}

export async function syncWhoopWorkouts(context: WhoopSyncContext): Promise<number> {
  const { db, providerId, options } = context;
  const { workouts, v2ActivityTypeByActivityId } = collectWhoopWorkouts(context);
  const absenceWindow = new SyncWindow({
    since: context.since,
    until: context.windowEnd,
  }).withMinimumLookback(WHOOP_ACTIVITY_ABSENCE_RECONCILE_DAYS);
  const presentExternalIds = await resolveWhoopPresentExternalIds(context, absenceWindow);

  try {
    return await withSyncLog(
      db,
      providerId,
      "workouts",
      async () => {
        let count = 0;
        for (const workoutRecord of workouts) {
          try {
            const externalId = resolveWhoopWorkoutExternalId(workoutRecord);
            const v2TypeName = externalId ? v2ActivityTypeByActivityId.get(externalId) : undefined;
            const parsed = parseWorkout(workoutRecord, v2TypeName);
            if (!parsed) continue;

            await upsertProviderActivity(
              db,
              {
                providerId,
                externalId: parsed.externalId,
                activityType: parsed.activityType,
                startedAt: parsed.startedAt,
                endedAt: parsed.endedAt,
                ...whoopLocalTimeContext(workoutRecord, parsed.startedAt, parsed.endedAt),
                raw: {
                  strain: workoutRecord.score,
                  avgHeartRate: parsed.avgHeartRate,
                  maxHeartRate: parsed.maxHeartRate,
                  durationSeconds: parsed.durationSeconds,
                },
              },
              {
                activityType: parsed.activityType,
                startedAt: parsed.startedAt,
                endedAt: parsed.endedAt,
                ...whoopLocalTimeContext(workoutRecord, parsed.startedAt, parsed.endedAt),
                raw: {
                  strain: workoutRecord.score,
                  avgHeartRate: parsed.avgHeartRate,
                  maxHeartRate: parsed.maxHeartRate,
                  durationSeconds: parsed.durationSeconds,
                },
              },
            );
            count++;
          } catch (err) {
            const activityId = resolveWhoopWorkoutExternalId(workoutRecord) ?? "unknown-workout";
            context.errors.push({
              message: `Workout ${activityId}: ${err instanceof Error ? err.message : String(err)}`,
              externalId: activityId,
              cause: err,
            });
          }
        }
        if (presentExternalIds) {
          await finishProviderActivityListSync(db, {
            providerId,
            userId: options?.userId,
            windowStart: absenceWindow.since,
            windowEnd: absenceWindow.until,
            presentExternalIds,
          });
        }
        return { recordCount: count, result: count };
      },
      options?.userId,
    );
  } catch (err) {
    context.errors.push({
      message: `workouts: ${err instanceof Error ? err.message : String(err)}`,
      cause: err,
    });
    return 0;
  }
}

export async function syncWhoopStrength(
  context: WhoopSyncContext,
): Promise<WhoopWorkoutSyncResult> {
  const { db, client, providerId, options } = context;
  const { workouts } = collectWhoopWorkouts(context);
  const userId = resolveScopedUserId(options?.userId);

  try {
    const count = await withSyncLog(
      db,
      providerId,
      "strength",
      async () => {
        let count = 0;
        const exerciseCache = new Map<string, string>();

        for (const workoutRecord of workouts) {
          const activityId = resolveWhoopWorkoutExternalId(workoutRecord);
          if (!activityId) continue;

          try {
            const weightliftingData = await client.getWeightliftingWorkout(activityId);
            if (!weightliftingData) continue;

            const parsed = parseWeightliftingWorkout(weightliftingData);
            if (parsed.exercises.length === 0) continue;

            const workoutDuring = weightliftingData.during ?? workoutRecord.during;
            if (!workoutDuring) continue;
            const { start: startedAt, end: endedAt } = parseDuringRange(workoutDuring);

            const activityRow = await upsertProviderActivity(
              db,
              {
                providerId,
                externalId: activityId,
                activityType: "strength",
                startedAt,
                endedAt,
                ...whoopLocalTimeContext(workoutRecord, startedAt, endedAt),
                name: weightliftingData.name ?? null,
                raw: {
                  rawMskStrainScore: parsed.rawMskStrainScore,
                  scaledMskStrainScore: parsed.scaledMskStrainScore,
                  cardioStrainScore: parsed.cardioStrainScore,
                  cardioStrainContributionPercent: parsed.cardioStrainContributionPercent,
                  mskStrainContributionPercent: parsed.mskStrainContributionPercent,
                },
              },
              {
                activityType: "strength",
                name: weightliftingData.name ?? null,
                startedAt,
                endedAt,
                ...whoopLocalTimeContext(workoutRecord, startedAt, endedAt),
                raw: sql`COALESCE(fitness.activity.raw, '{}'::jsonb) || ${JSON.stringify({
                  rawMskStrainScore: parsed.rawMskStrainScore,
                  scaledMskStrainScore: parsed.scaledMskStrainScore,
                  cardioStrainScore: parsed.cardioStrainScore,
                  cardioStrainContributionPercent: parsed.cardioStrainContributionPercent,
                  mskStrainContributionPercent: parsed.mskStrainContributionPercent,
                })}::jsonb`,
              },
            );

            const dbActivityId = activityRow?.id;
            if (!dbActivityId) continue;

            const setRows: (typeof strengthSet.$inferInsert)[] = [];
            for (const exerciseRecord of parsed.exercises) {
              const cacheKey = exerciseRecord.providerExerciseId;
              let exerciseId = exerciseCache.get(cacheKey);

              if (!exerciseId) {
                exerciseId = await resolveUserExerciseWithProvenance(db, {
                  equipment: exerciseRecord.equipment,
                  exerciseType: exerciseRecord.exerciseType,
                  muscleGroups: exerciseRecord.muscleGroups,
                  name: exerciseRecord.exerciseName,
                  providerExerciseId: exerciseRecord.providerExerciseId,
                  providerExerciseName: exerciseRecord.exerciseName,
                  providerId,
                  userId,
                });
                exerciseCache.set(cacheKey, exerciseId);
              }

              for (const set of exerciseRecord.sets) {
                setRows.push({
                  activityId: dbActivityId,
                  exerciseId,
                  exerciseIndex: exerciseRecord.exerciseIndex,
                  setIndex: set.setIndex,
                  setType: "working",
                  weightKg: set.weightKg,
                  reps: set.reps,
                  durationSeconds: set.durationSeconds,
                  strapLocation: set.strapLocation,
                  strapLocationLaterality: set.strapLocationLaterality,
                });
              }
            }

            if (setRows.length > 0) {
              await db.delete(strengthSet).where(eq(strengthSet.activityId, dbActivityId));
              await db.insert(strengthSet).values(setRows);
            }
            count++;
          } catch (err) {
            context.errors.push({
              message: `Strength ${activityId}: ${err instanceof Error ? err.message : String(err)}`,
              externalId: activityId,
              cause: err,
            });
          }
        }

        return { recordCount: count, result: count };
      },
      options?.userId,
    );
    return { count, rateLimited: false };
  } catch (err) {
    if (isWhoopRateLimitError(err)) {
      context.errors.push({
        message: `strength: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
      return { count: 0, rateLimited: true };
    }
    context.errors.push({
      message: `strength: ${err instanceof Error ? err.message : String(err)}`,
      cause: err,
    });
    return { count: 0, rateLimited: false };
  }
}

export async function syncWhoopStrengthForActivity(
  context: WhoopSyncContext,
  activityId: string,
  exerciseCache = new Map<string, string>(),
): Promise<number> {
  const { db, client, providerId, options } = context;
  const { workouts } = collectWhoopWorkouts(context);
  const workoutRecord = workouts.find(
    (workout) => resolveWhoopWorkoutExternalId(workout) === activityId,
  );
  if (!workoutRecord) return 0;

  const weightliftingData = await client.getWeightliftingWorkout(activityId);
  if (!weightliftingData) return 0;

  const parsed = parseWeightliftingWorkout(weightliftingData);
  if (parsed.exercises.length === 0) return 0;

  const workoutDuring = weightliftingData.during ?? workoutRecord.during;
  if (!workoutDuring) return 0;
  const { start: startedAt, end: endedAt } = parseDuringRange(workoutDuring);

  const activityRow = await upsertProviderActivity(
    db,
    {
      providerId,
      externalId: activityId,
      activityType: "strength",
      startedAt,
      endedAt,
      ...whoopLocalTimeContext(workoutRecord, startedAt, endedAt),
      name: weightliftingData.name ?? null,
      raw: {
        rawMskStrainScore: parsed.rawMskStrainScore,
        scaledMskStrainScore: parsed.scaledMskStrainScore,
        cardioStrainScore: parsed.cardioStrainScore,
        cardioStrainContributionPercent: parsed.cardioStrainContributionPercent,
        mskStrainContributionPercent: parsed.mskStrainContributionPercent,
      },
    },
    {
      activityType: "strength",
      name: weightliftingData.name ?? null,
      startedAt,
      endedAt,
      ...whoopLocalTimeContext(workoutRecord, startedAt, endedAt),
      raw: sql`COALESCE(fitness.activity.raw, '{}'::jsonb) || ${JSON.stringify({
        rawMskStrainScore: parsed.rawMskStrainScore,
        scaledMskStrainScore: parsed.scaledMskStrainScore,
        cardioStrainScore: parsed.cardioStrainScore,
        cardioStrainContributionPercent: parsed.cardioStrainContributionPercent,
        mskStrainContributionPercent: parsed.mskStrainContributionPercent,
      })}::jsonb`,
    },
  );

  const dbActivityId = activityRow?.id;
  if (!dbActivityId) return 0;
  const userId = resolveScopedUserId(options?.userId);

  const setRows: (typeof strengthSet.$inferInsert)[] = [];
  for (const exerciseRecord of parsed.exercises) {
    const cacheKey = exerciseRecord.providerExerciseId;
    let exerciseId = exerciseCache.get(cacheKey);

    if (!exerciseId) {
      exerciseId = await resolveUserExerciseWithProvenance(db, {
        equipment: exerciseRecord.equipment,
        exerciseType: exerciseRecord.exerciseType,
        muscleGroups: exerciseRecord.muscleGroups,
        name: exerciseRecord.exerciseName,
        providerExerciseId: exerciseRecord.providerExerciseId,
        providerExerciseName: exerciseRecord.exerciseName,
        providerId,
        userId,
      });
      exerciseCache.set(cacheKey, exerciseId);
    }

    for (const set of exerciseRecord.sets) {
      setRows.push({
        activityId: dbActivityId,
        exerciseId,
        exerciseIndex: exerciseRecord.exerciseIndex,
        setIndex: set.setIndex,
        setType: "working",
        weightKg: set.weightKg,
        reps: set.reps,
        durationSeconds: set.durationSeconds,
        strapLocation: set.strapLocation,
        strapLocationLaterality: set.strapLocationLaterality,
      });
    }
  }

  if (setRows.length > 0) {
    await db.delete(strengthSet).where(eq(strengthSet.activityId, dbActivityId));
    await db.insert(strengthSet).values(setRows);
  }
  return 1;
}
