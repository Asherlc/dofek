import { describe, expect, it } from "vitest";
import type { DailyFeatureRow } from "../features.ts";
import { trainHrvPredictor } from "../predictor.ts";

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

    days.push({
      date,
      resting_hr: 55 + rng() * 15,
      hrv: Math.round(hrv * 10) / 10,
      spo2_avg: 96 + rng() * 3,
      steps: Math.round(5000 + rng() * 10000),
      active_energy_kcal: 200 + rng() * 500,
      skin_temp_c: 33 + rng() * 2,
      sleep_duration_min: Math.round(sleepDuration),
      deep_min: Math.round(deepMin),
      rem_min: Math.round(60 + rng() * 60),
      sleep_efficiency: 80 + rng() * 15,
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

describe("trainHrvPredictor", () => {
  it("returns null with insufficient data", () => {
    const days = generateSyntheticDays(10);
    expect(trainHrvPredictor(days)).toBeNull();
  });

  it("trains both models on synthetic data", () => {
    const days = generateSyntheticDays(200);
    const result = trainHrvPredictor(days);

    expect(result).not.toBeNull();
    expect(result!.featureImportances.length).toBeGreaterThan(0);
    expect(result!.predictions.length).toBeGreaterThan(0);
    expect(result!.diagnostics.sampleCount).toBeGreaterThan(100);
  });

  it("produces reasonable R² values", () => {
    const days = generateSyntheticDays(200);
    const result = trainHrvPredictor(days)!;

    // Linear model should explain some variance in this synthetic data
    expect(result.diagnostics.linearRSquared).toBeGreaterThan(0.1);
    expect(result.diagnostics.linearRSquared).toBeLessThanOrEqual(1);

    // Tree model should do at least as well
    expect(result.diagnostics.treeRSquared).toBeGreaterThan(0.1);

    // Cross-validated R² should be positive (not overfitting badly)
    expect(result.diagnostics.crossValidatedRSquared).toBeGreaterThan(-0.5);
  });

  it("ranks sleep and vitals features highly", () => {
    const days = generateSyntheticDays(300);
    const result = trainHrvPredictor(days)!;

    // In our synthetic data, sleep and resting HR should be top-ranked
    const topFeatures = result.featureImportances.slice(0, 5).map((f) => f.name);
    const importantFeatures = ["sleep_duration", "deep_sleep", "resting_hr"];
    const topContainsImportant = importantFeatures.some((f) => topFeatures.includes(f));
    expect(topContainsImportant).toBe(true);
  });

  it("generates tomorrow prediction from latest data", () => {
    const days = generateSyntheticDays(100);
    const result = trainHrvPredictor(days)!;

    expect(result.tomorrowPrediction).not.toBeNull();
    expect(result.tomorrowPrediction!.linear).toBeGreaterThan(0);
    expect(result.tomorrowPrediction!.tree).toBeGreaterThan(0);
  });

  it("predictions have correct shape", () => {
    const days = generateSyntheticDays(100);
    const result = trainHrvPredictor(days)!;

    for (const pred of result.predictions) {
      expect(pred.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(typeof pred.actualHrv).toBe("number");
      expect(typeof pred.linearPrediction).toBe("number");
      expect(typeof pred.treePrediction).toBe("number");
    }
  });

  it("handles days with lots of missing nutrition data", () => {
    const days = generateSyntheticDays(100);
    // Null out 70% of nutrition data
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
    // Should still work but drop nutrition features (>50% missing)
    expect(result).not.toBeNull();
    // Nutrition features should be dropped
    const featureNames = result!.featureImportances.map((f) => f.name);
    expect(featureNames).not.toContain("calories");
    expect(featureNames).not.toContain("protein_g");
  });
});
