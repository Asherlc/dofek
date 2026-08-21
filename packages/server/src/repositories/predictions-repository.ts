import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { joinByDate } from "../insights/data-join.ts";
import type { BodyCompRow, DailyRow, NutritionRow, SleepRow } from "../insights/types.ts";
import {
  clickHouseDateRangeLowerBound,
  clickHouseRangeLowerBound,
  rangeDaysParams,
} from "../lib/date-window.ts";
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
import { type ActivitySensorStore, activityRepositoryFor } from "./activity-repository.ts";
import { fetchBodyCompRows } from "./body-clickhouse.ts";
import { fetchSleepNights } from "./clickhouse-sleep-repository.ts";
import { fetchRestingHeartRateValuesCte, localDateString } from "./resting-heart-rate-query.ts";

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
  canonical_type: z.string(),
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

const activitySummaryRowSchema = z.object({
  activity_id: z.string(),
  canonical_type: z.string(),
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
  readonly #timezone: string;
  readonly #sensorStore: ActivitySensorStore;
  constructor(
    db: Pick<Database, "execute">,
    userId: string,
    timezone: string,
    sensorStore: ActivitySensorStore,
  ) {
    this.#db = db;
    this.#userId = userId;
    this.#timezone = timezone;
    this.#sensorStore = sensorStore;
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
    const activityRows = await this.#sensorStore.query(
      activitySummaryRowSchema,
      `SELECT
        toString(activity_summary.activity_id) AS activity_id,
        canonical_type,
        formatDateTime(activity_summary.started_at, '%Y-%m-%dT%H:%i:%SZ', 'UTC') AS started_at,
        avg_hr,
        avg_power,
        avg_speed,
        total_distance,
        elevation_gain_m,
        avg_cadence,
        dateDiff('second', first_sample_at, last_sample_at) / 60 AS duration_min
      FROM analytics.activity_summary AS activity_summary
      WHERE activity_summary.user_id = {userId:UUID}
        ${clickHouseRangeLowerBound(days, "activity_summary.started_at")}
        AND avg_power IS NOT NULL
      ORDER BY activity_summary.started_at ASC`,
      { userId: this.#userId, ...rangeDaysParams(days) },
    );

    const visibleActivityRows = await activityRepositoryFor(
      this.#db,
      this.#userId,
    ).filterToVisibleActivities(activityRows, (row) => row.activity_id);

    const cardioActivities: CardioActivityRow[] = visibleActivityRows.map((row) => ({
      date: new Date(row.started_at).toISOString().slice(0, 10),
      activityType: row.canonical_type,
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
          FROM fitness.v_activity a
          JOIN fitness.strength_set s ON s.activity_id = ANY(a.member_activity_ids)
          WHERE a.user_id = ${this.#userId}
            AND a.canonical_type = 'strength'
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
    const endDate = localDateString(new Date(), this.#timezone);
    const restingHeartRateCte = await fetchRestingHeartRateValuesCte({
      sensorStore: this.#sensorStore,
      userId: this.#userId,
      timezone: this.#timezone,
      endDate,
      days,
    });
    return executeWithSchema(
      this.#db,
      dailyRowSchema,
      sql`WITH ${restingHeartRateCte},
          metric_dates AS (
		            SELECT dm.date
		            FROM fitness.v_daily_metrics dm
		            WHERE dm.user_id = ${this.#userId}
		              AND dm.date > ${endDate}::date - ${days}::int
		              AND dm.date <= ${endDate}::date
		            UNION
	            SELECT drhr.date
	            FROM resting_heart_rate drhr
	          )
          SELECT
            dates.date,
            drhr.resting_hr,
            dm.hrv,
            dm.spo2_avg,
            dm.steps,
            dm.skin_temp_c
          FROM metric_dates dates
          LEFT JOIN fitness.v_daily_metrics dm
            ON dm.user_id = ${this.#userId}
           AND dm.date = dates.date
	          LEFT JOIN resting_heart_rate drhr
	            ON drhr.date = dates.date
          ORDER BY dates.date ASC`,
    );
  }

  async #fetchSleep(days: number): Promise<SleepRow[]> {
    const endDate = localDateString(new Date(), this.#timezone);
    const rows = await fetchSleepNights({
      sensorStore: this.#sensorStore,
      userId: this.#userId,
      timezone: this.#timezone,
      endDate,
      days,
      order: "asc",
    });
    return rows.map((row) =>
      sleepRowSchema.parse({
        started_at: row.started_at,
        duration_minutes: row.duration_minutes,
        deep_minutes: row.deep_minutes,
        rem_minutes: row.rem_minutes,
        light_minutes: row.light_minutes,
        awake_minutes: row.awake_minutes,
        efficiency_pct: row.efficiency_pct,
        is_nap: false,
      }),
    );
  }

  async #fetchActivities(days: number) {
    return executeWithSchema(
      this.#db,
      activityRowSchema,
      sql`SELECT started_at, ended_at, canonical_type
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
          FROM fitness.v_nutrition_daily
          WHERE user_id = ${this.#userId}
            AND resolution_status = 'available'
            AND date > CURRENT_DATE - ${days}::int
          ORDER BY date ASC`,
    );
  }

  async #fetchBodyComp(days: number): Promise<BodyCompRow[]> {
    return fetchBodyCompRows(this.#sensorStore, this.#userId, this.#timezone, "now", days);
  }

  async #fetchExerciseMinutes(days: number): Promise<ExerciseMinutesRow[]> {
    return this.#sensorStore.query(
      exerciseMinutesRowSchema,
      `SELECT
        toString(toDate(asum.started_at)) AS date,
        sum(dateDiff('second', asum.first_sample_at, asum.last_sample_at) / 60) AS exercise_minutes
      FROM analytics.activity_summary asum
      INNER JOIN analytics.v_activity va
        ON va.id = asum.activity_id
       AND va.user_id = asum.user_id
      WHERE asum.user_id = {userId:UUID}
        ${clickHouseDateRangeLowerBound(days, "asum.started_at")}
      GROUP BY toDate(asum.started_at)
      ORDER BY toDate(asum.started_at) ASC`,
      { userId: this.#userId, ...rangeDaysParams(days) },
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
