import { describe, expect, it } from "vitest";
import type { DailyFeatureRow } from "./features.ts";
import { PREDICTION_TARGETS } from "./features.ts";
import { trainHrvPredictor, trainPredictor } from "./predictor.ts";

function mulberry32(seed: number): () => number {
  let s = seed;
  return () => {
    s |= 0;
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateSyntheticDays(n: number, seed: number = 42): DailyFeatureRow[] {
  const rng = mulberry32(seed);
  const days: DailyFeatureRow[] = [];

  for (let i = 0; i < n; i++) {
    const date = new Date(2024, 0, 1 + i).toISOString().slice(0, 10);
    const sleepDuration = 360 + rng() * 180; // 6-9 hours
    const deepMin = 40 + rng() * 60;
    const exerciseMin = rng() > 0.3 ? 30 + rng() * 60 : 0;
    const protein = 80 + rng() * 80;

    // HRV is a function of sleep + exercise + protein + noise
    const hrv =
      40 +
      sleepDuration * 0.05 +
      deepMin * 0.1 +
      (exerciseMin > 0 ? -5 : 0) + // exercise suppresses next-day HRV slightly
      protein * 0.02 +
      (rng() - 0.5) * 10; // noise

    // Resting HR inversely related to sleep quality
    const restingHr = 75 - sleepDuration * 0.02 - deepMin * 0.05 + (rng() - 0.5) * 8;

    // Sleep efficiency driven by exercise and nutrition
    const sleepEfficiency = 75 + exerciseMin * 0.08 + protein * 0.02 + (rng() - 0.5) * 10;

    days.push({
      date,
      resting_hr: Math.round(restingHr * 10) / 10,
      hrv: Math.round(hrv * 10) / 10,
      spo2_avg: 96 + rng() * 3,
      steps: Math.round(5000 + rng() * 10000),
      active_energy_kcal: 200 + rng() * 500,
      skin_temp_c: 33 + rng() * 2,
      sleep_duration_min: Math.round(sleepDuration),
      deep_min: Math.round(deepMin),
      rem_min: Math.round(60 + rng() * 60),
      sleep_efficiency: Math.min(100, Math.round(sleepEfficiency * 10) / 10),
      exercise_minutes: Math.round(exerciseMin),
      cardio_minutes: Math.round(exerciseMin * 0.6),
      strength_minutes: Math.round(exerciseMin * 0.4),
      calories: Math.round(1800 + rng() * 1200),
      protein_g: Math.round(protein),
      carbs_g: Math.round(150 + rng() * 200),
      fat_g: Math.round(50 + rng() * 80),
      fiber_g: Math.round(15 + rng() * 25),
      weight_kg: 75 + rng() * 5,
    });
  }
  return days;
}

describe("trainHrvPredictor (legacy wrapper)", () => {
  it("returns null with insufficient data", () => {
    const days = generateSyntheticDays(10);
    expect(trainHrvPredictor(days)).toBeNull();
  });

  it("trains both models on synthetic data", () => {
    const days = generateSyntheticDays(200);
    const result = trainHrvPredictor(days);

    expect(result).not.toBeNull();
    expect(result?.targetId).toBe("hrv");
    expect(result?.featureImportances.length).toBeGreaterThan(0);
    expect(result?.predictions.length).toBeGreaterThan(0);
    expect(result?.diagnostics.sampleCount).toBeGreaterThan(100);
  });

  it("produces reasonable R² values", () => {
    const days = generateSyntheticDays(200);
    const result = trainHrvPredictor(days);
    if (!result) throw new Error("expected result");

    expect(result.diagnostics.linearRSquared).toBeGreaterThan(0.01);
    expect(result.diagnostics.linearRSquared).toBeLessThanOrEqual(1);
    expect(result.diagnostics.treeRSquared).toBeGreaterThan(0.1);
    expect(result.diagnostics.crossValidatedRSquared).toBeGreaterThan(-0.5);
  });

  it("ranks sleep features highly for HRV", () => {
    const days = generateSyntheticDays(300);
    const result = trainHrvPredictor(days);
    if (!result) throw new Error("expected result");

    const topFeatures = result.featureImportances.slice(0, 5).map((f) => f.name);
    const importantFeatures = ["sleep_duration", "deep_sleep"];
    const topContainsImportant = importantFeatures.some((f) => topFeatures.includes(f));
    expect(topContainsImportant).toBe(true);
  });

  it("excludes hrv and resting_hr from HRV features", () => {
    const days = generateSyntheticDays(200);
    const result = trainHrvPredictor(days);
    if (!result) throw new Error("expected result");

    const featureNames = result.featureImportances.map((f) => f.name);
    expect(featureNames).not.toContain("hrv");
    expect(featureNames).not.toContain("resting_hr");
  });

  it("generates tomorrow prediction from latest data", () => {
    const days = generateSyntheticDays(100);
    const result = trainHrvPredictor(days);
    if (!result) throw new Error("expected result");

    expect(result.tomorrowPrediction).not.toBeNull();
    expect(result.tomorrowPrediction?.linear).toBeGreaterThan(0);
    expect(result.tomorrowPrediction?.tree).toBeGreaterThan(0);
  });

  it("predictions have correct shape", () => {
    const days = generateSyntheticDays(100);
    const result = trainHrvPredictor(days);
    if (!result) throw new Error("expected result");

    for (const pred of result.predictions) {
      expect(pred.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof pred.actual).toBe("number");
      expect(typeof pred.linearPrediction).toBe("number");
      expect(typeof pred.treePrediction).toBe("number");
    }
  });

  it("is deterministic for a fixed seed and preserves date alignment", () => {
    const days = generateSyntheticDays(200, 42);
    const result = trainHrvPredictor(days);
    if (!result) throw new Error("expected result");

    expect(result.diagnostics).toEqual({
      linearRSquared: 0.0809,
      linearAdjustedRSquared: 0.0001,
      treeRSquared: 0.7988,
      crossValidatedRSquared: -0.1498,
      sampleCount: 199,
      featureCount: 16,
      linearFallbackUsed: false,
    });

    expect(result.predictions[0]).toEqual({
      date: "2024-01-01",
      actual: 57.7,
      linearPrediction: 67.04,
      treePrediction: 62.95,
    });
    expect(result.predictions[50]).toEqual({
      date: "2024-02-20",
      actual: 70.5,
      linearPrediction: 68.21,
      treePrediction: 69.78,
    });
    expect(result.tomorrowPrediction).toEqual({ linear: 68.29, tree: 68.51 });
    expect(result.featureImportances[0]?.name).toBe("weight_kg");
    expect(result.featureImportances[0]?.treeImportance).toBeCloseTo(0.1460034569, 8);
    expect(
      result.featureImportances.some(
        (feature) => feature.linearCoefficient !== 0 && feature.linearImportance > 0,
      ),
    ).toBe(true);

    for (let i = 0; i < result.predictions.length; i++) {
      const prediction = result.predictions[i];
      const sourceDay = days[i];
      if (!prediction || !sourceDay) continue;
      expect(prediction.date).toBe(sourceDay.date);
    }
  });

  it("returns null when HRV target is unavailable", () => {
    const originalTargets = [...PREDICTION_TARGETS];
    PREDICTION_TARGETS.splice(
      0,
      PREDICTION_TARGETS.length,
      ...originalTargets.filter((target) => target.id !== "hrv"),
    );

    try {
      const days = generateSyntheticDays(200);
      expect(trainHrvPredictor(days)).toBeNull();
    } finally {
      PREDICTION_TARGETS.splice(0, PREDICTION_TARGETS.length, ...originalTargets);
    }
  });

  it("handles days with lots of missing nutrition data", () => {
    const days = generateSyntheticDays(100);
    const rng = mulberry32(99);
    for (const day of days) {
      if (rng() > 0.3) {
        day.calories = null;
        day.protein_g = null;
        day.carbs_g = null;
        day.fat_g = null;
        day.fiber_g = null;
      }
    }

    const result = trainHrvPredictor(days);
    expect(result).not.toBeNull();
    const featureNames = result?.featureImportances.map((f) => f.name);
    expect(featureNames).not.toContain("calories");
    expect(featureNames).not.toContain("protein_g");
  });
});

describe("trainPredictor (multi-target)", () => {
  it("trains resting HR prediction", () => {
    const target = PREDICTION_TARGETS.find((t) => t.id === "resting_hr");
    if (!target) throw new Error("expected resting_hr target");
    const days = generateSyntheticDays(200);
    const result = trainPredictor(days, target);

    expect(result).not.toBeNull();
    expect(result?.targetId).toBe("resting_hr");
    expect(result?.targetLabel).toBe("Resting Heart Rate");
    expect(result?.targetUnit).toBe("bpm");

    // Should not include resting_hr or hrv as features
    const featureNames = result?.featureImportances.map((f) => f.name);
    expect(featureNames).not.toContain("resting_hr");
    expect(featureNames).not.toContain("hrv");
  });

  it("trains sleep efficiency prediction", () => {
    const target = PREDICTION_TARGETS.find((t) => t.id === "sleep_efficiency");
    if (!target) throw new Error("expected sleep_efficiency target");
    const days = generateSyntheticDays(200);
    const result = trainPredictor(days, target);

    expect(result).not.toBeNull();
    expect(result?.targetId).toBe("sleep_efficiency");

    // Should not include any sleep metrics as features
    const featureNames = result?.featureImportances.map((f) => f.name);
    expect(featureNames).not.toContain("sleep_efficiency");
    expect(featureNames).not.toContain("sleep_duration");
    expect(featureNames).not.toContain("deep_sleep");
    expect(featureNames).not.toContain("rem_sleep");
  });

  it("includes target metadata in results", () => {
    for (const target of PREDICTION_TARGETS) {
      const days = generateSyntheticDays(100);
      const result = trainPredictor(days, target);
      if (!result) continue;

      expect(result.targetId).toBe(target.id);
      expect(result.targetLabel).toBe(target.label);
      expect(result.targetUnit).toBe(target.unit);
    }
  });
});
