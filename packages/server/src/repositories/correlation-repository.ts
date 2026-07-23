import {
  CORRELATION_METRICS,
  CorrelationResult,
  linearRegression,
  pearsonCorrelation,
} from "@dofek/stats/correlation";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import type { JoinedDay } from "../insights/data-join.ts";
import { joinByDate } from "../insights/data-join.ts";
import {
  activityRowSchema,
  dailyRowSchema,
  nutritionRowSchema,
  sleepRowSchema,
} from "../insights/schemas.ts";
import { spearmanCorrelation } from "../insights/stats.ts";
import {
  dateWindowStartPredicate,
  type RangeDays,
  timestampWindowStartPredicate,
} from "../lib/date-window.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";
import { fetchBodyCompRows } from "./body-clickhouse.ts";
import { fetchSleepNights } from "./clickhouse-sleep-repository.ts";
import { fetchRestingHeartRateValuesCte } from "./resting-heart-rate-query.ts";

// ── Metric extraction ───────────────────────────────────────────────────

type JoinedDayExtractor = (day: JoinedDay) => number | null;

/** Type-safe extractors keyed by JoinedDay property name. */
const JOINED_DAY_EXTRACTORS: Record<string, JoinedDayExtractor> = {
  resting_hr: (d) => d.resting_hr,
  hrv: (d) => d.hrv,
  spo2_avg: (d) => d.spo2_avg,
  skin_temp_c: (d) => d.skin_temp_c,
  sleep_duration_min: (d) => d.sleep_duration_min,
  deep_min: (d) => d.deep_min,
  rem_min: (d) => d.rem_min,
  sleep_efficiency: (d) => d.sleep_efficiency,
  calories: (d) => d.calories,
  protein_g: (d) => d.protein_g,
  carbs_g: (d) => d.carbs_g,
  fat_g: (d) => d.fat_g,
  fiber_g: (d) => d.fiber_g,
  steps: (d) => d.steps,
  active_energy_kcal: (d) => d.active_energy_kcal,
  exercise_minutes: (d) => d.exercise_minutes,
  cardio_minutes: (d) => d.cardio_minutes,
  strength_minutes: (d) => d.strength_minutes,
  weight_kg: (d) => d.weight_kg,
  body_fat_pct: (d) => d.body_fat_pct,
  weight_30d_avg: (d) => d.weight_30d_avg,
};

const METRIC_EXTRACTORS = new Map<string, JoinedDayExtractor>(
  CORRELATION_METRICS.map((m) => [m.id, JOINED_DAY_EXTRACTORS[m.joinedDayKey] ?? (() => null)]),
);

const METRIC_LABEL_MAP = new Map(CORRELATION_METRICS.map((m) => [m.id, m.label]));

export function extractMetricValue(day: JoinedDay, metricId: string): number | null {
  const extractor = METRIC_EXTRACTORS.get(metricId);
  if (!extractor) return null;
  return extractor(day);
}

// ── Computation helpers ─────────────────────────────────────────────────

export interface CorrelationInput {
  metricX: string;
  metricY: string;
  days: RangeDays;
  lag: number;
}

const MAX_DATA_POINTS = 300;

export function downsample<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr;
  const step = arr.length / max;
  const result: T[] = [];
  for (let i = 0; i < max; i++) {
    const item = arr[Math.floor(i * step)];
    if (item !== undefined) result.push(item);
  }
  return result;
}

export function computeCorrelation(joined: JoinedDay[], input: CorrelationInput) {
  const { metricX, metricY, lag } = input;

  // Extract paired values, applying lag
  const pairs: Array<{ x: number; y: number; date: string }> = [];

  for (let i = 0; i < joined.length; i++) {
    const dayX = joined[i];
    const dayY = joined[i + lag];
    if (!dayX || !dayY) continue;

    const metricXValue = extractMetricValue(dayX, metricX);
    const metricYValue = extractMetricValue(dayY, metricY);
    if (metricXValue == null || metricYValue == null) continue;

    pairs.push({ x: metricXValue, y: metricYValue, date: dayX.date });
  }

  const pairCount = pairs.length;

  if (pairCount < 5) {
    const additionalSamplesRequired = 5 - pairCount;
    return {
      availability: "insufficient" as const,
      dataPoints: pairs,
      sampleCount: pairCount,
      additionalSamplesRequired,
      insight: `Insufficient data to analyze the relationship between ${METRIC_LABEL_MAP.get(metricX) ?? metricX} and ${METRIC_LABEL_MAP.get(metricY) ?? metricY} (only ${pairCount} overlapping data ${pairCount === 1 ? "point" : "points"}; ${additionalSamplesRequired} more ${additionalSamplesRequired === 1 ? "sample is" : "samples are"} required).`,
      confidenceLevel: "insufficient" as const,
      correlationColor: "#71717a",
    };
  }

  const xs = pairs.map((p) => p.x);
  const ys = pairs.map((p) => p.y);

  // Spearman
  const spearman = spearmanCorrelation(xs, ys);

  // Pearson
  const pearson = pearsonCorrelation(xs, ys);

  // Linear regression
  const regression = linearRegression(xs, ys);

  // Stats
  const xStats = computeStats(xs);
  const yStats = computeStats(ys);

  // Wrap Spearman result in CorrelationResult for derived properties
  const spearmanResult = new CorrelationResult(spearman.rho, spearman.pValue, pairCount);

  // Insight text
  const xLabel = (METRIC_LABEL_MAP.get(metricX) ?? metricX).toLowerCase();
  const yLabel = (METRIC_LABEL_MAP.get(metricY) ?? metricY).toLowerCase();
  const insight = spearmanResult.generateInsight({ xLabel, yLabel, lag });

  return {
    availability: "available" as const,
    spearmanRho: spearman.rho,
    spearmanPValue: spearman.pValue,
    pearsonR: pearson.r,
    pearsonPValue: pearson.pValue,
    regression,
    dataPoints: downsample(pairs, MAX_DATA_POINTS),
    sampleCount: pairCount,
    xStats,
    yStats,
    insight,
    confidenceLevel: spearmanResult.confidence,
    correlationColor: spearmanResult.color,
  };
}

export function computeStats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const valueCount = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / valueCount;
  const min = sorted[0] ?? 0;
  const max = sorted[valueCount - 1] ?? 0;
  const median =
    valueCount % 2 === 0
      ? ((sorted[valueCount / 2 - 1] ?? 0) + (sorted[valueCount / 2] ?? 0)) / 2
      : (sorted[Math.floor(valueCount / 2)] ?? 0);
  const variance =
    sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / (valueCount > 1 ? valueCount - 1 : 1);
  const stddev = Math.sqrt(variance);
  return { mean, median, stddev, min, max, n: valueCount };
}

export function emptyStats() {
  return { mean: 0, median: 0, stddev: 0, min: 0, max: 0, n: 0 };
}

// ── Repository ──────────────────────────────────────────────────────────

export class CorrelationRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;
  readonly #timezone: string;
  readonly #sensorStore?: Pick<ActivitySensorStore, "query">;

  constructor(
    db: Pick<Database, "execute">,
    userId: string,
    timezone = "UTC",
    sensorStore?: Pick<ActivitySensorStore, "query">,
  ) {
    this.#db = db;
    this.#userId = userId;
    this.#timezone = timezone;
    this.#sensorStore = sensorStore;
  }

  getMetrics() {
    return CORRELATION_METRICS.map(({ id, label, unit, domain, description }) => ({
      id,
      label,
      unit,
      domain,
      description,
    }));
  }

  async compute(metricX: string, metricY: string, days: RangeDays, lag: number, endDate: string) {
    const effectiveEndDate = endDate || new Date().toISOString().slice(0, 10);
    const sensorStore = this.#requireSensorStore();
    const restingHeartRateCte = await fetchRestingHeartRateValuesCte({
      sensorStore,
      userId: this.#userId,
      timezone: this.#timezone,
      endDate: effectiveEndDate,
      days,
    });
    const [metrics, sleep, activities, nutrition, bodyComp] = await Promise.all([
      executeWithSchema(
        this.#db,
        dailyRowSchema,
        sql`WITH ${restingHeartRateCte}
            SELECT dm.date, drhr.resting_hr, dm.hrv, dm.spo2_avg, dm.steps, dm.active_energy_kcal, dm.skin_temp_c
	            FROM fitness.v_daily_metrics dm
	            LEFT JOIN resting_heart_rate drhr
	              ON drhr.date = dm.date
            WHERE dm.user_id = ${this.#userId}
              ${dateWindowStartPredicate(sql`dm.date`, effectiveEndDate, days)}
              AND dm.date <= ${effectiveEndDate}::date
            ORDER BY dm.date ASC`,
      ),
      fetchSleepNights({
        sensorStore,
        userId: this.#userId,
        timezone: this.#timezone,
        endDate: effectiveEndDate,
        days,
        order: "asc",
      }).then((rows) =>
        rows.map((row) =>
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
        ),
      ),
      executeWithSchema(
        this.#db,
        activityRowSchema,
        sql`SELECT started_at, ended_at, activity_type
            FROM fitness.v_activity
            WHERE user_id = ${this.#userId}
              ${timestampWindowStartPredicate(sql`started_at`, effectiveEndDate, days)}
            ORDER BY started_at ASC`,
      ),
      executeWithSchema(
        this.#db,
        nutritionRowSchema,
        sql`SELECT date, calories, protein_g, carbs_g, fat_g, fiber_g, water_ml
            FROM fitness.v_nutrition_daily
            WHERE user_id = ${this.#userId}
              ${dateWindowStartPredicate(sql`date`, effectiveEndDate, days)}
              AND date <= ${effectiveEndDate}::date
            ORDER BY date ASC`,
      ),
      fetchBodyCompRows(this.#requireSensorStore(), this.#userId, effectiveEndDate, days),
    ]);

    const joined = joinByDate(metrics, sleep, activities, nutrition, bodyComp, {
      minDailyCalories: 1200,
    });

    return computeCorrelation(joined, { metricX, metricY, days, lag });
  }

  #requireSensorStore(): Pick<ActivitySensorStore, "query"> {
    if (!this.#sensorStore) {
      throw new Error("ClickHouse activity analytics store is required for correlations");
    }
    return this.#sensorStore;
  }
}
