import {
  benjaminiHochberg,
  type CorrelationResult,
  cohensD,
  type DescriptiveStats,
  describe,
  spearmanCorrelation,
  welchTTest,
} from "./stats.js";

// ── Types ─────────────────────────────────────────────────────────────────

export interface DailyRow {
  date: string;
  resting_hr: number | null;
  hrv: number | null;
  spo2_avg: number | null;
  steps: number | null;
  active_energy_kcal: number | null;
  skin_temp_c: number | null;
}

export interface SleepRow {
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
  started_at: string;
  ended_at: string | null;
  activity_type: string;
}

export type ConfidenceLevel = "strong" | "emerging" | "early" | "insufficient";

export interface Insight {
  id: string;
  type: "conditional" | "correlation" | "trend";
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
}

// ── Confidence classification ─────────────────────────────────────────────

function classifyConfidence(d: number, minN: number): ConfidenceLevel {
  const absD = Math.abs(d);
  if (absD >= 0.8 && minN >= 30) return "strong";
  if (absD >= 0.5 && minN >= 15) return "emerging";
  if (absD >= 0.3 && minN >= 10) return "early";
  return "insufficient";
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
}

function joinByDate(
  metrics: DailyRow[],
  sleep: SleepRow[],
  activities: ActivityRow[],
): JoinedDay[] {
  const metricsByDate = new Map(metrics.map((m) => [m.date, m]));

  // Sleep: assign to the date the person woke up (next day from started_at)
  const sleepByWakeDate = new Map<string, SleepRow>();
  for (const s of sleep) {
    if (s.is_nap) continue;
    const wakeDate = new Date(s.started_at);
    // Sleep started_at is bedtime; add duration to get wake time
    if (s.duration_minutes) {
      wakeDate.setMinutes(wakeDate.getMinutes() + s.duration_minutes);
    }
    const dateStr = wakeDate.toISOString().slice(0, 10);
    // Keep the longest sleep per wake date
    const existing = sleepByWakeDate.get(dateStr);
    if (!existing || (s.duration_minutes ?? 0) > (existing.duration_minutes ?? 0)) {
      sleepByWakeDate.set(dateStr, s);
    }
  }

  // Activities: sum duration per date
  const activityByDate = new Map<string, { minutes: number }>();
  for (const a of activities) {
    const dateStr = new Date(a.started_at).toISOString().slice(0, 10);
    const existing = activityByDate.get(dateStr) ?? { minutes: 0 };
    if (a.ended_at) {
      const dur = (new Date(a.ended_at).getTime() - new Date(a.started_at).getTime()) / 60000;
      existing.minutes += dur;
    }
    activityByDate.set(dateStr, existing);
  }

  const joined: JoinedDay[] = [];
  for (const [date, m] of metricsByDate) {
    const s = sleepByWakeDate.get(date);
    const a = activityByDate.get(date);
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
    });
  }

  return joined.sort((a, b) => a.date.localeCompare(b.date));
}

// ── Conditional analysis ──────────────────────────────────────────────────

interface ConditionalTest {
  id: string;
  action: string;
  metric: string;
  splitFn: (day: JoinedDay, allDays: JoinedDay[], idx: number) => boolean | null;
  valueFn: (day: JoinedDay, allDays: JoinedDay[], idx: number) => number | null;
}

function getConditionalTests(): ConditionalTest[] {
  return [
    // Sleep duration → next-day HRV
    {
      id: "sleep-7h-hrv",
      action: "7+ hours of sleep",
      metric: "next-day HRV",
      splitFn: (d) => (d.sleep_duration_min != null ? d.sleep_duration_min >= 420 : null),
      valueFn: (_d, all, i) => all[i + 1]?.hrv ?? null,
    },
    // Sleep duration → next-day resting HR
    {
      id: "sleep-7h-rhr",
      action: "7+ hours of sleep",
      metric: "next-day resting HR",
      splitFn: (d) => (d.sleep_duration_min != null ? d.sleep_duration_min >= 420 : null),
      valueFn: (_d, all, i) => all[i + 1]?.resting_hr ?? null,
    },
    // Deep sleep > 60min → next-day HRV
    {
      id: "deep-60-hrv",
      action: "60+ min deep sleep",
      metric: "next-day HRV",
      splitFn: (d) => (d.deep_min != null ? d.deep_min >= 60 : null),
      valueFn: (_d, all, i) => all[i + 1]?.hrv ?? null,
    },
    // Exercise → same-night sleep duration
    {
      id: "exercise-30-sleep",
      action: "30+ min exercise",
      metric: "sleep duration that night",
      splitFn: (d) => (d.exercise_minutes != null ? d.exercise_minutes >= 30 : null),
      valueFn: (_d, all, i) => all[i + 1]?.sleep_duration_min ?? null,
    },
    // Exercise → next-day HRV
    {
      id: "exercise-30-hrv",
      action: "30+ min exercise",
      metric: "next-day HRV",
      splitFn: (d) => (d.exercise_minutes != null ? d.exercise_minutes >= 30 : null),
      valueFn: (_d, all, i) => all[i + 1]?.hrv ?? null,
    },
    // High steps (10k+) → next-day HRV
    {
      id: "steps-10k-hrv",
      action: "10,000+ steps",
      metric: "next-day HRV",
      splitFn: (d) => (d.steps != null ? d.steps >= 10000 : null),
      valueFn: (_d, all, i) => all[i + 1]?.hrv ?? null,
    },
    // High active energy → same-night sleep efficiency
    {
      id: "active-500-sleep-eff",
      action: "500+ active kcal",
      metric: "sleep efficiency that night",
      splitFn: (d) => (d.active_energy_kcal != null ? d.active_energy_kcal >= 500 : null),
      valueFn: (_d, all, i) => all[i + 1]?.sleep_efficiency ?? null,
    },
    // Sleep consistency (stddev of duration over rolling 7 days)
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
    // REM sleep > 90min → next-day HRV
    {
      id: "rem-90-hrv",
      action: "90+ min REM sleep",
      metric: "next-day HRV",
      splitFn: (d) => (d.rem_min != null ? d.rem_min >= 90 : null),
      valueFn: (_d, all, i) => all[i + 1]?.hrv ?? null,
    },
  ];
}

// ── Correlation pairs ─────────────────────────────────────────────────────

interface CorrelationPair {
  id: string;
  xName: string;
  yName: string;
  xFn: (day: JoinedDay) => number | null;
  yFn: (day: JoinedDay, allDays: JoinedDay[], idx: number) => number | null;
}

function getCorrelationPairs(): CorrelationPair[] {
  return [
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
  ];
}

// ── Main engine ───────────────────────────────────────────────────────────

export function computeInsights(
  metrics: DailyRow[],
  sleep: SleepRow[],
  activities: ActivityRow[],
): Insight[] {
  const joined = joinByDate(metrics, sleep, activities);
  if (joined.length < 14) return [];

  const insights: Insight[] = [];

  // 1. Conditional analysis (primary method)
  for (const test of getConditionalTests()) {
    const trueValues: number[] = [];
    const falseValues: number[] = [];

    for (let i = 0; i < joined.length; i++) {
      const split = test.splitFn(joined[i], joined, i);
      if (split == null) continue;

      const value = test.valueFn(joined[i], joined, i);
      if (value == null) continue;

      if (split) {
        trueValues.push(value);
      } else {
        falseValues.push(value);
      }
    }

    const minN = Math.min(trueValues.length, falseValues.length);
    if (minN < 5) continue;

    const d = cohensD(trueValues, falseValues);
    const confidence = classifyConfidence(d, minN);
    if (confidence === "insufficient") continue;

    const tResult = welchTTest(trueValues, falseValues);
    const trueStats = describe(trueValues);
    const falseStats = describe(falseValues);

    const pctDiff =
      falseStats.mean !== 0
        ? ((trueStats.mean - falseStats.mean) / Math.abs(falseStats.mean)) * 100
        : 0;
    const direction = pctDiff > 0 ? "higher" : "lower";
    const absPct = Math.abs(pctDiff).toFixed(0);

    insights.push({
      id: test.id,
      type: "conditional",
      confidence,
      metric: test.metric,
      action: test.action,
      message: `Your ${test.metric} is ${absPct}% ${direction} on days with ${test.action}`,
      detail: `${test.action}: avg ${trueStats.mean.toFixed(1)} vs ${falseStats.mean.toFixed(1)} without (n=${trueValues.length}/${falseValues.length})`,
      whenTrue: trueStats,
      whenFalse: falseStats,
      effectSize: d,
      pValue: tResult.pValue,
    });
  }

  // 2. Continuous correlations (supplementary)
  const correlationInsights: Array<Insight & { rawPValue: number }> = [];
  for (const pair of getCorrelationPairs()) {
    const xs: number[] = [];
    const ys: number[] = [];

    for (let i = 0; i < joined.length; i++) {
      const x = pair.xFn(joined[i]);
      const y = pair.yFn(joined[i], joined, i);
      if (x != null && y != null) {
        xs.push(x);
        ys.push(y);
      }
    }

    if (xs.length < 15) continue;

    const corr = spearmanCorrelation(xs, ys);
    if (Math.abs(corr.rho) < 0.2) continue;

    const direction = corr.rho > 0 ? "positively" : "negatively";
    const strength =
      Math.abs(corr.rho) >= 0.6 ? "strongly" : Math.abs(corr.rho) >= 0.4 ? "moderately" : "weakly";

    correlationInsights.push({
      id: pair.id,
      type: "correlation",
      confidence: Math.abs(corr.rho) >= 0.5 && xs.length >= 30 ? "strong" : "emerging",
      metric: pair.yName,
      action: pair.xName,
      message: `${pair.xName} is ${strength} ${direction} associated with ${pair.yName}`,
      detail: `Spearman ρ=${corr.rho.toFixed(2)}, n=${corr.n}`,
      whenTrue: describe(ys),
      whenFalse: describe(ys), // same for correlations
      effectSize: corr.rho,
      pValue: corr.pValue,
      correlation: corr,
      rawPValue: corr.pValue,
    });
  }

  // Apply FDR correction to correlation p-values
  if (correlationInsights.length > 0) {
    const pValues = correlationInsights.map((c) => c.rawPValue);
    const significant = benjaminiHochberg(pValues, 0.05);
    for (let i = 0; i < correlationInsights.length; i++) {
      if (significant[i]) {
        const { rawPValue: _, ...insight } = correlationInsights[i];
        insights.push(insight);
      }
    }
  }

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

  return insights;
}
