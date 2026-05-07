import { and, eq, sql } from "drizzle-orm";
import { WhoopRateLimitError } from "whoop-whoop/client";
import type { WhoopWorkoutRecord } from "whoop-whoop/types";
import { parseDuringRange } from "whoop-whoop/utils";
import { activity, exercise, exerciseAlias, strengthSet } from "../../db/schema.ts";
import { withSyncLog } from "../../db/sync-log.ts";
import { buildV2ActivityTypeLookup, parseWeightliftingWorkout, parseWorkout } from "./parsing.ts";
import type { WhoopSyncContext } from "./sync-types.ts";

export type WhoopWorkoutSyncResult = {
  count: number;
  rateLimited: boolean;
};

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

export async function syncWhoopWorkouts(context: WhoopSyncContext): Promise<number> {
  const { db, providerId, options } = context;
  const { workouts, v2ActivityTypeByActivityId } = collectWhoopWorkouts(context);

  try {
    return await withSyncLog(
      db,
      providerId,
      "workouts",
      async () => {
        let count = 0;
        for (const workoutRecord of workouts) {
          try {
            const v2TypeName = workoutRecord.activity_id
              ? v2ActivityTypeByActivityId.get(workoutRecord.activity_id)
              : undefined;
            const parsed = parseWorkout(workoutRecord, v2TypeName);
            if (!parsed) continue;

            await db
              .insert(activity)
              .values({
                providerId,
                externalId: parsed.externalId,
                activityType: parsed.activityType,
                startedAt: parsed.startedAt,
                endedAt: parsed.endedAt,
                raw: {
                  strain: workoutRecord.score,
                  avgHeartRate: parsed.avgHeartRate,
                  maxHeartRate: parsed.maxHeartRate,
                  calories: parsed.calories,
                  durationSeconds: parsed.durationSeconds,
                },
              })
              .onConflictDoUpdate({
                target: [activity.userId, activity.providerId, activity.externalId],
                set: {
                  activityType: parsed.activityType,
                  startedAt: parsed.startedAt,
                  endedAt: parsed.endedAt,
                  raw: {
                    strain: workoutRecord.score,
                    avgHeartRate: parsed.avgHeartRate,
                    maxHeartRate: parsed.maxHeartRate,
                    calories: parsed.calories,
                    durationSeconds: parsed.durationSeconds,
                  },
                },
              });
            count++;
          } catch (err) {
            context.errors.push({
              message: `Workout ${workoutRecord.activity_id}: ${err instanceof Error ? err.message : String(err)}`,
              externalId: workoutRecord.activity_id,
              cause: err,
            });
          }
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

  try {
    const count = await withSyncLog(
      db,
      providerId,
      "strength",
      async () => {
        let count = 0;
        const exerciseCache = new Map<string, string>();

        for (const workoutRecord of workouts) {
          const activityId = workoutRecord.activity_id;
          if (!activityId) continue;

          try {
            const weightliftingData = await client.getWeightliftingWorkout(activityId);
            if (!weightliftingData) continue;

            const parsed = parseWeightliftingWorkout(weightliftingData);
            if (parsed.exercises.length === 0) continue;

            const workoutDuring = weightliftingData.during ?? workoutRecord.during;
            if (!workoutDuring) continue;
            const { start: startedAt, end: endedAt } = parseDuringRange(workoutDuring);

            const [activityRow] = await db
              .insert(activity)
              .values({
                providerId,
                externalId: activityId,
                activityType: "strength",
                startedAt,
                endedAt,
                name: weightliftingData.name ?? null,
                raw: {
                  rawMskStrainScore: parsed.rawMskStrainScore,
                  scaledMskStrainScore: parsed.scaledMskStrainScore,
                  cardioStrainScore: parsed.cardioStrainScore,
                  cardioStrainContributionPercent: parsed.cardioStrainContributionPercent,
                  mskStrainContributionPercent: parsed.mskStrainContributionPercent,
                },
              })
              .onConflictDoUpdate({
                target: [activity.userId, activity.providerId, activity.externalId],
                set: {
                  name: weightliftingData.name ?? null,
                  startedAt,
                  endedAt,
                  raw: sql`COALESCE(fitness.activity.raw, '{}'::jsonb) || ${JSON.stringify({
                    rawMskStrainScore: parsed.rawMskStrainScore,
                    scaledMskStrainScore: parsed.scaledMskStrainScore,
                    cardioStrainScore: parsed.cardioStrainScore,
                    cardioStrainContributionPercent: parsed.cardioStrainContributionPercent,
                    mskStrainContributionPercent: parsed.mskStrainContributionPercent,
                  })}::jsonb`,
                },
              })
              .returning({ id: activity.id });

            const dbActivityId = activityRow?.id;
            if (!dbActivityId) continue;

            await db.delete(strengthSet).where(eq(strengthSet.activityId, dbActivityId));

            const setRows: (typeof strengthSet.$inferInsert)[] = [];
            for (const exerciseRecord of parsed.exercises) {
              const cacheKey = exerciseRecord.providerExerciseId;
              let exerciseId = exerciseCache.get(cacheKey);

              if (!exerciseId) {
                await db
                  .insert(exercise)
                  .values({
                    name: exerciseRecord.exerciseName,
                    equipment: exerciseRecord.equipment,
                    muscleGroups: exerciseRecord.muscleGroups,
                    exerciseType: exerciseRecord.exerciseType,
                  })
                  .onConflictDoNothing();

                const whereClause = exerciseRecord.equipment
                  ? and(
                      eq(exercise.name, exerciseRecord.exerciseName),
                      eq(exercise.equipment, exerciseRecord.equipment),
                    )
                  : eq(exercise.name, exerciseRecord.exerciseName);

                const exerciseRows = await db
                  .select({ id: exercise.id })
                  .from(exercise)
                  .where(whereClause)
                  .limit(1);

                exerciseId = exerciseRows[0]?.id;
                if (exerciseId) {
                  exerciseCache.set(cacheKey, exerciseId);

                  await db
                    .insert(exerciseAlias)
                    .values({
                      exerciseId,
                      providerId,
                      providerExerciseId: exerciseRecord.providerExerciseId,
                      providerExerciseName: exerciseRecord.exerciseName,
                    })
                    .onConflictDoNothing();
                }
              }

              if (!exerciseId) {
                context.errors.push({
                  message: `Could not resolve exercise: ${exerciseRecord.exerciseName}`,
                  externalId: activityId,
                });
                continue;
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
    if (err instanceof WhoopRateLimitError) {
      context.errors.push({
        message: `strength: ${err.message}`,
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
