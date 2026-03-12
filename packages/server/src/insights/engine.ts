import {
  benjaminiHochberg,
  type CorrelationResult,
  cohensD,
  type DescriptiveStats,
  describe,
  spearmanCorrelation,
  welchTTest,
} from "./stats.ts";

// ── Configuration ─────────────────────────────────────────────────────────

export interface InsightsConfig {
  /** Minimum daily calories to consider a nutrition day "complete". Days below this are excluded. */
  minDailyCalories: number;
}

const DEFAULT_CONFIG: InsightsConfig = {
  minDailyCalories: 1200,
};

// ── Types ─────────────────────────────────────────────────────────────────

export interface DailyRow {
  [key: string]: string | number | Date | boolean | null | undefined;
  date: string | Date;
  resting_hr: number | null;
  hrv: number | null;
  spo2_avg: number | null;
  steps: number | null;
  active_energy_kcal: number | null;
  skin_temp_c: number | null;
}

export interface SleepRow {
  [key: string]: string | number | Date | boolean | null | undefined;
  started_at: string;
  duration_minutes: number | null;
  deep_minutes: number | null;
  rem_minutes: number | null;
  light_minutes: number | null;
  awake_minutes: number | null;
  efficiency_pct: number | null;
  is_nap: boolean;
}

export interface ActivityRow {
  [key: string]: string | number | Date | boolean | null | undefined;
  started_at: string;
  ended_at: string | null;
  activity_type: string;
}

export interface NutritionRow {
  [key: string]: string | number | Date | boolean | null | undefined;
  date: string | Date;
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
  water_ml: number | null;
}

export interface BodyCompRow {
  [key: string]: string | number | Date | boolean | null | undefined;
  recorded_at: string;
  weight_kg: number | null;
  body_fat_pct: number | null;
}

export type ConfidenceLevel = "strong" | "emerging" | "early" | "insufficient";

export interface Insight {
  id: string;
  type: "conditional" | "correlation" | "discovery";
  confidence: ConfidenceLevel;
  metric: string;
  action: string;
  message: string;
  detail: string;
  whenTrue: DescriptiveStats;
  whenFalse: DescriptiveStats;
  effectSize: number;
  pValue: number;
  correlation?: CorrelationResult;
  explanation?: string;
  confounders?: string[];

  /** Raw data points for scatter plot visualization (correlation/discovery types) */
  dataPoints?: Array<{ x: number; y: number; date: string }>;

  /** Distribution data for conditional comparisons */
  distributions?: {
    withAction: number[];
    withoutAction: number[];
  };
}

// ── Confidence classification ─────────────────────────────────────────────

/** Classify confidence for conditional tests (Cohen's d effect size) */
function classifyConfidence(d: number, minN: number, pValue?: number): ConfidenceLevel {
  const absD = Math.abs(d);
  // Require statistical significance (p < 0.05) for "strong"
  if (absD >= 0.8 && minN >= 30 && (pValue == null || pValue < 0.05)) return "strong";
  if (absD >= 0.5 && minN >= 15) return "emerging";
  if (absD >= 0.3 && minN >= 10) return "early";
  return "insufficient";
}

/** Window size for monthly-scoped rolling analyses */
const MONTHLY_WINDOW_SIZE = 30;

/** Classify confidence for correlation-based insights (Spearman rho) */
function classifyCorrelationConfidence(rho: number, n: number): ConfidenceLevel {
  const absRho = Math.abs(rho);
  if (absRho >= 0.5 && n >= 30) return "strong";
  if (absRho >= 0.35 && n >= 15) return "emerging";
  if (absRho >= 0.2 && n >= 10) return "early";
  return "insufficient";
}

const MAX_DATA_POINTS = 200;

/** Evenly downsample an array to at most `max` elements */
function downsample<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr;
  const step = arr.length / max;
  const result: T[] = [];
  for (let i = 0; i < max; i++) {
    const item = arr[Math.floor(i * step)];
    if (item !== undefined) result.push(item);
  }
  return result;
}

// ── Date normalization helper ─────────────────────────────────────────────

function toDateStr(d: string | Date): string {
  return d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
}

// ── Join data by date ─────────────────────────────────────────────────────

interface JoinedDay {
  date: string;
  // metrics
  resting_hr: number | null;
  hrv: number | null;
  spo2_avg: number | null;
  steps: number | null;
  active_energy_kcal: number | null;
  skin_temp_c: number | null;
  // sleep (night before → this date)
  sleep_duration_min: number | null;
  deep_min: number | null;
  rem_min: number | null;
  sleep_efficiency: number | null;
  // activity on this date
  exercise_minutes: number | null;
  cardio_minutes: number | null;
  strength_minutes: number | null;
  flexibility_minutes: number | null;
  // nutrition
  calories: number | null;
  protein_g: number | null;
  carbs_g: number | null;
  fat_g: number | null;
  fiber_g: number | null;
  // body comp (daily, pick closest measurement)
  weight_kg: number | null;
  body_fat_pct: number | null;
  // rolling body comp (30-day trailing)
  weight_30d_avg: number | null;
  body_fat_30d_avg: number | null;
  weight_30d_delta: number | null;
  body_fat_30d_delta: number | null;
}

function classifyActivity(type: string): "cardio" | "strength" | "flexibility" | "other" {
  const t = type.toLowerCase();
  if (
    [
      "cycling",
      "walking",
      "hiking",
      "running",
      "swimming",
      "cross_country_skiing",
      "downhill_skiing",
      "cardio",
      "cross_training",
      "tennis",
      "climbing",
    ].includes(t)
  )
    return "cardio";
  if (["strength_training", "functional_strength", "strength"].includes(t)) return "strength";
  if (["yoga", "stretching", "preparation_and_recovery"].includes(t)) return "flexibility";
  return "other";
}

function joinByDate(
  metrics: DailyRow[],
  sleep: SleepRow[],
  activities: ActivityRow[],
  nutrition: NutritionRow[],
  bodyComp: BodyCompRow[],
  config: InsightsConfig,
): JoinedDay[] {
  const metricsByDate = new Map(metrics.map((m) => [toDateStr(m.date), m]));

  // Sleep: assign to the date the person woke up
  const sleepByWakeDate = new Map<string, SleepRow>();
  for (const s of sleep) {
    if (s.is_nap) continue;
    const wakeDate = new Date(s.started_at);
    if (s.duration_minutes) {
      wakeDate.setMinutes(wakeDate.getMinutes() + s.duration_minutes);
    }
    const dateStr = wakeDate.toISOString().slice(0, 10);
    const existing = sleepByWakeDate.get(dateStr);
    if (!existing || (s.duration_minutes ?? 0) > (existing.duration_minutes ?? 0)) {
      sleepByWakeDate.set(dateStr, s);
    }
  }

  // Activities: sum duration per date, broken down by category
  const activityByDate = new Map<
    string,
    { minutes: number; cardio: number; strength: number; flexibility: number }
  >();
  for (const a of activities) {
    const dateStr = new Date(a.started_at).toISOString().slice(0, 10);
    const existing = activityByDate.get(dateStr) ?? {
      minutes: 0,
      cardio: 0,
      strength: 0,
      flexibility: 0,
    };
    if (a.ended_at) {
      const dur = (new Date(a.ended_at).getTime() - new Date(a.started_at).getTime()) / 60000;
      existing.minutes += dur;
      const cat = classifyActivity(a.activity_type);
      if (cat === "cardio") existing.cardio += dur;
      else if (cat === "strength") existing.strength += dur;
      else if (cat === "flexibility") existing.flexibility += dur;
    }
    activityByDate.set(dateStr, existing);
  }

  // Nutrition by date — filter out incomplete tracking days
  const completeNutrition = nutrition.filter((n) => (n.calories ?? 0) >= config.minDailyCalories);
  const nutritionByDate = new Map(completeNutrition.map((n) => [toDateStr(n.date), n]));

  // Body comp: one measurement per date (latest if multiple)
  const bodyCompByDate = new Map<string, BodyCompRow>();
  for (const b of bodyComp) {
    const dateStr = new Date(b.recorded_at).toISOString().slice(0, 10);
    bodyCompByDate.set(dateStr, b); // last wins (data sorted ASC)
  }

  const joined: JoinedDay[] = [];
  for (const [date, m] of metricsByDate) {
    const s = sleepByWakeDate.get(date);
    const a = activityByDate.get(date);
    const n = nutritionByDate.get(date);
    const bc = bodyCompByDate.get(date);
    joined.push({
      date,
      resting_hr: m.resting_hr,
      hrv: m.hrv,
      spo2_avg: m.spo2_avg,
      steps: m.steps,
      active_energy_kcal: m.active_energy_kcal,
      skin_temp_c: m.skin_temp_c,
      sleep_duration_min: s?.duration_minutes ?? null,
      deep_min: s?.deep_minutes ?? null,
      rem_min: s?.rem_minutes ?? null,
      sleep_efficiency: s?.efficiency_pct ?? null,
      exercise_minutes: a?.minutes ?? null,
      cardio_minutes: a?.cardio ?? null,
      strength_minutes: a?.strength ?? null,
      flexibility_minutes: a?.flexibility ?? null,
      calories: n?.calories ?? null,
      protein_g: n?.protein_g ?? null,
      carbs_g: n?.carbs_g ?? null,
      fat_g: n?.fat_g ?? null,
      fiber_g: n?.fiber_g ?? null,
      weight_kg: bc?.weight_kg ?? null,
      body_fat_pct: bc?.body_fat_pct ?? null,
      // rolling values computed below
      weight_30d_avg: null,
      body_fat_30d_avg: null,
      weight_30d_delta: null,
      body_fat_30d_delta: null,
    });
  }

  joined.sort((a, b) => a.date.localeCompare(b.date));

  // Compute rolling averages and deltas for body comp
  // Use 30-day windows — weight trends are weekly/monthly, not daily
  const BODY_WINDOW = 30;
  for (let i = 0; i < joined.length; i++) {
    if (i < BODY_WINDOW - 1) continue;
    const window = joined.slice(i - (BODY_WINDOW - 1), i + 1);
    const weights = window.map((d) => d.weight_kg).filter((v): v is number => v != null);
    const fats = window.map((d) => d.body_fat_pct).filter((v): v is number => v != null);

    const day = joined[i];
    if (!day) continue;

    if (weights.length >= 5) {
      day.weight_30d_avg = weights.reduce((a, b) => a + b, 0) / weights.length;
    }
    if (fats.length >= 5) {
      day.body_fat_30d_avg = fats.reduce((a, b) => a + b, 0) / fats.length;
    }

    // Delta: compare this 30-day avg to previous 30-day avg
    if (i >= BODY_WINDOW * 2 - 1) {
      const prevWindow = joined.slice(i - (BODY_WINDOW * 2 - 1), i - (BODY_WINDOW - 1));
      const prevWeights = prevWindow.map((d) => d.weight_kg).filter((v): v is number => v != null);
      const prevFats = prevWindow.map((d) => d.body_fat_pct).filter((v): v is number => v != null);

      if (weights.length >= 5 && prevWeights.length >= 5) {
        const curAvg = weights.reduce((a, b) => a + b, 0) / weights.length;
        const prevAvg = prevWeights.reduce((a, b) => a + b, 0) / prevWeights.length;
        day.weight_30d_delta = curAvg - prevAvg;
      }
      if (fats.length >= 5 && prevFats.length >= 5) {
        const curAvg = fats.reduce((a, b) => a + b, 0) / fats.length;
        const prevAvg = prevFats.reduce((a, b) => a + b, 0) / prevFats.length;
        day.body_fat_30d_delta = curAvg - prevAvg;
      }
    }
  }

  return joined;
}

// ── Rolling average helper ────────────────────────────────────────────────

function rollingAvg(
  joined: JoinedDay[],
  idx: number,
  days: number,
  extract: (d: JoinedDay) => number | null,
  minCount?: number,
): number | null {
  if (idx < days - 1) return null;
  const window = joined.slice(idx - (days - 1), idx + 1);
  const vals = window.map(extract).filter((v): v is number => v != null);
  const required = minCount ?? Math.max(3, Math.ceil(days * 0.1));
  if (vals.length < required) return null;
  return vals.reduce((a, b) => a + b, 0) / vals.length;
}

// ── Conditional analysis ──────────────────────────────────────────────────

interface ConditionalTest {
  id: string;
  action: string;
  metric: string;
  scope?: "day" | "month"; // default "day"
  splitFn: (day: JoinedDay, allDays: JoinedDay[], idx: number) => boolean | null;
  valueFn: (day: JoinedDay, allDays: JoinedDay[], idx: number) => number | null;
}

function getConditionalTests(): ConditionalTest[] {
  return [
    // ── Sleep → recovery ──
    {
      id: "sleep-7h-hrv",
      action: "7+ hours of sleep",
      metric: "next-day HRV",
      splitFn: (d) => (d.sleep_duration_min != null ? d.sleep_duration_min >= 420 : null),
      valueFn: (_d, all, i) => all[i + 1]?.hrv ?? null,
    },
    {
      id: "sleep-7h-rhr",
      action: "7+ hours of sleep",
      metric: "next-day resting HR",
      splitFn: (d) => (d.sleep_duration_min != null ? d.sleep_duration_min >= 420 : null),
      valueFn: (_d, all, i) => all[i + 1]?.resting_hr ?? null,
    },
    {
      id: "deep-60-hrv",
      action: "60+ min deep sleep",
      metric: "next-day HRV",
      splitFn: (d) => (d.deep_min != null ? d.deep_min >= 60 : null),
      valueFn: (_d, all, i) => all[i + 1]?.hrv ?? null,
    },
    // ── Exercise → sleep/recovery ──
    {
      id: "exercise-30-sleep",
      action: "30+ min exercise",
      metric: "sleep duration that night",
      splitFn: (d) => (d.exercise_minutes != null ? d.exercise_minutes >= 30 : null),
      valueFn: (_d, all, i) => all[i + 1]?.sleep_duration_min ?? null,
    },
    {
      id: "exercise-30-hrv",
      action: "30+ min exercise",
      metric: "next-day HRV",
      splitFn: (d) => (d.exercise_minutes != null ? d.exercise_minutes >= 30 : null),
      valueFn: (_d, all, i) => all[i + 1]?.hrv ?? null,
    },
    {
      id: "steps-10k-hrv",
      action: "10,000+ steps",
      metric: "next-day HRV",
      splitFn: (d) => (d.steps != null ? d.steps >= 10000 : null),
      valueFn: (_d, all, i) => all[i + 1]?.hrv ?? null,
    },
    {
      id: "active-500-sleep-eff",
      action: "500+ active kcal",
      metric: "sleep efficiency that night",
      splitFn: (d) => (d.active_energy_kcal != null ? d.active_energy_kcal >= 500 : null),
      valueFn: (_d, all, i) => all[i + 1]?.sleep_efficiency ?? null,
    },
    {
      id: "sleep-consistent-hrv",
      action: "consistent sleep schedule (< 30min variation)",
      metric: "HRV",
      splitFn: (_d: JoinedDay, all: JoinedDay[], i: number) => {
        if (i < 7) return null;
        const week = all.slice(i - 6, i + 1);
        const durations = week
          .map((w) => w.sleep_duration_min)
          .filter((v): v is number => v != null);
        if (durations.length < 5) return null;
        const avg = durations.reduce((a, b) => a + b, 0) / durations.length;
        const std = Math.sqrt(durations.reduce((s, v) => s + (v - avg) ** 2, 0) / durations.length);
        return std < 30;
      },
      valueFn: (d) => d.hrv,
    },
    {
      id: "rem-90-hrv",
      action: "90+ min REM sleep",
      metric: "next-day HRV",
      splitFn: (d) => (d.rem_min != null ? d.rem_min >= 90 : null),
      valueFn: (_d, all, i) => all[i + 1]?.hrv ?? null,
    },
    // ── Exercise type → sleep ──
    {
      id: "cardio-sleep",
      action: "cardio day",
      metric: "sleep duration that night",
      splitFn: (d) => (d.cardio_minutes != null ? d.cardio_minutes >= 20 : null),
      valueFn: (_d, all, i) => all[i + 1]?.sleep_duration_min ?? null,
    },
    {
      id: "cardio-deep-sleep",
      action: "cardio day",
      metric: "deep sleep that night",
      splitFn: (d) => (d.cardio_minutes != null ? d.cardio_minutes >= 20 : null),
      valueFn: (_d, all, i) => all[i + 1]?.deep_min ?? null,
    },
    {
      id: "cardio-sleep-eff",
      action: "cardio day",
      metric: "sleep efficiency that night",
      splitFn: (d) => (d.cardio_minutes != null ? d.cardio_minutes >= 20 : null),
      valueFn: (_d, all, i) => all[i + 1]?.sleep_efficiency ?? null,
    },
    {
      id: "strength-sleep",
      action: "strength training day",
      metric: "sleep duration that night",
      splitFn: (d) => (d.strength_minutes != null ? d.strength_minutes >= 15 : null),
      valueFn: (_d, all, i) => all[i + 1]?.sleep_duration_min ?? null,
    },
    {
      id: "strength-deep-sleep",
      action: "strength training day",
      metric: "deep sleep that night",
      splitFn: (d) => (d.strength_minutes != null ? d.strength_minutes >= 15 : null),
      valueFn: (_d, all, i) => all[i + 1]?.deep_min ?? null,
    },
    {
      id: "yoga-sleep-eff",
      action: "yoga/flexibility day",
      metric: "sleep efficiency that night",
      splitFn: (d) => (d.flexibility_minutes != null ? d.flexibility_minutes >= 15 : null),
      valueFn: (_d, all, i) => all[i + 1]?.sleep_efficiency ?? null,
    },
    {
      id: "yoga-hrv",
      action: "yoga/flexibility day",
      metric: "next-day HRV",
      splitFn: (d) => (d.flexibility_minutes != null ? d.flexibility_minutes >= 15 : null),
      valueFn: (_d, all, i) => all[i + 1]?.hrv ?? null,
    },
    // ── Exercise type → recovery ──
    {
      id: "cardio-hrv",
      action: "cardio day",
      metric: "next-day HRV",
      splitFn: (d) => (d.cardio_minutes != null ? d.cardio_minutes >= 20 : null),
      valueFn: (_d, all, i) => all[i + 1]?.hrv ?? null,
    },
    {
      id: "strength-hrv",
      action: "strength training day",
      metric: "next-day HRV",
      splitFn: (d) => (d.strength_minutes != null ? d.strength_minutes >= 15 : null),
      valueFn: (_d, all, i) => all[i + 1]?.hrv ?? null,
    },
    // ── Exercise → body comp (30-day rolling) ──
    {
      id: "exercise-monthly-weight",
      action: "12+ exercise days per month",
      metric: "monthly weight change",
      scope: "month" as const,
      splitFn: (_d, all, i) => {
        if (i < 29) return null;
        const month = all.slice(i - 29, i + 1);
        const exerciseDays = month.filter((d) => (d.exercise_minutes ?? 0) >= 20).length;
        return exerciseDays >= 12;
      },
      valueFn: (d) => d.weight_30d_delta,
    },
    {
      id: "exercise-monthly-bf",
      action: "12+ exercise days per month",
      metric: "monthly body fat change",
      scope: "month" as const,
      splitFn: (_d, all, i) => {
        if (i < 29) return null;
        const month = all.slice(i - 29, i + 1);
        const exerciseDays = month.filter((d) => (d.exercise_minutes ?? 0) >= 20).length;
        return exerciseDays >= 12;
      },
      valueFn: (d) => d.body_fat_30d_delta,
    },
    // ── Nutrition → body comp (30-day rolling, isocaloric: use % of calories) ──
    {
      id: "high-cal-weight",
      action: "high calorie month (avg 2500+/day)",
      metric: "monthly weight change",
      scope: "month" as const,
      splitFn: (_d, all, i) => {
        const avg = rollingAvg(all, i, 30, (d) => d.calories);
        return avg != null ? avg >= 2500 : null;
      },
      valueFn: (d) => d.weight_30d_delta,
    },
    {
      id: "high-protein-pct-weight",
      action: ">30% calories from protein",
      metric: "monthly weight change",
      scope: "month" as const,
      splitFn: (_d, all, i) => {
        const avg = rollingAvg(all, i, 30, (d) =>
          d.protein_g != null && d.calories ? ((d.protein_g * 4) / d.calories) * 100 : null,
        );
        return avg != null ? avg >= 30 : null;
      },
      valueFn: (d) => d.weight_30d_delta,
    },
    {
      id: "high-protein-pct-bf",
      action: ">30% calories from protein",
      metric: "monthly body fat change",
      scope: "month" as const,
      splitFn: (_d, all, i) => {
        const avg = rollingAvg(all, i, 30, (d) =>
          d.protein_g != null && d.calories ? ((d.protein_g * 4) / d.calories) * 100 : null,
        );
        return avg != null ? avg >= 30 : null;
      },
      valueFn: (d) => d.body_fat_30d_delta,
    },
    {
      id: "high-carb-pct-weight",
      action: ">50% calories from carbs",
      metric: "monthly weight change",
      scope: "month" as const,
      splitFn: (_d, all, i) => {
        const avg = rollingAvg(all, i, 30, (d) =>
          d.carbs_g != null && d.calories ? ((d.carbs_g * 4) / d.calories) * 100 : null,
        );
        return avg != null ? avg >= 50 : null;
      },
      valueFn: (d) => d.weight_30d_delta,
    },
    {
      id: "high-fat-pct-bf",
      action: ">35% calories from fat",
      metric: "monthly body fat change",
      scope: "month" as const,
      splitFn: (_d, all, i) => {
        const avg = rollingAvg(all, i, 30, (d) =>
          d.fat_g != null && d.calories ? ((d.fat_g * 9) / d.calories) * 100 : null,
        );
        return avg != null ? avg >= 35 : null;
      },
      valueFn: (d) => d.body_fat_30d_delta,
    },
    // ── Nutrition → recovery ──
    {
      id: "high-protein-hrv",
      action: "100g+ protein",
      metric: "next-day HRV",
      splitFn: (d) => (d.protein_g != null ? d.protein_g >= 100 : null),
      valueFn: (_d, all, i) => all[i + 1]?.hrv ?? null,
    },
    {
      id: "high-cal-sleep",
      action: "2500+ calories",
      metric: "sleep duration that night",
      splitFn: (d) => (d.calories != null ? d.calories >= 2500 : null),
      valueFn: (_d, all, i) => all[i + 1]?.sleep_duration_min ?? null,
    },
  ];
}

// ── Correlation pairs ─────────────────────────────────────────────────────

interface CorrelationPair {
  id: string;
  xName: string;
  yName: string;
  xFn: (day: JoinedDay, allDays: JoinedDay[], idx: number) => number | null;
  yFn: (day: JoinedDay, allDays: JoinedDay[], idx: number) => number | null;
}

function getCorrelationPairs(): CorrelationPair[] {
  return [
    // ── Sleep/recovery ──
    {
      id: "sleep-dur-hrv",
      xName: "sleep duration",
      yName: "next-day HRV",
      xFn: (d) => d.sleep_duration_min,
      yFn: (_d, all, i) => all[i + 1]?.hrv ?? null,
    },
    {
      id: "steps-hrv",
      xName: "daily steps",
      yName: "next-day HRV",
      xFn: (d) => d.steps,
      yFn: (_d, all, i) => all[i + 1]?.hrv ?? null,
    },
    {
      id: "active-kcal-sleep",
      xName: "active calories",
      yName: "sleep duration that night",
      xFn: (d) => d.active_energy_kcal,
      yFn: (_d, all, i) => all[i + 1]?.sleep_duration_min ?? null,
    },
    {
      id: "deep-sleep-hrv",
      xName: "deep sleep",
      yName: "next-day HRV",
      xFn: (d) => d.deep_min,
      yFn: (_d, all, i) => all[i + 1]?.hrv ?? null,
    },
    {
      id: "exercise-dur-sleep-eff",
      xName: "exercise duration",
      yName: "sleep efficiency",
      xFn: (d) => d.exercise_minutes,
      yFn: (_d, all, i) => all[i + 1]?.sleep_efficiency ?? null,
    },
    {
      id: "rhr-hrv",
      xName: "resting HR",
      yName: "HRV",
      xFn: (d) => d.resting_hr,
      yFn: (d) => d.hrv,
    },
    // ── Nutrition → body comp (30-day rolling, isocaloric: use % of calories) ──
    {
      id: "calories-30d-weight-delta",
      xName: "30-day avg calories",
      yName: "monthly weight change",
      xFn: (_d, all, i) => rollingAvg(all, i, 30, (r) => r.calories),
      yFn: (d) => d.weight_30d_delta,
    },
    {
      id: "protein-pct-30d-weight-delta",
      xName: "30-day avg protein %",
      yName: "monthly weight change",
      xFn: (_d, all, i) =>
        rollingAvg(all, i, 30, (r) =>
          r.protein_g != null && r.calories ? ((r.protein_g * 4) / r.calories) * 100 : null,
        ),
      yFn: (d) => d.weight_30d_delta,
    },
    {
      id: "protein-pct-30d-bf-delta",
      xName: "30-day avg protein %",
      yName: "monthly body fat change",
      xFn: (_d, all, i) =>
        rollingAvg(all, i, 30, (r) =>
          r.protein_g != null && r.calories ? ((r.protein_g * 4) / r.calories) * 100 : null,
        ),
      yFn: (d) => d.body_fat_30d_delta,
    },
    {
      id: "carb-pct-30d-weight-delta",
      xName: "30-day avg carb %",
      yName: "monthly weight change",
      xFn: (_d, all, i) =>
        rollingAvg(all, i, 30, (r) =>
          r.carbs_g != null && r.calories ? ((r.carbs_g * 4) / r.calories) * 100 : null,
        ),
      yFn: (d) => d.weight_30d_delta,
    },
    {
      id: "fat-pct-30d-bf-delta",
      xName: "30-day avg fat %",
      yName: "monthly body fat change",
      xFn: (_d, all, i) =>
        rollingAvg(all, i, 30, (r) =>
          r.fat_g != null && r.calories ? ((r.fat_g * 9) / r.calories) * 100 : null,
        ),
      yFn: (d) => d.body_fat_30d_delta,
    },
    // ── Exercise → body comp (30-day rolling) ──
    {
      id: "exercise-30d-weight-delta",
      xName: "monthly exercise volume",
      yName: "monthly weight change",
      xFn: (_d: JoinedDay, all: JoinedDay[], i: number) => {
        if (i < 29) return null;
        const month = all.slice(i - 29, i + 1);
        const total = month.reduce((sum, w) => sum + (w.exercise_minutes ?? 0), 0);
        return total > 0 ? total : null;
      },
      yFn: (d) => d.weight_30d_delta,
    },
    {
      id: "exercise-30d-bf-delta",
      xName: "monthly exercise volume",
      yName: "monthly body fat change",
      xFn: (_d: JoinedDay, all: JoinedDay[], i: number) => {
        if (i < 29) return null;
        const month = all.slice(i - 29, i + 1);
        const total = month.reduce((sum, w) => sum + (w.exercise_minutes ?? 0), 0);
        return total > 0 ? total : null;
      },
      yFn: (d) => d.body_fat_30d_delta,
    },
    // ── Nutrition → recovery ──
    {
      id: "protein-hrv",
      xName: "daily protein",
      yName: "next-day HRV",
      xFn: (d) => d.protein_g,
      yFn: (_d, all, i) => all[i + 1]?.hrv ?? null,
    },
    {
      id: "calories-sleep",
      xName: "daily calories",
      yName: "sleep duration",
      xFn: (d) => d.calories,
      yFn: (_d, all, i) => all[i + 1]?.sleep_duration_min ?? null,
    },
  ];
}

// ── Exhaustive pairwise discovery ──────────────────────────────────────────

/**
 * Causal role for direction constraints in discovery sweep.
 * - "action": controllable inputs (nutrition, exercise) — valid as X (predictor)
 * - "outcome": measured outputs (HRV, resting HR, body comp) — valid as Y (response)
 * - "bidirectional": can be either (sleep — affected by actions, but also affects outcomes)
 */
type CausalRole = "action" | "outcome" | "bidirectional";

interface MetricDef {
  key: string;
  label: string;
  role: CausalRole;
  extract: (day: JoinedDay, allDays: JoinedDay[], idx: number) => number | null;
}

function getAllMetrics(): MetricDef[] {
  return [
    // Outcome variables — things that happen to you, not controllable
    { key: "resting_hr", label: "resting HR", role: "outcome", extract: (d) => d.resting_hr },
    { key: "hrv", label: "HRV", role: "outcome", extract: (d) => d.hrv },
    { key: "spo2", label: "SpO2", role: "outcome", extract: (d) => d.spo2_avg },
    { key: "skin_temp", label: "skin temp", role: "outcome", extract: (d) => d.skin_temp_c },
    // Action variables — controllable inputs
    { key: "steps", label: "steps", role: "action", extract: (d) => d.steps },
    {
      key: "active_kcal",
      label: "active calories",
      role: "action",
      extract: (d) => d.active_energy_kcal,
    },
    {
      key: "exercise",
      label: "exercise duration",
      role: "action",
      extract: (d) => d.exercise_minutes,
    },
    { key: "calories", label: "calories", role: "action", extract: (d) => d.calories },
    { key: "protein", label: "protein", role: "action", extract: (d) => d.protein_g },
    { key: "carbs", label: "carbs", role: "action", extract: (d) => d.carbs_g },
    { key: "fat", label: "dietary fat", role: "action", extract: (d) => d.fat_g },
    { key: "fiber", label: "fiber", role: "action", extract: (d) => d.fiber_g },
    // Bidirectional — sleep is both an action (going to bed) and an outcome (affected by exercise)
    {
      key: "sleep_dur",
      label: "sleep duration",
      role: "bidirectional",
      extract: (d) => d.sleep_duration_min,
    },
    { key: "deep_sleep", label: "deep sleep", role: "bidirectional", extract: (d) => d.deep_min },
    { key: "rem_sleep", label: "REM sleep", role: "bidirectional", extract: (d) => d.rem_min },
    {
      key: "sleep_eff",
      label: "sleep efficiency",
      role: "bidirectional",
      extract: (d) => d.sleep_efficiency,
    },
    // Body comp — outcome (you can't directly control weight/bf, only influence via actions)
    { key: "weight", label: "weight", role: "outcome", extract: (d) => d.weight_kg },
    { key: "body_fat", label: "body fat %", role: "outcome", extract: (d) => d.body_fat_pct },
    {
      key: "weight_30d",
      label: "30-day avg weight",
      role: "outcome",
      extract: (d) => d.weight_30d_avg,
    },
    {
      key: "bf_30d",
      label: "30-day avg body fat",
      role: "outcome",
      extract: (d) => d.body_fat_30d_avg,
    },
    {
      key: "weight_delta",
      label: "monthly weight change",
      role: "outcome",
      extract: (d) => d.weight_30d_delta,
    },
    {
      key: "bf_delta",
      label: "monthly body fat change",
      role: "outcome",
      extract: (d) => d.body_fat_30d_delta,
    },
  ];
}

/**
 * Check if a pair (x→y) at a given lag respects causal direction.
 * Rules:
 * - outcome→action is NEVER valid (HRV can't cause you to eat more fiber)
 * - outcome→outcome at lag>0 is suspect (one outcome "predicting" another later outcome)
 * - action→outcome is always valid
 * - bidirectional can be either side
 */
function isValidCausalDirection(xRole: CausalRole, yRole: CausalRole, lag: number): boolean {
  // outcome→action: always invalid (backwards causality)
  if (xRole === "outcome" && yRole === "action") return false;
  // outcome→outcome: only same-day (lag 0) — not lagged prediction
  if (xRole === "outcome" && yRole === "outcome" && lag > 0) return false;
  return true;
}

const MAX_LAG = 2;
const MIN_SAMPLES = 20;
const MIN_RHO = 0.15;

function exhaustiveSweep(joined: JoinedDay[], existingIds: Set<string>): Insight[] {
  const metrics = getAllMetrics();
  const candidates: Array<{
    id: string;
    xLabel: string;
    yLabel: string;
    lag: number;
    rho: number;
    pValue: number;
    n: number;
    dataPoints: Array<{ x: number; y: number; date: string }>;
  }> = [];

  // Group keys that are derived from the same underlying metric or category
  const derivedGroups: Record<string, string> = {
    weight_30d: "weight",
    bf_30d: "body_fat",
    weight_delta: "weight",
    bf_delta: "body_fat",
  };
  // Keys in the same category — skip intra-category correlations (e.g. calories↔carbs)
  const categoryMap: Record<string, string> = {
    calories: "nutrition",
    protein: "nutrition",
    carbs: "nutrition",
    fat: "nutrition",
    fiber: "nutrition",
    weight: "bodycomp",
    body_fat: "bodycomp",
    weight_30d: "bodycomp",
    bf_30d: "bodycomp",
    weight_delta: "bodycomp",
    bf_delta: "bodycomp",
    sleep_dur: "sleep",
    deep_sleep: "sleep",
    rem_sleep: "sleep",
    sleep_eff: "sleep",
    steps: "activity",
    active_kcal: "activity",
    exercise: "activity",
  };
  // Body comp metrics shouldn't appear in short-lag (0-2 day) discovery — only meaningful at monthly scale
  const bodyCompKeys = new Set([
    "weight",
    "body_fat",
    "weight_30d",
    "bf_30d",
    "weight_delta",
    "bf_delta",
  ]);

  for (const mx of metrics) {
    for (const my of metrics) {
      if (mx.key === my.key) continue;
      // Skip trivial self-correlations between a metric and its derived rolling version
      const mxBase = derivedGroups[mx.key] ?? mx.key;
      const myBase = derivedGroups[my.key] ?? my.key;
      if (mxBase === myBase) continue;
      // Skip intra-category correlations (e.g., calories↔carbs, weight↔body_fat, steps↔active_kcal)
      const mxCat = categoryMap[mx.key];
      const myCat = categoryMap[my.key];
      if (mxCat && myCat && mxCat === myCat) continue;
      // Skip body comp in short-lag discovery — only meaningful at monthly scale
      if (bodyCompKeys.has(mx.key) || bodyCompKeys.has(my.key)) continue;

      for (let lag = 0; lag <= MAX_LAG; lag++) {
        // Direction constraint: only test causally valid directions
        // e.g., never "HRV → 2 days later fiber" (outcome predicting future action)
        if (!isValidCausalDirection(mx.role, my.role, lag)) continue;
        const id = `disc-${mx.key}-${my.key}-lag${lag}`;
        const lagLabel =
          lag === 0 ? my.label : `${lag === 1 ? "next day" : `${lag} days later`} ${my.label}`;
        if (
          existingIds.has(`${mx.label}::${lagLabel}`) ||
          existingIds.has(`${mx.label}::${my.label}`)
        )
          continue;

        const xs: number[] = [];
        const ys: number[] = [];
        const dates: string[] = [];

        for (let i = 0; i < joined.length - lag; i++) {
          const dayX = joined[i];
          const dayY = joined[i + lag];
          if (!dayX || !dayY) continue;
          const x = mx.extract(dayX, joined, i);
          const y = my.extract(dayY, joined, i + lag);
          if (x != null && y != null) {
            xs.push(x);
            ys.push(y);
            dates.push(dayX.date);
          }
        }

        if (xs.length < MIN_SAMPLES) continue;

        const corr = spearmanCorrelation(xs, ys);
        if (Math.abs(corr.rho) < MIN_RHO) continue;

        const rawPoints: { x: number; y: number; date: string }[] = [];
        for (let j = 0; j < xs.length; j++) {
          const yVal = ys[j];
          const dateVal = dates[j];
          if (yVal !== undefined && dateVal !== undefined) {
            const xVal = xs[j];
            if (xVal !== undefined) rawPoints.push({ x: xVal, y: yVal, date: dateVal });
          }
        }

        candidates.push({
          id,
          xLabel: mx.label,
          yLabel: my.label,
          lag,
          rho: corr.rho,
          pValue: corr.pValue,
          n: corr.n,
          dataPoints: downsample(rawPoints, MAX_DATA_POINTS),
        });
      }
    }
  }

  if (candidates.length === 0) return [];

  const pValues = candidates.map((c) => c.pValue);
  const significant = benjaminiHochberg(pValues, 0.05);

  const discoveries: Insight[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const c = candidates[i];
    if (!significant[i] || !c) continue;
    const absRho = Math.abs(c.rho);
    const direction = c.rho > 0 ? "positively" : "negatively";
    const strength = absRho >= 0.6 ? "strongly" : absRho >= 0.4 ? "moderately" : "";
    const lagText = c.lag === 0 ? "same day" : c.lag === 1 ? "next day" : `${c.lag} days later`;
    const confidence = classifyCorrelationConfidence(c.rho, c.n);

    const yWithLag = c.lag > 0 ? `${lagText} ${c.yLabel}` : c.yLabel;

    discoveries.push({
      id: c.id,
      type: "discovery",
      confidence,
      metric: c.yLabel,
      action: c.xLabel,
      message: `${c.xLabel} is ${strength ? `${strength} ` : ""}${direction} associated with ${yWithLag}`,
      detail: `Spearman ρ=${c.rho.toFixed(2)}, ${lagText}, n=${c.n}`,
      whenTrue: describe([]),
      whenFalse: describe([]),
      effectSize: c.rho,
      pValue: c.pValue,
      correlation: { rho: c.rho, pValue: c.pValue, n: c.n },
      dataPoints: c.dataPoints,
    });
  }

  // Deduplicate: for each unordered pair (A,B), keep only the strongest correlation
  const pairBest = new Map<string, Insight>();
  for (const d of discoveries) {
    const [a, b] = [d.action, d.metric].sort();
    const pairKey = `${a}::${b}`;
    const existing = pairBest.get(pairKey);
    if (!existing || Math.abs(d.effectSize) > Math.abs(existing.effectSize)) {
      pairBest.set(pairKey, d);
    }
  }

  const deduped = [...pairBest.values()];
  deduped.sort((a, b) => Math.abs(b.effectSize) - Math.abs(a.effectSize));
  return deduped;
}

// ── Monthly aggregation for body comp / nutrition ─────────────────────────

interface MonthlyAgg {
  month: string; // YYYY-MM
  avgCalories: number | null;
  avgProtein: number | null;
  avgCarbs: number | null;
  avgFat: number | null;
  nutritionDays: number;
  exerciseMinutes: number;
  exerciseDays: number;
  cardioMinutes: number;
  strengthMinutes: number;
  flexibilityMinutes: number;
  cardioDays: number;
  strengthDays: number;
  weightStart: number | null;
  weightEnd: number | null;
  weightDelta: number | null;
  bfStart: number | null;
  bfEnd: number | null;
  bfDelta: number | null;
}

function aggregateMonthly(joined: JoinedDay[]): MonthlyAgg[] {
  const byMonth = new Map<string, JoinedDay[]>();
  for (const d of joined) {
    const month = d.date.slice(0, 7);
    const arr = byMonth.get(month) ?? [];
    arr.push(d);
    byMonth.set(month, arr);
  }

  const months: MonthlyAgg[] = [];
  for (const [month, days] of byMonth) {
    if (days.length < 20) continue; // need at least 20 days of data

    const cals = days.map((d) => d.calories).filter((v): v is number => v != null);
    const prots = days.map((d) => d.protein_g).filter((v): v is number => v != null);
    const carbs = days.map((d) => d.carbs_g).filter((v): v is number => v != null);
    const fats = days.map((d) => d.fat_g).filter((v): v is number => v != null);

    const weights = days
      .filter((d) => d.weight_kg != null)
      .sort((a, b) => a.date.localeCompare(b.date));
    const bfs = days
      .filter((d) => d.body_fat_pct != null)
      .sort((a, b) => a.date.localeCompare(b.date));

    const exerciseDays = days.filter((d) => (d.exercise_minutes ?? 0) >= 20);
    const totalExercise = days.reduce((sum, d) => sum + (d.exercise_minutes ?? 0), 0);
    const totalCardio = days.reduce((sum, d) => sum + (d.cardio_minutes ?? 0), 0);
    const totalStrength = days.reduce((sum, d) => sum + (d.strength_minutes ?? 0), 0);
    const totalFlexibility = days.reduce((sum, d) => sum + (d.flexibility_minutes ?? 0), 0);
    const cardioDays = days.filter((d) => (d.cardio_minutes ?? 0) >= 10).length;
    const strengthDays = days.filter((d) => (d.strength_minutes ?? 0) >= 10).length;

    // Use first/last 5 measurements for stable start/end
    const weightStart =
      weights.length >= 5
        ? weights.slice(0, 5).reduce((s, d) => s + (d.weight_kg ?? 0), 0) / 5
        : weights.length >= 2
          ? (weights[0]?.weight_kg ?? null)
          : null;
    const weightEnd =
      weights.length >= 5
        ? weights.slice(-5).reduce((s, d) => s + (d.weight_kg ?? 0), 0) / 5
        : weights.length >= 2
          ? (weights[weights.length - 1]?.weight_kg ?? null)
          : null;

    const bfStart =
      bfs.length >= 5
        ? bfs.slice(0, 5).reduce((s, d) => s + (d.body_fat_pct ?? 0), 0) / 5
        : bfs.length >= 2
          ? (bfs[0]?.body_fat_pct ?? null)
          : null;
    const bfEnd =
      bfs.length >= 5
        ? bfs.slice(-5).reduce((s, d) => s + (d.body_fat_pct ?? 0), 0) / 5
        : bfs.length >= 2
          ? (bfs[bfs.length - 1]?.body_fat_pct ?? null)
          : null;

    months.push({
      month,
      avgCalories: cals.length >= 3 ? cals.reduce((a, b) => a + b, 0) / cals.length : null,
      avgProtein: prots.length >= 3 ? prots.reduce((a, b) => a + b, 0) / prots.length : null,
      avgCarbs: carbs.length >= 3 ? carbs.reduce((a, b) => a + b, 0) / carbs.length : null,
      avgFat: fats.length >= 3 ? fats.reduce((a, b) => a + b, 0) / fats.length : null,
      nutritionDays: cals.length,
      exerciseMinutes: totalExercise,
      exerciseDays: exerciseDays.length,
      cardioMinutes: totalCardio,
      strengthMinutes: totalStrength,
      flexibilityMinutes: totalFlexibility,
      cardioDays,
      strengthDays,
      weightStart,
      weightEnd,
      weightDelta: weightStart != null && weightEnd != null ? weightEnd - weightStart : null,
      bfStart,
      bfEnd,
      bfDelta: bfStart != null && bfEnd != null ? bfEnd - bfStart : null,
    });
  }

  return months.sort((a, b) => a.month.localeCompare(b.month));
}

interface MonthlyCorrelationPair {
  id: string;
  xName: string;
  yName: string;
  xFn: (m: MonthlyAgg) => number | null;
  yFn: (m: MonthlyAgg) => number | null;
}

function getMonthlyCorrelations(): MonthlyCorrelationPair[] {
  return [
    // Total calories → weight (not isocaloric — this is the total energy signal)
    {
      id: "m-calories-weight",
      xName: "monthly avg calories",
      yName: "monthly weight change",
      xFn: (m) => m.avgCalories,
      yFn: (m) => m.weightDelta,
    },
    // Macro % → body comp (isocaloric: controlling for total calories)
    {
      id: "m-protein-pct-weight",
      xName: "monthly protein % of calories",
      yName: "monthly weight change",
      xFn: (m) =>
        m.avgProtein != null && m.avgCalories ? ((m.avgProtein * 4) / m.avgCalories) * 100 : null,
      yFn: (m) => m.weightDelta,
    },
    {
      id: "m-protein-pct-bf",
      xName: "monthly protein % of calories",
      yName: "monthly body fat change",
      xFn: (m) =>
        m.avgProtein != null && m.avgCalories ? ((m.avgProtein * 4) / m.avgCalories) * 100 : null,
      yFn: (m) => m.bfDelta,
    },
    {
      id: "m-carb-pct-weight",
      xName: "monthly carb % of calories",
      yName: "monthly weight change",
      xFn: (m) =>
        m.avgCarbs != null && m.avgCalories ? ((m.avgCarbs * 4) / m.avgCalories) * 100 : null,
      yFn: (m) => m.weightDelta,
    },
    {
      id: "m-fat-pct-bf",
      xName: "monthly fat % of calories",
      yName: "monthly body fat change",
      xFn: (m) =>
        m.avgFat != null && m.avgCalories ? ((m.avgFat * 9) / m.avgCalories) * 100 : null,
      yFn: (m) => m.bfDelta,
    },
    // Total exercise
    {
      id: "m-exercise-vol-weight",
      xName: "monthly exercise volume",
      yName: "monthly weight change",
      xFn: (m) => (m.exerciseMinutes > 0 ? m.exerciseMinutes : null),
      yFn: (m) => m.weightDelta,
    },
    {
      id: "m-exercise-vol-bf",
      xName: "monthly exercise volume",
      yName: "monthly body fat change",
      xFn: (m) => (m.exerciseMinutes > 0 ? m.exerciseMinutes : null),
      yFn: (m) => m.bfDelta,
    },
    {
      id: "m-exercise-freq-weight",
      xName: "monthly exercise frequency",
      yName: "monthly weight change",
      xFn: (m) => (m.exerciseDays > 0 ? m.exerciseDays : null),
      yFn: (m) => m.weightDelta,
    },
    {
      id: "m-exercise-freq-bf",
      xName: "monthly exercise frequency",
      yName: "monthly body fat change",
      xFn: (m) => (m.exerciseDays > 0 ? m.exerciseDays : null),
      yFn: (m) => m.bfDelta,
    },
    // Cardio → body comp
    {
      id: "m-cardio-vol-weight",
      xName: "monthly cardio volume",
      yName: "monthly weight change",
      xFn: (m) => (m.cardioMinutes > 0 ? m.cardioMinutes : null),
      yFn: (m) => m.weightDelta,
    },
    {
      id: "m-cardio-vol-bf",
      xName: "monthly cardio volume",
      yName: "monthly body fat change",
      xFn: (m) => (m.cardioMinutes > 0 ? m.cardioMinutes : null),
      yFn: (m) => m.bfDelta,
    },
    {
      id: "m-cardio-freq-weight",
      xName: "monthly cardio frequency",
      yName: "monthly weight change",
      xFn: (m) => (m.cardioDays > 0 ? m.cardioDays : null),
      yFn: (m) => m.weightDelta,
    },
    // Strength → body comp
    {
      id: "m-strength-vol-weight",
      xName: "monthly strength volume",
      yName: "monthly weight change",
      xFn: (m) => (m.strengthMinutes > 0 ? m.strengthMinutes : null),
      yFn: (m) => m.weightDelta,
    },
    {
      id: "m-strength-vol-bf",
      xName: "monthly strength volume",
      yName: "monthly body fat change",
      xFn: (m) => (m.strengthMinutes > 0 ? m.strengthMinutes : null),
      yFn: (m) => m.bfDelta,
    },
    {
      id: "m-strength-freq-bf",
      xName: "monthly strength frequency",
      yName: "monthly body fat change",
      xFn: (m) => (m.strengthDays > 0 ? m.strengthDays : null),
      yFn: (m) => m.bfDelta,
    },
  ];
}

function computeMonthlyInsights(joined: JoinedDay[]): Insight[] {
  const months = aggregateMonthly(joined);
  if (months.length < 5) return [];

  const insights: Insight[] = [];

  // Monthly correlations
  for (const pair of getMonthlyCorrelations()) {
    const xs: number[] = [];
    const ys: number[] = [];

    for (const m of months) {
      const x = pair.xFn(m);
      const y = pair.yFn(m);
      if (x != null && y != null) {
        xs.push(x);
        ys.push(y);
      }
    }

    if (xs.length < 5) continue;

    const corr = spearmanCorrelation(xs, ys);
    if (Math.abs(corr.rho) < 0.2) continue;

    const direction = corr.rho > 0 ? "positively" : "negatively";
    const strength =
      Math.abs(corr.rho) >= 0.6 ? "strongly" : Math.abs(corr.rho) >= 0.4 ? "moderately" : "weakly";
    const confidence = classifyCorrelationConfidence(corr.rho, xs.length);

    insights.push({
      id: pair.id,
      type: "correlation",
      confidence,
      metric: pair.yName,
      action: pair.xName,
      message: `${pair.xName} is ${strength} ${direction} associated with ${pair.yName}`,
      detail: `Spearman ρ=${corr.rho.toFixed(2)}, n=${corr.n} months`,
      whenTrue: describe(ys),
      whenFalse: describe(ys),
      effectSize: corr.rho,
      pValue: corr.pValue,
      correlation: corr,
    });
  }

  // Monthly conditional: high exercise months vs low
  const exerciseMonths = months.filter((m) => m.weightDelta != null);
  if (exerciseMonths.length >= 10) {
    const medianDays = [...exerciseMonths].sort((a, b) => a.exerciseDays - b.exerciseDays);
    const medExDays = medianDays[Math.floor(medianDays.length / 2)]?.exerciseDays ?? 0;

    const highEx = exerciseMonths.filter((m) => m.exerciseDays > medExDays);
    const lowEx = exerciseMonths.filter((m) => m.exerciseDays <= medExDays);

    if (highEx.length >= 5 && lowEx.length >= 5) {
      const highWeightDeltas = highEx
        .map((m) => m.weightDelta)
        .filter((v): v is number => v != null);
      const lowWeightDeltas = lowEx.map((m) => m.weightDelta).filter((v): v is number => v != null);

      if (highWeightDeltas.length >= 5 && lowWeightDeltas.length >= 5) {
        const d = cohensD(highWeightDeltas, lowWeightDeltas);
        const conf = classifyConfidence(
          d,
          Math.min(highWeightDeltas.length, lowWeightDeltas.length),
        );
        if (conf !== "insufficient") {
          const tResult = welchTTest(highWeightDeltas, lowWeightDeltas);
          const trueStats = describe(highWeightDeltas);
          const falseStats = describe(lowWeightDeltas);
          const diff = trueStats.mean - falseStats.mean;

          insights.push({
            id: "m-high-exercise-weight",
            type: "conditional",
            confidence: conf,
            metric: "monthly weight change",
            action: `above-median exercise (>${medExDays} days/mo)`,
            message: `Months with more exercise have ${Math.abs(diff).toFixed(1)} kg ${diff < 0 ? "less" : "more"} weight change`,
            detail: `High exercise months: avg ${trueStats.mean.toFixed(1)} kg vs ${falseStats.mean.toFixed(1)} kg (n=${highWeightDeltas.length}/${lowWeightDeltas.length})`,
            whenTrue: trueStats,
            whenFalse: falseStats,
            effectSize: d,
            pValue: tResult.pValue,
          });
        }
      }
    }
  }

  return insights;
}

// ── Confounder detection ──────────────────────────────────────────────────

interface ContextVariable {
  label: string;
  unit: string;
  extract: (day: JoinedDay) => number | null;
}

function getContextVariables(): ContextVariable[] {
  return [
    { label: "calories", unit: "kcal", extract: (d) => d.calories },
    { label: "protein", unit: "g", extract: (d) => d.protein_g },
    { label: "carbs", unit: "g", extract: (d) => d.carbs_g },
    { label: "fat", unit: "g", extract: (d) => d.fat_g },
    {
      label: "protein % of cal",
      unit: "%",
      extract: (d) =>
        d.protein_g != null && d.calories ? ((d.protein_g * 4) / d.calories) * 100 : null,
    },
    {
      label: "carb % of cal",
      unit: "%",
      extract: (d) =>
        d.carbs_g != null && d.calories ? ((d.carbs_g * 4) / d.calories) * 100 : null,
    },
    {
      label: "fat % of cal",
      unit: "%",
      extract: (d) => (d.fat_g != null && d.calories ? ((d.fat_g * 9) / d.calories) * 100 : null),
    },
    { label: "exercise duration", unit: "min", extract: (d) => d.exercise_minutes },
    { label: "cardio duration", unit: "min", extract: (d) => d.cardio_minutes },
    { label: "strength training duration", unit: "min", extract: (d) => d.strength_minutes },
    { label: "steps", unit: "", extract: (d) => d.steps },
    { label: "sleep duration", unit: "min", extract: (d) => d.sleep_duration_min },
    { label: "deep sleep", unit: "min", extract: (d) => d.deep_min },
    { label: "sleep efficiency", unit: "%", extract: (d) => d.sleep_efficiency },
    { label: "resting HR", unit: "bpm", extract: (d) => d.resting_hr },
    { label: "HRV", unit: "ms", extract: (d) => d.hrv },
  ];
}

function findCorrelationConfounders(
  xName: string,
  yName: string,
  xValues: number[],
  yValues: number[],
  joined: JoinedDay[],
  indices: number[],
): string[] {
  const confounders: string[] = [];
  const contextVars = getContextVariables();

  for (const cv of contextVars) {
    if (xName.toLowerCase().includes(cv.label.toLowerCase())) continue;
    if (yName.toLowerCase().includes(cv.label.toLowerCase())) continue;
    if (isRelatedToAction(xName, cv.label)) continue;
    if (isRelatedToAction(yName, cv.label)) continue;

    const zValues: number[] = [];
    const xFiltered: number[] = [];
    const yFiltered: number[] = [];
    for (let j = 0; j < indices.length; j++) {
      const idx = indices[j];
      if (idx === undefined) continue;
      const day = joined[idx];
      if (!day) continue;
      const z = cv.extract(day);
      const xv = xValues[j];
      const yv = yValues[j];
      if (z != null && xv !== undefined && yv !== undefined) {
        zValues.push(z);
        xFiltered.push(xv);
        yFiltered.push(yv);
      }
    }
    if (zValues.length < 10) continue;

    const zx = spearmanCorrelation(zValues, xFiltered);
    const zy = spearmanCorrelation(zValues, yFiltered);

    // Confounder: correlates meaningfully with BOTH x and y
    if (Math.abs(zx.rho) >= 0.25 && Math.abs(zy.rho) >= 0.25) {
      confounders.push(
        `${cv.label} also correlates with both (ρ=${zx.rho.toFixed(2)} with ${xName}, ρ=${zy.rho.toFixed(2)} with ${yName})`,
      );
    }
  }

  return confounders.slice(0, 5);
}

// Variables that are subsets/supersets or mechanically related — not true confounders
const relatedVars: Record<string, Set<string>> = {
  exercise: new Set(["cardio", "strength", "active calories", "steps"]),
  cardio: new Set(["exercise", "active calories", "steps"]),
  strength: new Set(["exercise"]),
  steps: new Set(["exercise", "cardio", "active calories"]),
  "active calories": new Set(["exercise", "cardio", "steps"]),
  calories: new Set([
    "protein",
    "carbs",
    "fat",
    "fiber",
    "protein % of cal",
    "carb % of cal",
    "fat % of cal",
  ]),
  protein: new Set(["calories", "protein % of cal"]),
  carbs: new Set(["calories", "carb % of cal"]),
  fat: new Set(["calories", "fat % of cal"]),
  "protein % of cal": new Set(["carb % of cal", "fat % of cal"]),
  "carb % of cal": new Set(["protein % of cal", "fat % of cal"]),
  "fat % of cal": new Set(["protein % of cal", "carb % of cal"]),
  "sleep duration": new Set(["deep sleep"]),
  "deep sleep": new Set(["sleep duration"]),
  "resting HR": new Set(["HRV"]),
  HRV: new Set(["resting HR"]),
};

function isRelatedToAction(actionLabel: string, cvLabel: string): boolean {
  const actionLower = actionLabel.toLowerCase();
  const cvLower = cvLabel.toLowerCase();

  // Direct match: action mentions the variable
  for (const [key, related] of Object.entries(relatedVars)) {
    if (actionLower.includes(key.toLowerCase()) && related.has(cvLabel)) return true;
  }

  // Semantic overlap: action about "protein" shouldn't flag "protein % of cal" etc.
  const nutrients = ["protein", "carb", "fat", "calorie", "fiber"];
  for (const n of nutrients) {
    if (actionLower.includes(n) && cvLower.includes(n)) return true;
  }

  // Calorie actions → all macros are derivatives, not confounders
  if (actionLower.includes("calorie") || actionLower.includes("cal ")) {
    const macroLabels = [
      "protein",
      "carbs",
      "fat",
      "fiber",
      "protein % of cal",
      "carb % of cal",
      "fat % of cal",
      "calories",
    ];
    if (macroLabels.includes(cvLower)) return true;
  }

  // Macro % actions → absolute macros and other % are related
  if (actionLower.includes("% of cal") || actionLower.includes("% calories")) {
    if (cvLower.includes("% of cal") || cvLower === "calories") return true;
  }

  // Exercise family — all exercise types are related to each other
  const exerciseLabels = [
    "exercise duration",
    "cardio duration",
    "strength training duration",
    "active calories",
    "steps",
  ];
  if (
    actionLower.includes("exercise") ||
    actionLower.includes("cardio") ||
    actionLower.includes("strength") ||
    actionLower.includes("yoga") ||
    actionLower.includes("flexibility") ||
    actionLower.includes("cycling")
  ) {
    if (exerciseLabels.includes(cvLower)) return true;
  }

  return false;
}

function findConfounders(test: ConditionalTest, joined: JoinedDay[]): string[] {
  // Split the same way the test does
  const trueIndices: number[] = [];
  const falseIndices: number[] = [];
  for (let i = 0; i < joined.length; i++) {
    const day = joined[i];
    if (!day) continue;
    const split = test.splitFn(day, joined, i);
    if (split === true) trueIndices.push(i);
    else if (split === false) falseIndices.push(i);
  }
  if (trueIndices.length < 5 || falseIndices.length < 5) return [];

  const confounders: string[] = [];
  const contextVars = getContextVariables();

  for (const cv of contextVars) {
    // Skip if this variable IS the metric or action being tested
    if (test.metric.toLowerCase().includes(cv.label.toLowerCase())) continue;
    if (test.action.toLowerCase().includes(cv.label.toLowerCase())) continue;
    // Skip if mechanically related (subset/superset)
    if (isRelatedToAction(test.action, cv.label)) continue;

    const trueVals = trueIndices
      .map((i) => {
        const d = joined[i];
        return d ? cv.extract(d) : undefined;
      })
      .filter((v): v is number => v != null);
    const falseVals = falseIndices
      .map((i) => {
        const d = joined[i];
        return d ? cv.extract(d) : undefined;
      })
      .filter((v): v is number => v != null);

    if (trueVals.length < 5 || falseVals.length < 5) continue;

    const d = cohensD(trueVals, falseVals);
    if (Math.abs(d) < 0.3) continue; // only report meaningful differences

    const trueAvg = trueVals.reduce((a, b) => a + b, 0) / trueVals.length;
    const falseAvg = falseVals.reduce((a, b) => a + b, 0) / falseVals.length;
    const direction = trueAvg > falseAvg ? "higher" : "lower";
    const pctDiff = falseAvg !== 0 ? Math.abs((trueAvg - falseAvg) / falseAvg) * 100 : 0;

    const fmtTrue = trueAvg < 10 ? trueAvg.toFixed(1) : Math.round(trueAvg).toString();
    const fmtFalse = falseAvg < 10 ? falseAvg.toFixed(1) : Math.round(falseAvg).toString();

    confounders.push(
      `${cv.label} also ${direction} (${fmtTrue} vs ${fmtFalse}${cv.unit ? ` ${cv.unit}` : ""}, ${pctDiff.toFixed(0)}% diff)`,
    );
  }

  // Deduplicate confounder families: if a parent is present, remove children
  // e.g., if "calories" is flagged, don't also list "protein", "carbs", "fat"
  const families: Array<{ parent: string; children: string[] }> = [
    {
      parent: "calories",
      children: [
        "protein",
        "carbs",
        "fat",
        "fiber",
        "protein % of cal",
        "carb % of cal",
        "fat % of cal",
      ],
    },
    {
      parent: "exercise duration",
      children: ["cardio duration", "strength training duration", "steps", "active calories"],
    },
    { parent: "sleep duration", children: ["deep sleep", "sleep efficiency"] },
  ];

  const presentLabels = new Set(confounders.map((c) => c.split(" also ")[0]));
  const filtered = confounders.filter((c) => {
    const label = c.split(" also ")[0] ?? "";
    for (const fam of families) {
      if (fam.children.includes(label) && presentLabels.has(fam.parent)) return false;
    }
    return true;
  });

  return filtered.slice(0, 5);
}

// ── Human-readable explanation generator ──────────────────────────────────

const metricUnits: Record<string, string> = {
  "next-day HRV": "ms",
  HRV: "ms",
  "next-day resting HR": "bpm",
  "resting HR": "bpm",
  "sleep duration that night": "min",
  "sleep duration": "min",
  "deep sleep that night": "min",
  "deep sleep": "min",
  "sleep efficiency that night": "%",
  "sleep efficiency": "%",
  "monthly weight change": "kg",
  "monthly body fat change": "%",
  "exercise duration": "min",
};

function explainInsight(insight: Omit<Insight, "explanation">): string {
  const { type, action, metric, effectSize, confidence } = insight;
  const unit = metricUnits[metric] ?? "";

  if (type === "conditional") {
    const trueM = insight.whenTrue.mean;
    const falseM = insight.whenFalse.mean;
    const diff = Math.abs(trueM - falseM);
    const higher = trueM > falseM;

    // Make the action phrase read naturally
    const actionPhrase =
      /^\d/.test(action) || action.startsWith(">")
        ? `you have ${action.toLowerCase()}`
        : /day$/.test(action)
          ? `it's a ${action.toLowerCase()}`
          : `you get ${action.toLowerCase()}`;

    const freq =
      confidence === "strong"
        ? "consistently"
        : confidence === "emerging"
          ? "generally"
          : "sometimes";

    // Format the diff value with unit
    const fmtDiff = `${diff < 10 ? diff.toFixed(1) : Math.round(diff)}${unit ? ` ${unit}` : ""}`;

    if (metric.includes("weight change") || metric.includes("body fat change")) {
      const what = metric.includes("weight") ? "weight" : "body fat";
      const unitLabel = metric.includes("weight") ? "kg" : "%";
      // Positive mean = gaining, negative = losing
      const withDesc =
        trueM >= 0 ? `+${trueM.toFixed(2)} ${unitLabel}` : `${trueM.toFixed(2)} ${unitLabel}`;
      const withoutDesc =
        falseM >= 0 ? `+${falseM.toFixed(2)} ${unitLabel}` : `${falseM.toFixed(2)} ${unitLabel}`;
      return `When ${actionPhrase}, your ${what} ${freq} changes by ${withDesc}/mo vs ${withoutDesc}/mo without.`;
    }
    const direction = higher ? "higher" : "lower";
    return `When ${actionPhrase}, your ${metric} is ${freq} ${fmtDiff} ${direction} (${trueM.toFixed(1)} vs ${falseM.toFixed(1)}${unit ? ` ${unit}` : ""}).`;
  }

  if (type === "correlation" || type === "discovery") {
    const moreOrHigher = /calories|volume|frequency|protein|carb|fat|fiber|steps|exercise/.test(
      action,
    )
      ? "More"
      : "Higher";
    const upOrDown = effectSize > 0 ? "higher" : "lower";
    return `${moreOrHigher} ${action} is linked to ${upOrDown} ${metric}.`;
  }

  return "";
}

// ── Main engine ───────────────────────────────────────────────────────────

export function computeInsights(
  metrics: DailyRow[],
  sleep: SleepRow[],
  activities: ActivityRow[],
  nutrition: NutritionRow[] = [],
  bodyComp: BodyCompRow[] = [],
  config: Partial<InsightsConfig> = {},
): Insight[] {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const joined = joinByDate(metrics, sleep, activities, nutrition, bodyComp, cfg);
  if (joined.length < 14) return [];

  const insights: Insight[] = [];

  // 1. Conditional analysis (primary method)
  // Collect all candidates first, then apply FDR correction
  const conditionalCandidates: Array<Insight & { rawPValue: number }> = [];
  for (const test of getConditionalTests()) {
    const trueValues: number[] = [];
    const falseValues: number[] = [];

    for (let i = 0; i < joined.length; i++) {
      const day = joined[i];
      if (!day) continue;
      const split = test.splitFn(day, joined, i);
      if (split == null) continue;

      const value = test.valueFn(day, joined, i);
      if (value == null) continue;

      if (split) {
        trueValues.push(value);
      } else {
        falseValues.push(value);
      }
    }

    const rawMinN = Math.min(trueValues.length, falseValues.length);
    if (rawMinN < 5) continue;

    // For monthly-scoped tests, overlapping 30-day windows inflate sample size.
    // Use effective n (raw n / window size) for confidence classification.
    const effectiveMinN =
      test.scope === "month" ? Math.floor(rawMinN / MONTHLY_WINDOW_SIZE) : rawMinN;
    if (effectiveMinN < 3) continue;

    const d = cohensD(trueValues, falseValues);
    const tResult = welchTTest(trueValues, falseValues);
    const confidence = classifyConfidence(d, effectiveMinN, tResult.pValue);
    if (confidence === "insufficient") continue;

    const trueStats = describe(trueValues);
    const falseStats = describe(falseValues);

    const diff = trueStats.mean - falseStats.mean;
    const baselineNearZero = Math.abs(falseStats.mean) < 1;
    const pctDiff = !baselineNearZero && falseStats.mean !== 0
      ? (diff / Math.abs(falseStats.mean)) * 100
      : 0;
    const direction = diff > 0 ? "higher" : "lower";

    const scopePhrase = test.scope === "month" ? "during months with" : "on days with";
    // Format message: use absolute diff when baseline is near zero, percentage otherwise
    const unit = metricUnits[test.metric] ?? "";
    const diffLabel = baselineNearZero
      ? `${Math.abs(diff).toFixed(2)}${unit ? ` ${unit}` : ""} ${direction}`
      : `${Math.abs(pctDiff).toFixed(0)}% ${direction}`;

    const confounders = findConfounders(test, joined);
    conditionalCandidates.push({
      id: test.id,
      type: "conditional",
      confidence,
      metric: test.metric,
      action: test.action,
      message: `Your ${test.metric} is ${diffLabel} ${scopePhrase} ${test.action}`,
      detail: `${test.action}: avg ${trueStats.mean.toFixed(1)} vs ${falseStats.mean.toFixed(1)} without (n=${trueValues.length}/${falseValues.length})`,
      whenTrue: trueStats,
      whenFalse: falseStats,
      effectSize: d,
      pValue: tResult.pValue,
      confounders: confounders.length > 0 ? confounders : undefined,
      distributions: {
        withAction: downsample(trueValues, MAX_DATA_POINTS),
        withoutAction: downsample(falseValues, MAX_DATA_POINTS),
      },
      rawPValue: tResult.pValue,
    });
  }

  // Apply FDR correction to conditional test p-values
  if (conditionalCandidates.length > 0) {
    const pValues = conditionalCandidates.map((c) => c.rawPValue);
    const significant = benjaminiHochberg(pValues, 0.05);
    for (let i = 0; i < conditionalCandidates.length; i++) {
      const candidate = conditionalCandidates[i];
      if (significant[i] && candidate) {
        const { rawPValue: _, ...insight } = candidate;
        insights.push(insight);
      }
    }
  }

  // 2. Continuous correlations (supplementary)
  const correlationInsights: Array<Insight & { rawPValue: number }> = [];
  for (const pair of getCorrelationPairs()) {
    const xs: number[] = [];
    const ys: number[] = [];
    const indices: number[] = [];

    for (let i = 0; i < joined.length; i++) {
      const day = joined[i];
      if (!day) continue;
      const x = pair.xFn(day, joined, i);
      const y = pair.yFn(day, joined, i);
      if (x != null && y != null) {
        xs.push(x);
        ys.push(y);
        indices.push(i);
      }
    }

    if (xs.length < 15) continue;

    const corr = spearmanCorrelation(xs, ys);
    if (Math.abs(corr.rho) < 0.2) continue;

    const direction = corr.rho > 0 ? "positively" : "negatively";
    const strength =
      Math.abs(corr.rho) >= 0.6 ? "strongly" : Math.abs(corr.rho) >= 0.4 ? "moderately" : "weakly";
    const confounders = findCorrelationConfounders(pair.xName, pair.yName, xs, ys, joined, indices);

    const allPoints: Array<{ x: number; y: number; date: string }> = [];
    for (let j = 0; j < indices.length; j++) {
      const xVal = xs[j];
      const yVal = ys[j];
      const idx = indices[j];
      if (xVal == null || yVal == null || idx == null) continue;
      const joinedDay = joined[idx];
      if (!joinedDay) continue;
      allPoints.push({ x: xVal, y: yVal, date: joinedDay.date });
    }

    correlationInsights.push({
      id: pair.id,
      type: "correlation",
      confidence: classifyCorrelationConfidence(corr.rho, xs.length),
      metric: pair.yName,
      action: pair.xName,
      message: `${pair.xName} is ${strength} ${direction} associated with ${pair.yName}`,
      detail: `Spearman ρ=${corr.rho.toFixed(2)}, n=${corr.n}`,
      whenTrue: describe(ys),
      whenFalse: describe(ys),
      effectSize: corr.rho,
      pValue: corr.pValue,
      correlation: corr,
      confounders: confounders.length > 0 ? confounders : undefined,
      dataPoints: downsample(allPoints, MAX_DATA_POINTS),
      rawPValue: corr.pValue,
    });
  }

  // Apply FDR correction to correlation p-values
  if (correlationInsights.length > 0) {
    const pValues = correlationInsights.map((c) => c.rawPValue);
    const significant = benjaminiHochberg(pValues, 0.05);
    for (let i = 0; i < correlationInsights.length; i++) {
      const ci = correlationInsights[i];
      if (significant[i] && ci) {
        const { rawPValue: _, ...insight } = ci;
        insights.push(insight);
      }
    }
  }

  // 3. Monthly body comp / nutrition insights
  const monthlyInsights = computeMonthlyInsights(joined);
  insights.push(...monthlyInsights);

  // 4. Exhaustive pairwise discovery sweep
  const existingIds = new Set(insights.map((i) => `${i.action}::${i.metric}`));
  const discoveryInsights = exhaustiveSweep(joined, existingIds);
  insights.push(...discoveryInsights);

  // Sort: strong first, then by absolute effect size
  const confidenceOrder: Record<ConfidenceLevel, number> = {
    strong: 0,
    emerging: 1,
    early: 2,
    insufficient: 3,
  };
  insights.sort(
    (a, b) =>
      confidenceOrder[a.confidence] - confidenceOrder[b.confidence] ||
      Math.abs(b.effectSize) - Math.abs(a.effectSize),
  );

  // Cap at 20 most significant insights to avoid noise
  const top = insights.slice(0, 20);
  // Add human-readable explanations
  for (const insight of top) {
    insight.explanation = explainInsight(insight);
  }
  return top;
}
