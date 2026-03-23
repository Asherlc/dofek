/**
 * Stress scoring: daily stress from HRV/RHR deviation and sleep quality.
 *
 * Replicates Whoop's 0-3 stress scale using z-score deviations from
 * personal 60-day baselines. Pure functions with no database dependencies.
 */

// ── Types ────────────────────────────────────────────────────────

export interface StressThresholds {
  /** HRV z-score thresholds [high, medium, low] (all negative, more negative = more stress) */
  hrvThresholds: [number, number, number];
  /** RHR z-score thresholds [high, medium, low] (all positive, higher = more stress) */
  rhrThresholds: [number, number, number];
}

export interface DailyStressInput {
  /** HRV z-score vs 60-day baseline (negative = below baseline = stressed) */
  hrvDeviation: number | null;
  /** Resting HR z-score vs 60-day baseline (positive = above baseline = stressed) */
  restingHrDeviation: number | null;
  /** Sleep efficiency percentage from previous night */
  sleepEfficiency: number | null;
}

export interface DailyStressResult {
  /** Stress score 0-3 (Whoop scale) */
  stressScore: number;
}

export interface WeeklyStressRow {
  weekStart: string;
  cumulativeStress: number;
  avgDailyStress: number;
  highStressDays: number;
}

// ── Default thresholds ──────────────────────────────────────────

export function defaultStressThresholds(): StressThresholds {
  return {
    hrvThresholds: [-2.0, -1.5, -1.0],
    rhrThresholds: [2.0, 1.5, 1.0],
  };
}

// ── Daily stress computation ────────────────────────────────────

/**
 * Compute a daily stress score from HRV deviation, RHR deviation, and sleep efficiency.
 *
 * Stress components:
 * - HRV below baseline (negative z-score → 0-1.5 stress)
 * - Resting HR above baseline (positive z-score → 0-1.0 stress)
 * - Poor sleep efficiency (< 85% → 0-0.5 stress)
 *
 * Score: 0 (no stress) to 3 (high stress), matching Whoop's scale.
 */
export function computeDailyStress(
  input: DailyStressInput,
  thresholds: StressThresholds,
): DailyStressResult {
  const [hrvHigh, hrvMed, hrvLow] = thresholds.hrvThresholds;
  const [rhrHigh, rhrMed, rhrLow] = thresholds.rhrThresholds;

  // HRV stress: more negative z-score = more stress
  let hrvStress = 0;
  if (input.hrvDeviation != null) {
    if (input.hrvDeviation < hrvHigh) hrvStress = 1.5;
    else if (input.hrvDeviation < hrvMed) hrvStress = 1.2;
    else if (input.hrvDeviation < hrvLow) hrvStress = 0.8;
    else if (input.hrvDeviation < 0) hrvStress = 0.3;
  }

  // RHR stress: more positive z-score = more stress
  let rhrStress = 0;
  if (input.restingHrDeviation != null) {
    if (input.restingHrDeviation > rhrHigh) rhrStress = 1.0;
    else if (input.restingHrDeviation > rhrMed) rhrStress = 0.8;
    else if (input.restingHrDeviation > rhrLow) rhrStress = 0.5;
    else if (input.restingHrDeviation > 0) rhrStress = 0.2;
  }

  // Sleep stress: poor sleep = residual stress
  let sleepStress = 0;
  if (input.sleepEfficiency != null) {
    if (input.sleepEfficiency < 70) sleepStress = 0.5;
    else if (input.sleepEfficiency < 80) sleepStress = 0.3;
    else if (input.sleepEfficiency < 85) sleepStress = 0.1;
  }

  // Composite: cap at 3.0
  const raw = hrvStress + rhrStress + sleepStress;
  const stressScore = Math.min(3, Math.round(raw * 10) / 10);

  return { stressScore };
}

// ── Weekly aggregation ──────────────────────────────────────────

/**
 * Aggregate daily stress scores into ISO weeks (Monday-start).
 */
export function aggregateWeeklyStress(
  daily: { date: string; stressScore: number }[],
): WeeklyStressRow[] {
  const weekMap = new Map<string, { scores: number[]; highDays: number }>();

  for (const d of daily) {
    // Parse as local date to avoid UTC timezone shifts
    const [year, month, day] = d.date.split("-").map(Number);
    const date = new Date(year ?? 0, (month ?? 1) - 1, day ?? 1);
    const dayOfWeek = date.getDay();
    const diff = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
    const monday = new Date(date);
    monday.setDate(date.getDate() - diff);
    const weekKey = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, "0")}-${String(monday.getDate()).padStart(2, "0")}`;

    const existing = weekMap.get(weekKey) ?? { scores: [], highDays: 0 };
    existing.scores.push(d.stressScore);
    if (d.stressScore >= 2) existing.highDays++;
    weekMap.set(weekKey, existing);
  }

  return Array.from(weekMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([weekStart, data]) => ({
      weekStart,
      cumulativeStress: Math.round(data.scores.reduce((s, v) => s + v, 0) * 10) / 10,
      avgDailyStress:
        Math.round((data.scores.reduce((s, v) => s + v, 0) / data.scores.length) * 100) / 100,
      highStressDays: data.highDays,
    }));
}

// ── Trend ───────────────────────────────────────────────────────

/**
 * Compare last 7 days avg stress to previous 7 days.
 * Requires at least 14 days of data.
 */
export function computeStressTrend(
  daily: { stressScore: number }[],
): "improving" | "worsening" | "stable" {
  if (daily.length < 14) return "stable";

  const last7 = daily.slice(-7);
  const prev7 = daily.slice(-14, -7);
  const avgLast = last7.reduce((s, d) => s + d.stressScore, 0) / 7;
  const avgPrev = prev7.reduce((s, d) => s + d.stressScore, 0) / 7;
  const diff = avgLast - avgPrev;

  if (diff < -0.3) return "improving";
  if (diff > 0.3) return "worsening";
  return "stable";
}
