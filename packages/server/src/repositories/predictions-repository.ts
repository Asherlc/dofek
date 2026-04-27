import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { joinByDate } from "../insights/data-join.ts";
import type { BodyCompRow, DailyRow, NutritionRow, SleepRow } from "../insights/types.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import {
  ACTIVITY_PREDICTION_TARGETS,
  type ActivityPredictionTarget,
  buildActivityDataset,
  type CardioActivityRow,
  type DailyContext,
  type StrengthWorkoutRow,
} from "../ml/activity-features.ts";
import type { PredictionTarget } from "../ml/features.ts";
import { getPredictionTarget, PREDICTION_TARGETS } from "../ml/features.ts";
import type { PredictionResult } from "../ml/predictor.ts";
import { trainFromDataset, trainPredictor } from "../ml/predictor.ts";

// ---------------------------------------------------------------------------
// Domain models
// ---------------------------------------------------------------------------

export interface PredictionTargetInfo {
  id: string;
  label: string;
  unit: string;
  type: "daily" | "activity";
}

/** A prediction target descriptor (daily or activity-level). */
export class PredictionTargetEntry {
  readonly #row: PredictionTargetInfo;

  constructor(row: PredictionTargetInfo) {
    this.#row = row;
  }

  get id(): string {
    return this.#row.id;
  }

  get label(): string {
    return this.#row.label;
  }

  get unit(): string {
    return this.#row.unit;
  }

  get type(): "daily" | "activity" {
    return this.#row.type;
  }

  toDetail(): PredictionTargetInfo {
    return {
      id: this.#row.id,
      label: this.#row.label,
      unit: this.#row.unit,
      type: this.#row.type,
    };
  }
}

// ---------------------------------------------------------------------------
// Zod schemas for SQL row validation
// ---------------------------------------------------------------------------

const coerceNum = z.coerce.number().nullable();

const dailyRowSchema = z.object({
  date: z.union([z.string(), z.coerce.date()]),
  resting_hr: coerceNum,
  hrv: coerceNum,
  spo2_avg: coerceNum,
  steps: coerceNum,
  active_energy_kcal: coerceNum,
  skin_temp_c: coerceNum,
});

const sleepRowSchema = z.object({
  started_at: z.string(),
  duration_minutes: coerceNum,
  deep_minutes: coerceNum,
  rem_minutes: coerceNum,
  light_minutes: coerceNum,
  awake_minutes: coerceNum,
  efficiency_pct: coerceNum,
  is_nap: z.boolean(),
});

const activityRowSchema = z.object({
  started_at: z.string(),
  ended_at: z.string().nullable(),
  activity_type: z.string(),
});

const nutritionRowSchema = z.object({
  date: z.union([z.string(), z.coerce.date()]),
  calories: coerceNum,
  protein_g: coerceNum,
  carbs_g: coerceNum,
  fat_g: coerceNum,
  fiber_g: coerceNum,
  water_ml: coerceNum,
});

const bodyCompRowSchema = z.object({
  recorded_at: z.string(),
  weight_kg: coerceNum,
  body_fat_pct: coerceNum,
});

const activitySummaryRowSchema = z.object({
  activity_id: z.string(),
  activity_type: z.string(),
  started_at: z.string(),
  avg_hr: coerceNum,
  avg_power: coerceNum,
  avg_speed: coerceNum,
  total_distance: coerceNum,
  elevation_gain_m: coerceNum,
  avg_cadence: coerceNum,
  duration_min: coerceNum,
});

const exerciseMinutesRowSchema = z.object({
  date: z.union([z.string(), z.coerce.date()]),
  exercise_minutes: coerceNum,
});

const strengthVolumeRowSchema = z.object({
  workout_id: z.string(),
  started_at: z.string(),
  total_volume: coerceNum,
  working_set_count: coerceNum,
  max_weight: coerceNum,
  avg_rpe: coerceNum,
});

/** SQL row for per-day exercise minutes (aggregated from activity_summary) */
type ExerciseMinutesRow = z.infer<typeof exerciseMinutesRowSchema>;

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Data access and prediction logic for ML-based health forecasting. */
export class PredictionsRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;
  constructor(db: Pick<Database, "execute">, userId: string, _timezone: string) {
    this.#db = db;
    this.#userId = userId;
  }

  /** All available prediction targets (daily + activity-level). */
  getTargets(): PredictionTargetEntry[] {
    return [
      ...PREDICTION_TARGETS.map(
        (target) =>
          new PredictionTargetEntry({
            id: target.id,
            label: target.label,
            unit: target.unit,
            type: "daily",
          }),
      ),
      ...ACTIVITY_PREDICTION_TARGETS.map(
        (target) =>
          new PredictionTargetEntry({
            id: target.id,
            label: target.label,
            unit: target.unit,
            type: "activity",
          }),
      ),
    ];
  }

  /**
   * Train models for the given target. Handles both daily targets
   * (HRV, resting HR, sleep, weight) and activity-level targets
   * (cardio power, strength volume).
   */
  async predict(targetId: string, days: number): Promise<PredictionResult | null> {
    const dailyTarget = getPredictionTarget(targetId);
    if (dailyTarget) {
      return this.#trainDailyPrediction(days, dailyTarget);
    }

    const activityTarget = ACTIVITY_PREDICTION_TARGETS.find((target) => target.id === targetId);
    if (activityTarget) {
      return this.#trainActivityPrediction(days, activityTarget);
    }

    return null;
  }

  // ── Private: daily pipeline ───────────────────────────────────────────

  async #trainDailyPrediction(
    days: number,
    target: PredictionTarget,
  ): Promise<PredictionResult | null> {
    const [metrics, sleep, activities, nutrition, bodyComp] = await Promise.all([
      this.#fetchDailyMetrics(days),
      this.#fetchSleep(days),
      this.#fetchActivities(days),
      this.#fetchNutrition(days),
      this.#fetchBodyComp(days),
    ]);

    const joined = joinByDate(metrics, sleep, activities, nutrition, bodyComp, {
      minDailyCalories: 1200,
    });

    return trainPredictor(joined, target);
  }

  // ── Private: activity pipeline ────────────────────────────────────────

  async #trainActivityPrediction(
    days: number,
    target: ActivityPredictionTarget,
  ): Promise<PredictionResult | null> {
    const [dailyMetrics, sleepRows, nutritionRows, bodyCompRows, exerciseMinutesRows] =
      await Promise.all([
        this.#fetchDailyMetrics(days),
        this.#fetchSleep(days),
        this.#fetchNutrition(days),
        this.#fetchBodyComp(days),
        this.#fetchExerciseMinutes(days),
      ]);

    const dailyContext = buildDailyContext(
      dailyMetrics,
      sleepRows,
      nutritionRows,
      bodyCompRows,
      exerciseMinutesRows,
    );

    if (target.activityType === "cardio") {
      return this.#trainCardioPrediction(days, target, dailyContext);
    }

    if (target.activityType === "strength") {
      return this.#trainStrengthPrediction(days, target, dailyContext);
    }

    return null;
  }

  async #trainCardioPrediction(
    days: number,
    target: ActivityPredictionTarget,
    dailyContext: DailyContext[],
  ): Promise<PredictionResult | null> {
    const activityRows = await executeWithSchema(
      this.#db,
      activitySummaryRowSchema,
      sql`SELECT
            a.activity_id, a.activity_type, a.started_at,
            a.avg_hr, a.avg_power, a.avg_speed, a.total_distance,
            a.elevation_gain_m, a.avg_cadence,
            EXTRACT(EPOCH FROM (a.last_sample_at - a.first_sample_at)) / 60 AS duration_min
          FROM fitness.activity_summary a
          WHERE a.user_id = ${this.#userId}
            AND a.started_at > CURRENT_DATE - ${days}::int
            AND a.avg_power IS NOT NULL
          ORDER BY a.started_at ASC`,
    );

    const cardioActivities: CardioActivityRow[] = activityRows.map((row) => ({
      date: new Date(row.started_at).toISOString().slice(0, 10),
      activityType: row.activity_type,
      durationMin: row.duration_min ?? 0,
      avgHr: row.avg_hr,
      avgPower: row.avg_power,
      avgSpeed: row.avg_speed,
      totalDistance: row.total_distance,
      elevationGain: row.elevation_gain_m,
      avgCadence: row.avg_cadence,
    }));

    const dataset = buildActivityDataset(cardioActivities, dailyContext, target);
    if (!dataset) return null;
    return trainFromDataset(dataset, target.id, target.label, target.unit);
  }

  async #trainStrengthPrediction(
    days: number,
    target: ActivityPredictionTarget,
    dailyContext: DailyContext[],
  ): Promise<PredictionResult | null> {
    const workoutRows = await executeWithSchema(
      this.#db,
      strengthVolumeRowSchema,
      sql`SELECT
            a.id AS workout_id, a.started_at,
            SUM(s.weight_kg * s.reps) FILTER (WHERE s.set_type = 'working') AS total_volume,
            COUNT(*) FILTER (WHERE s.set_type = 'working') AS working_set_count,
            MAX(s.weight_kg) FILTER (WHERE s.set_type = 'working') AS max_weight,
            AVG(s.rpe) FILTER (WHERE s.set_type = 'working') AS avg_rpe
          FROM fitness.activity a
          JOIN fitness.strength_set s ON s.activity_id = a.id
          WHERE a.user_id = ${this.#userId}
            AND a.activity_type = 'strength'
            AND a.started_at > CURRENT_DATE - ${days}::int
          GROUP BY a.id, a.started_at
          ORDER BY a.started_at ASC`,
    );

    const strengthWorkouts: StrengthWorkoutRow[] = workoutRows
      .filter((row) => row.total_volume != null && row.total_volume > 0)
      .map((row) => ({
        date: new Date(row.started_at).toISOString().slice(0, 10),
        totalVolume: row.total_volume ?? 0,
        workingSetCount: row.working_set_count ?? 0,
        maxWeight: row.max_weight,
        avgRpe: row.avg_rpe,
      }));

    const dataset = buildActivityDataset(strengthWorkouts, dailyContext, target);
    if (!dataset) return null;
    return trainFromDataset(dataset, target.id, target.label, target.unit);
  }

  // ── Private: shared data fetchers ─────────────────────────────────────

  async #fetchDailyMetrics(days: number): Promise<DailyRow[]> {
    return executeWithSchema(
      this.#db,
      dailyRowSchema,
      sql`SELECT date, resting_hr, hrv, spo2_avg, steps, active_energy_kcal, skin_temp_c
          FROM fitness.v_daily_metrics
          WHERE user_id = ${this.#userId}
            AND date > CURRENT_DATE - ${days}::int
          ORDER BY date ASC`,
    );
  }

  async #fetchSleep(days: number): Promise<SleepRow[]> {
    return executeWithSchema(
      this.#db,
      sleepRowSchema,
      sql`SELECT started_at, duration_minutes, deep_minutes, rem_minutes,
                 light_minutes, awake_minutes, efficiency_pct, is_nap
          FROM fitness.v_sleep
          WHERE user_id = ${this.#userId}
            AND started_at > CURRENT_DATE - ${days}::int
          ORDER BY started_at ASC`,
    );
  }

  async #fetchActivities(days: number) {
    return executeWithSchema(
      this.#db,
      activityRowSchema,
      sql`SELECT started_at, ended_at, activity_type
          FROM fitness.v_activity
          WHERE user_id = ${this.#userId}
            AND started_at > CURRENT_DATE - ${days}::int
          ORDER BY started_at ASC`,
    );
  }

  async #fetchNutrition(days: number): Promise<NutritionRow[]> {
    return executeWithSchema(
      this.#db,
      nutritionRowSchema,
      sql`SELECT date, calories, protein_g, carbs_g, fat_g, fiber_g, water_ml
          FROM fitness.nutrition_daily
          WHERE user_id = ${this.#userId}
            AND date > CURRENT_DATE - ${days}::int
          ORDER BY date ASC`,
    );
  }

  async #fetchBodyComp(days: number): Promise<BodyCompRow[]> {
    return executeWithSchema(
      this.#db,
      bodyCompRowSchema,
      sql`SELECT recorded_at, weight_kg, body_fat_pct
          FROM fitness.v_body_measurement
          WHERE user_id = ${this.#userId}
            AND recorded_at > CURRENT_DATE - ${days}::int
          ORDER BY recorded_at ASC`,
    );
  }

  async #fetchExerciseMinutes(days: number): Promise<ExerciseMinutesRow[]> {
    return executeWithSchema(
      this.#db,
      exerciseMinutesRowSchema,
      sql`SELECT DATE(started_at) AS date,
                 SUM(EXTRACT(EPOCH FROM (last_sample_at - first_sample_at)) / 60) AS exercise_minutes
          FROM fitness.activity_summary
          WHERE user_id = ${this.#userId}
            AND started_at > CURRENT_DATE - ${days}::int
          GROUP BY DATE(started_at)
          ORDER BY DATE(started_at) ASC`,
    );
  }
}

// ---------------------------------------------------------------------------
// Domain logic: build daily context from separate data sources
// ---------------------------------------------------------------------------

/** Build daily context from separate data sources for activity-level predictions. */
export function buildDailyContext(
  metrics: DailyRow[],
  sleep: SleepRow[],
  nutrition: NutritionRow[],
  bodyComp: BodyCompRow[],
  exerciseMinutes: ExerciseMinutesRow[] = [],
): DailyContext[] {
  const metricsMap = new Map<string, DailyRow>();
  for (const metric of metrics) {
    const dateKey =
      typeof metric.date === "string"
        ? metric.date.slice(0, 10)
        : metric.date.toISOString().slice(0, 10);
    metricsMap.set(dateKey, metric);
  }

  const sleepMap = new Map<string, SleepRow>();
  for (const sleepRow of sleep) {
    if (sleepRow.is_nap) continue;
    const wakeDate = new Date(sleepRow.started_at);
    wakeDate.setMinutes(wakeDate.getMinutes() + (sleepRow.duration_minutes ?? 0));
    const dateStr = wakeDate.toISOString().slice(0, 10);
    sleepMap.set(dateStr, sleepRow);
  }

  const nutritionMap = new Map<string, NutritionRow>();
  for (const nutritionRow of nutrition) {
    const dateKey =
      typeof nutritionRow.date === "string"
        ? nutritionRow.date.slice(0, 10)
        : nutritionRow.date.toISOString().slice(0, 10);
    nutritionMap.set(dateKey, nutritionRow);
  }

  const bodyCompMap = new Map<string, BodyCompRow>();
  for (const bodyCompRow of bodyComp) {
    const dateKey = new Date(bodyCompRow.recorded_at).toISOString().slice(0, 10);
    bodyCompMap.set(dateKey, bodyCompRow);
  }

  const exerciseMap = new Map<string, number>();
  for (const exerciseRow of exerciseMinutes) {
    const dateKey =
      typeof exerciseRow.date === "string"
        ? exerciseRow.date.slice(0, 10)
        : new Date(exerciseRow.date).toISOString().slice(0, 10);
    if (exerciseRow.exercise_minutes != null)
      exerciseMap.set(dateKey, exerciseRow.exercise_minutes);
  }

  const allDates = new Set<string>();
  for (const date of metricsMap.keys()) allDates.add(date);
  for (const date of sleepMap.keys()) allDates.add(date);
  for (const date of nutritionMap.keys()) allDates.add(date);
  for (const date of bodyCompMap.keys()) allDates.add(date);

  const sortedDates = [...allDates].sort();

  let lastWeight: number | null = null;
  return sortedDates.map((date) => {
    const metricsRow = metricsMap.get(date);
    const sleepRow = sleepMap.get(date);
    const nutritionRow = nutritionMap.get(date);
    const bodyCompRow = bodyCompMap.get(date);
    if (bodyCompRow?.weight_kg != null) lastWeight = bodyCompRow.weight_kg;

    return {
      date,
      hrv: metricsRow?.hrv ?? null,
      restingHr: metricsRow?.resting_hr ?? null,
      sleepDurationMin: sleepRow?.duration_minutes ?? null,
      deepMin: sleepRow?.deep_minutes ?? null,
      sleepEfficiency: sleepRow?.efficiency_pct ?? null,
      calories: nutritionRow?.calories ?? null,
      proteinG: nutritionRow?.protein_g ?? null,
      weightKg: lastWeight,
      exerciseMinutes: exerciseMap.get(date) ?? null,
      steps: metricsRow?.steps ?? null,
    };
  });
}
