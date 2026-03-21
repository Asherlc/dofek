import {
  CORRELATION_METRICS,
  correlationColor,
  correlationConfidence,
  generateCorrelationInsight,
  linearRegression,
  pearsonCorrelation,
} from "@dofek/stats/correlation";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  activityRowSchema,
  bodyCompRowSchema,
  dailyRowSchema,
  type JoinedDay,
  joinByDate,
  nutritionRowSchema,
  sleepRowSchema,
} from "../insights/engine.ts";
import { spearmanCorrelation } from "../insights/stats.ts";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

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

// ── Computation ─────────────────────────────────────────────────────────

export interface CorrelationInput {
  metricX: string;
  metricY: string;
  days: number;
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

    const x = extractMetricValue(dayX, metricX);
    const y = extractMetricValue(dayY, metricY);
    if (x == null || y == null) continue;

    pairs.push({ x, y, date: dayX.date });
  }

  const n = pairs.length;

  if (n < 5) {
    return {
      spearmanRho: 0,
      spearmanPValue: 1,
      pearsonR: 0,
      pearsonPValue: 1,
      regression: { slope: 0, intercept: 0, rSquared: 0 },
      dataPoints: pairs,
      sampleCount: n,
      xStats: emptyStats(),
      yStats: emptyStats(),
      insight: `Insufficient data to analyze the relationship between ${METRIC_LABEL_MAP.get(metricX) ?? metricX} and ${METRIC_LABEL_MAP.get(metricY) ?? metricY} (only ${n} overlapping data points).`,
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

  // Confidence
  const confidenceLevel = correlationConfidence(spearman.rho, n);

  // Insight text
  const xLabel = (METRIC_LABEL_MAP.get(metricX) ?? metricX).toLowerCase();
  const yLabel = (METRIC_LABEL_MAP.get(metricY) ?? metricY).toLowerCase();
  const insight = generateCorrelationInsight({
    xLabel,
    yLabel,
    rho: spearman.rho,
    pValue: spearman.pValue,
    n,
    lag,
  });

  return {
    spearmanRho: spearman.rho,
    spearmanPValue: spearman.pValue,
    pearsonR: pearson.r,
    pearsonPValue: pearson.pValue,
    regression,
    dataPoints: downsample(pairs, MAX_DATA_POINTS),
    sampleCount: n,
    xStats,
    yStats,
    insight,
    confidenceLevel,
    correlationColor: correlationColor(spearman.rho),
  };
}

export function computeStats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  const mean = sum / n;
  const min = sorted[0] ?? 0;
  const max = sorted[n - 1] ?? 0;
  const median =
    n % 2 === 0
      ? ((sorted[n / 2 - 1] ?? 0) + (sorted[n / 2] ?? 0)) / 2
      : (sorted[Math.floor(n / 2)] ?? 0);
  const variance = sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / (n > 1 ? n - 1 : 1);
  const stddev = Math.sqrt(variance);
  return { mean, median, stddev, min, max, n };
}

export function emptyStats() {
  return { mean: 0, median: 0, stddev: 0, min: 0, max: 0, n: 0 };
}

// ── tRPC Router ─────────────────────────────────────────────────────────

export const correlationRouter = router({
  metrics: cachedProtectedQuery(CacheTTL.LONG)
    .input(z.object({}).optional())
    .query(() => {
      return CORRELATION_METRICS.map(({ id, label, unit, domain, description }) => ({
        id,
        label,
        unit,
        domain,
        description,
      }));
    }),

  compute: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(
      z.object({
        metricX: z.string(),
        metricY: z.string(),
        days: z.number().default(365),
        lag: z.number().min(0).max(7).default(0),
      }),
    )
    .query(async ({ ctx, input }) => {
      const [metrics, sleep, activities, nutrition, bodyComp] = await Promise.all([
        executeWithSchema(
          ctx.db,
          dailyRowSchema,
          sql`SELECT date, resting_hr, hrv, spo2_avg, steps, active_energy_kcal, skin_temp_c
              FROM fitness.v_daily_metrics
              WHERE user_id = ${ctx.userId}
                AND date > CURRENT_DATE - ${input.days}::int
              ORDER BY date ASC`,
        ),
        executeWithSchema(
          ctx.db,
          sleepRowSchema,
          sql`SELECT started_at, duration_minutes, deep_minutes, rem_minutes,
                     light_minutes, awake_minutes, efficiency_pct, is_nap
              FROM fitness.v_sleep
              WHERE user_id = ${ctx.userId}
                AND started_at > CURRENT_DATE - ${input.days}::int
              ORDER BY started_at ASC`,
        ),
        executeWithSchema(
          ctx.db,
          activityRowSchema,
          sql`SELECT started_at, ended_at, activity_type
              FROM fitness.v_activity
              WHERE user_id = ${ctx.userId}
                AND started_at > CURRENT_DATE - ${input.days}::int
              ORDER BY started_at ASC`,
        ),
        executeWithSchema(
          ctx.db,
          nutritionRowSchema,
          sql`SELECT date, calories, protein_g, carbs_g, fat_g, fiber_g, water_ml
              FROM fitness.nutrition_daily
              WHERE user_id = ${ctx.userId}
                AND date > CURRENT_DATE - ${input.days}::int
              ORDER BY date ASC`,
        ),
        executeWithSchema(
          ctx.db,
          bodyCompRowSchema,
          sql`SELECT recorded_at, weight_kg, body_fat_pct
              FROM fitness.v_body_measurement
              WHERE user_id = ${ctx.userId}
                AND recorded_at > CURRENT_DATE - ${input.days}::int
              ORDER BY recorded_at ASC`,
        ),
      ]);

      const joined = joinByDate(metrics, sleep, activities, nutrition, bodyComp, {
        minDailyCalories: 1200,
      });

      return computeCorrelation(joined, input);
    }),
});
