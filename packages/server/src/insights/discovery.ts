import { classifyCorrelationConfidence, downsample, MAX_DATA_POINTS } from "./confidence.ts";
import type { JoinedDay } from "./data-join.ts";
import { benjaminiHochberg, describe, spearmanCorrelation } from "./stats.ts";
import type { Insight } from "./types.ts";

// ── Exhaustive pairwise discovery ──────────────────────────────────────────

/**
 * Causal role for direction constraints in discovery sweep.
 * - "action": controllable inputs (nutrition, exercise) — valid as X (predictor)
 * - "outcome": measured outputs (HRV, resting HR, body comp) — valid as Y (response)
 * - "bidirectional": can be either (sleep — affected by actions, but also affects outcomes)
 */
export type CausalRole = "action" | "outcome" | "bidirectional";

export interface MetricDef {
  key: string;
  label: string;
  role: CausalRole;
  extract: (day: JoinedDay, allDays: JoinedDay[], idx: number) => number | null;
}

export function getAllMetrics(): MetricDef[] {
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
export function isValidCausalDirection(xRole: CausalRole, yRole: CausalRole, lag: number): boolean {
  // outcome→action: always invalid (backwards causality)
  if (xRole === "outcome" && yRole === "action") return false;
  // outcome→outcome: only same-day (lag 0) — not lagged prediction
  if (xRole === "outcome" && yRole === "outcome" && lag > 0) return false;
  return true;
}

const MAX_LAG = 2;
const MIN_SAMPLES = 20;
const MIN_RHO = 0.15;

export function exhaustiveSweep(joined: JoinedDay[], existingIds: Set<string>): Insight[] {
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
          const xValue = mx.extract(dayX, joined, i);
          const yValue = my.extract(dayY, joined, i + lag);
          if (xValue != null && yValue != null) {
            xs.push(xValue);
            ys.push(yValue);
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
    const candidate = candidates[i];
    if (!significant[i] || !candidate) continue;
    const absRho = Math.abs(candidate.rho);
    const direction = candidate.rho > 0 ? "positively" : "negatively";
    const strength = absRho >= 0.6 ? "strongly" : absRho >= 0.4 ? "moderately" : "";
    const lagText =
      candidate.lag === 0
        ? "same day"
        : candidate.lag === 1
          ? "next day"
          : `${candidate.lag} days later`;
    const confidence = classifyCorrelationConfidence(candidate.rho, candidate.n);

    const yWithLag = candidate.lag > 0 ? `${lagText} ${candidate.yLabel}` : candidate.yLabel;

    discoveries.push({
      id: candidate.id,
      type: "discovery",
      confidence,
      metric: candidate.yLabel,
      action: candidate.xLabel,
      message: `${candidate.xLabel} is ${strength ? `${strength} ` : ""}${direction} associated with ${yWithLag}`,
      detail: `Spearman ρ=${candidate.rho.toFixed(2)}, ${lagText}, n=${candidate.n}`,
      whenTrue: describe([]),
      whenFalse: describe([]),
      effectSize: candidate.rho,
      pValue: candidate.pValue,
      correlation: { rho: candidate.rho, pValue: candidate.pValue, n: candidate.n },
      dataPoints: candidate.dataPoints,
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
