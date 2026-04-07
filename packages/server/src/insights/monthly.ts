import { classifyConfidence, classifyCorrelationConfidence } from "./confidence.ts";
import type { JoinedDay } from "./data-join.ts";
import { cohensD, describe, spearmanCorrelation, welchTTest } from "./stats.ts";
import type { Insight } from "./types.ts";

// ── Monthly aggregation for body comp / nutrition ─────────────────────────

export interface MonthlyAgg {
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

export function aggregateMonthly(joined: JoinedDay[]): MonthlyAgg[] {
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

export function getMonthlyCorrelations(): MonthlyCorrelationPair[] {
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

export function computeMonthlyInsights(joined: JoinedDay[]): Insight[] {
  const months = aggregateMonthly(joined);
  if (months.length < 5) return [];

  const insights: Insight[] = [];

  // Monthly correlations
  for (const pair of getMonthlyCorrelations()) {
    const xs: number[] = [];
    const ys: number[] = [];

    for (const m of months) {
      const xValue = pair.xFn(m);
      const yValue = pair.yFn(m);
      if (xValue != null && yValue != null) {
        xs.push(xValue);
        ys.push(yValue);
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
        const effectSize = cohensD(highWeightDeltas, lowWeightDeltas);
        const conf = classifyConfidence(
          effectSize,
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
            effectSize: effectSize,
            pValue: tResult.pValue,
          });
        }
      }
    }
  }

  return insights;
}
