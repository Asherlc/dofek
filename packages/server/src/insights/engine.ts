import { getConditionalTests } from "./conditional-tests.ts";
import {
  classifyConfidence,
  classifyCorrelationConfidence,
  downsample,
  MAX_DATA_POINTS,
  MONTHLY_WINDOW_SIZE,
} from "./confidence.ts";
import { findConfounders, findCorrelationConfounders } from "./confounders.ts";
import { getCorrelationPairs } from "./correlation-pairs.ts";
import { joinByDate } from "./data-join.ts";
import { exhaustiveSweep } from "./discovery.ts";
import { explainInsight, metricUnits } from "./explanation.ts";
import { computeMonthlyInsights } from "./monthly.ts";
import { benjaminiHochberg, cohensD, describe, spearmanCorrelation, welchTTest } from "./stats.ts";
import {
  type ActivityRow,
  type BodyCompRow,
  type ConfidenceLevel,
  type DailyRow,
  DEFAULT_CONFIG,
  type Insight,
  type InsightsConfig,
  type NutritionRow,
  type SleepRow,
} from "./types.ts";

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

    const effectSize = cohensD(trueValues, falseValues);
    const tResult = welchTTest(trueValues, falseValues);
    const confidence = classifyConfidence(effectSize, effectiveMinN, tResult.pValue);
    if (confidence === "insufficient") continue;

    const trueStats = describe(trueValues);
    const falseStats = describe(falseValues);

    const diff = trueStats.mean - falseStats.mean;
    const baselineNearZero = Math.abs(falseStats.mean) < 1;
    const pctDiff =
      !baselineNearZero && falseStats.mean !== 0 ? (diff / Math.abs(falseStats.mean)) * 100 : 0;
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
      effectSize: effectSize,
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
      const xValue = pair.xFn(day, joined, i);
      const yValue = pair.yFn(day, joined, i);
      if (xValue != null && yValue != null) {
        xs.push(xValue);
        ys.push(yValue);
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
