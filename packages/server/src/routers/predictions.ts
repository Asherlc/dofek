import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type {
  ActivityRow,
  BodyCompRow,
  DailyRow,
  NutritionRow,
  SleepRow,
} from "../insights/engine.ts";
import { joinByDate } from "../insights/engine.ts";
import {
  ACTIVITY_PREDICTION_TARGETS,
  buildActivityDataset,
  type CardioActivityRow,
  type DailyContext,
  type StrengthWorkoutRow,
} from "../ml/activity-features.ts";
import { getPredictionTarget, PREDICTION_TARGETS } from "../ml/features.ts";
import { trainFromDataset, trainPredictor } from "../ml/predictor.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

/** SQL row for activity summary (pre-aggregated from metric_stream) */
interface ActivitySummaryRow {
  [key: string]: string | number | Date | boolean | null | undefined;
  activity_id: string;
  activity_type: string;
  started_at: string;
  avg_hr: number | null;
  avg_power: number | null;
  avg_speed: number | null;
  total_distance: number | null;
  elevation_gain_m: number | null;
  avg_cadence: number | null;
  duration_min: number | null;
}

/** SQL row for per-day exercise minutes (aggregated from activity_summary) */
interface ExerciseMinutesRow {
  [key: string]: string | number | Date | boolean | null | undefined;
  date: string;
  exercise_minutes: number | null;
}

/** SQL row for strength workout volume */
interface StrengthVolumeRow {
  [key: string]: string | number | Date | boolean | null | undefined;
  workout_id: string;
  started_at: string;
  total_volume: number | null;
  working_set_count: number | null;
  max_weight: number | null;
  avg_rpe: number | null;
}

const ALL_TARGETS = [
  ...PREDICTION_TARGETS.map((t) => ({
    id: t.id,
    label: t.label,
    unit: t.unit,
    type: "daily" as const,
  })),
  ...ACTIVITY_PREDICTION_TARGETS.map((t) => ({
    id: t.id,
    label: t.label,
    unit: t.unit,
    type: "activity" as const,
  })),
];

export const predictionsRouter = router({
  /** Available prediction targets */
  targets: cachedProtectedQuery(CacheTTL.LONG).query(() => ALL_TARGETS),

  /**
   * Train models for the given target. Handles both daily targets
   * (HRV, resting HR, sleep, weight) and activity-level targets
   * (cardio power, strength volume).
   */
  predict: cachedProtectedQuery(CacheTTL.LONG)
    .input(
      z.object({
        target: z.string().default("hrv"),
        days: z.number().default(365),
      }),
    )
    .query(async ({ ctx, input }) => {
      // Check if it's a daily target
      const dailyTarget = getPredictionTarget(input.target);
      if (dailyTarget) {
        return trainDailyPrediction(ctx.db, ctx.userId, input.days, dailyTarget);
      }

      // Check if it's an activity target
      const activityTarget = ACTIVITY_PREDICTION_TARGETS.find((t) => t.id === input.target);
      if (activityTarget) {
        return trainActivityPrediction(ctx.db, ctx.userId, input.days, activityTarget);
      }

      return null;
    }),
});

/** Train daily-level predictions (existing pipeline) */
async function trainDailyPrediction(
  db: Database,
  userId: string,
  days: number,
  target: (typeof PREDICTION_TARGETS)[number],
) {
  const dbAny = db as { execute: <T>(query: ReturnType<typeof sql>) => Promise<T[]> };
  const [metrics, sleep, activities, nutrition, bodyComp] = await Promise.all([
    dbAny.execute<DailyRow>(
      sql`SELECT date, resting_hr, hrv, spo2_avg, steps, active_energy_kcal, skin_temp_c
          FROM fitness.v_daily_metrics
          WHERE user_id = ${userId}
            AND date > CURRENT_DATE - ${days}::int
          ORDER BY date ASC`,
    ),
    dbAny.execute<SleepRow>(
      sql`SELECT started_at, duration_minutes, deep_minutes, rem_minutes,
                 light_minutes, awake_minutes, efficiency_pct, is_nap
          FROM fitness.v_sleep
          WHERE user_id = ${userId}
            AND started_at > CURRENT_DATE - ${days}::int
          ORDER BY started_at ASC`,
    ),
    dbAny.execute<ActivityRow>(
      sql`SELECT started_at, ended_at, activity_type
          FROM fitness.v_activity
          WHERE user_id = ${userId}
            AND started_at > CURRENT_DATE - ${days}::int
          ORDER BY started_at ASC`,
    ),
    dbAny.execute<NutritionRow>(
      sql`SELECT date, calories, protein_g, carbs_g, fat_g, fiber_g, water_ml
          FROM fitness.nutrition_daily
          WHERE user_id = ${userId}
            AND date > CURRENT_DATE - ${days}::int
          ORDER BY date ASC`,
    ),
    dbAny.execute<BodyCompRow>(
      sql`SELECT recorded_at, weight_kg, body_fat_pct
          FROM fitness.v_body_measurement
          WHERE user_id = ${userId}
            AND recorded_at > CURRENT_DATE - ${days}::int
          ORDER BY recorded_at ASC`,
    ),
  ]);

  const joined = joinByDate(metrics, sleep, activities, nutrition, bodyComp, {
    minDailyCalories: 1200,
  });

  return trainPredictor(joined, target);
}

/** Train activity-level predictions */
async function trainActivityPrediction(
  db: Database,
  userId: string,
  days: number,
  target: (typeof ACTIVITY_PREDICTION_TARGETS)[number],
) {
  const dbAny = db as { execute: <T>(query: ReturnType<typeof sql>) => Promise<T[]> };

  // Always need daily context for trailing features
  const [dailyMetrics, sleepRows, nutritionRows, bodyCompRows, exerciseMinutesRows] =
    await Promise.all([
      dbAny.execute<DailyRow>(
        sql`SELECT date, resting_hr, hrv, spo2_avg, steps, active_energy_kcal, skin_temp_c
            FROM fitness.v_daily_metrics
            WHERE user_id = ${userId}
              AND date > CURRENT_DATE - ${days}::int
            ORDER BY date ASC`,
      ),
      dbAny.execute<SleepRow>(
        sql`SELECT started_at, duration_minutes, deep_minutes, rem_minutes,
                   light_minutes, awake_minutes, efficiency_pct, is_nap
            FROM fitness.v_sleep
            WHERE user_id = ${userId}
              AND started_at > CURRENT_DATE - ${days}::int
            ORDER BY started_at ASC`,
      ),
      dbAny.execute<NutritionRow>(
        sql`SELECT date, calories, protein_g, carbs_g, fat_g, fiber_g, water_ml
            FROM fitness.nutrition_daily
            WHERE user_id = ${userId}
              AND date > CURRENT_DATE - ${days}::int
            ORDER BY date ASC`,
      ),
      dbAny.execute<BodyCompRow>(
        sql`SELECT recorded_at, weight_kg, body_fat_pct
            FROM fitness.v_body_measurement
            WHERE user_id = ${userId}
              AND recorded_at > CURRENT_DATE - ${days}::int
            ORDER BY recorded_at ASC`,
      ),
      dbAny.execute<ExerciseMinutesRow>(
        sql`SELECT DATE(started_at) AS date,
                   SUM(EXTRACT(EPOCH FROM (last_sample_at - first_sample_at)) / 60) AS exercise_minutes
            FROM fitness.activity_summary
            WHERE user_id = ${userId}
              AND started_at > CURRENT_DATE - ${days}::int
            GROUP BY DATE(started_at)
            ORDER BY DATE(started_at) ASC`,
      ),
    ]);

  // Build daily context by joining sleep + nutrition + metrics + exercise
  const dailyContext = buildDailyContext(
    dailyMetrics,
    sleepRows,
    nutritionRows,
    bodyCompRows,
    exerciseMinutesRows,
  );

  if (target.activityType === "cardio") {
    const activityRows = await dbAny.execute<ActivitySummaryRow>(
      sql`SELECT
            a.activity_id, a.activity_type, a.started_at,
            a.avg_hr, a.avg_power, a.avg_speed, a.total_distance,
            a.elevation_gain_m, a.avg_cadence,
            EXTRACT(EPOCH FROM (a.last_sample_at - a.first_sample_at)) / 60 AS duration_min
          FROM fitness.activity_summary a
          WHERE a.user_id = ${userId}
            AND a.started_at > CURRENT_DATE - ${days}::int
            AND a.avg_power IS NOT NULL
          ORDER BY a.started_at ASC`,
    );

    const cardioActivities: CardioActivityRow[] = activityRows.map((r) => ({
      date: new Date(r.started_at).toISOString().slice(0, 10),
      activityType: r.activity_type,
      durationMin: r.duration_min ?? 0,
      avgHr: r.avg_hr,
      avgPower: r.avg_power,
      avgSpeed: r.avg_speed,
      totalDistance: r.total_distance,
      elevationGain: r.elevation_gain_m,
      avgCadence: r.avg_cadence,
    }));

    const dataset = buildActivityDataset(cardioActivities, dailyContext, target);
    if (!dataset) return null;
    return trainFromDataset(dataset, target.id, target.label, target.unit);
  }

  if (target.activityType === "strength") {
    const workoutRows = await dbAny.execute<StrengthVolumeRow>(
      sql`SELECT
            w.id AS workout_id, w.started_at,
            SUM(s.weight_kg * s.reps) FILTER (WHERE s.set_type = 'working') AS total_volume,
            COUNT(*) FILTER (WHERE s.set_type = 'working') AS working_set_count,
            MAX(s.weight_kg) FILTER (WHERE s.set_type = 'working') AS max_weight,
            AVG(s.rpe) FILTER (WHERE s.set_type = 'working') AS avg_rpe
          FROM fitness.strength_workout w
          JOIN fitness.strength_set s ON s.workout_id = w.id
          WHERE w.user_id = ${userId}
            AND w.started_at > CURRENT_DATE - ${days}::int
          GROUP BY w.id, w.started_at
          ORDER BY w.started_at ASC`,
    );

    const strengthWorkouts: StrengthWorkoutRow[] = workoutRows
      .filter((r) => r.total_volume != null && r.total_volume > 0)
      .map((r) => ({
        date: new Date(r.started_at).toISOString().slice(0, 10),
        totalVolume: r.total_volume ?? 0,
        workingSetCount: r.working_set_count ?? 0,
        maxWeight: r.max_weight,
        avgRpe: r.avg_rpe,
      }));

    const dataset = buildActivityDataset(strengthWorkouts, dailyContext, target);
    if (!dataset) return null;
    return trainFromDataset(dataset, target.id, target.label, target.unit);
  }

  return null;
}

/** Build daily context from separate data sources */
function buildDailyContext(
  metrics: DailyRow[],
  sleep: SleepRow[],
  nutrition: NutritionRow[],
  bodyComp: BodyCompRow[],
  exerciseMinutes: ExerciseMinutesRow[] = [],
): DailyContext[] {
  // Index by date
  const metricsMap = new Map<string, DailyRow>();
  for (const m of metrics) {
    const d = typeof m.date === "string" ? m.date.slice(0, 10) : m.date.toISOString().slice(0, 10);
    metricsMap.set(d, m);
  }

  const sleepMap = new Map<string, SleepRow>();
  for (const s of sleep) {
    if (s.is_nap) continue;
    // Sleep attributed to the date it ends (wake-up date)
    const d = new Date(s.started_at);
    d.setMinutes(d.getMinutes() + (s.duration_minutes ?? 0));
    const dateStr = d.toISOString().slice(0, 10);
    sleepMap.set(dateStr, s);
  }

  const nutritionMap = new Map<string, NutritionRow>();
  for (const n of nutrition) {
    const d = typeof n.date === "string" ? n.date.slice(0, 10) : n.date.toISOString().slice(0, 10);
    nutritionMap.set(d, n);
  }

  const bodyCompMap = new Map<string, BodyCompRow>();
  for (const b of bodyComp) {
    const d = new Date(b.recorded_at).toISOString().slice(0, 10);
    bodyCompMap.set(d, b);
  }

  const exerciseMap = new Map<string, number>();
  for (const e of exerciseMinutes) {
    const d =
      typeof e.date === "string"
        ? e.date.slice(0, 10)
        : new Date(e.date).toISOString().slice(0, 10);
    if (e.exercise_minutes != null) exerciseMap.set(d, e.exercise_minutes);
  }

  // Get all unique dates
  const allDates = new Set<string>();
  for (const d of metricsMap.keys()) allDates.add(d);
  for (const d of sleepMap.keys()) allDates.add(d);
  for (const d of nutritionMap.keys()) allDates.add(d);
  for (const d of bodyCompMap.keys()) allDates.add(d);

  const sortedDates = [...allDates].sort();

  let lastWeight: number | null = null;
  return sortedDates.map((date) => {
    const m = metricsMap.get(date);
    const s = sleepMap.get(date);
    const n = nutritionMap.get(date);
    const b = bodyCompMap.get(date);
    if (b?.weight_kg != null) lastWeight = b.weight_kg;

    return {
      date,
      hrv: m?.hrv ?? null,
      restingHr: m?.resting_hr ?? null,
      sleepDurationMin: s?.duration_minutes ?? null,
      deepMin: s?.deep_minutes ?? null,
      sleepEfficiency: s?.efficiency_pct ?? null,
      calories: n?.calories ?? null,
      proteinG: n?.protein_g ?? null,
      weightKg: lastWeight,
      exerciseMinutes: exerciseMap.get(date) ?? null,
      steps: m?.steps ?? null,
    };
  });
}
