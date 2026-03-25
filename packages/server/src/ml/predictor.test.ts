import { describe, expect, it } from "vitest";
import type { DailyFeatureRow, ExtractedDataset } from "./features.ts";
import { PREDICTION_TARGETS } from "./features.ts";
import { trainFromDataset, trainHrvPredictor, trainPredictor } from "./predictor.ts";

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
    const days = generateSyntheticDays(60);
    const result = trainHrvPredictor(days);

    expect(result).not.toBeNull();
    expect(result?.targetId).toBe("hrv");
    expect(result?.featureImportances.length).toBeGreaterThan(0);
    expect(result?.predictions.length).toBeGreaterThan(0);
    expect(result?.diagnostics.sampleCount).toBeGreaterThan(50);
  });

  it("produces reasonable R² values", () => {
    const days = generateSyntheticDays(60);
    const result = trainHrvPredictor(days);
    if (!result) throw new Error("expected result");

    expect(result.diagnostics.linearRSquared).toBeGreaterThan(0.01);
    expect(result.diagnostics.linearRSquared).toBeLessThanOrEqual(1);
    expect(result.diagnostics.treeRSquared).toBeGreaterThan(0.1);
    expect(result.diagnostics.crossValidatedRSquared).toBeGreaterThan(-0.5);
  });

  it("ranks sleep features highly for HRV", () => {
    const days = generateSyntheticDays(60);
    const result = trainHrvPredictor(days);
    if (!result) throw new Error("expected result");

    const topFeatures = result.featureImportances.slice(0, 5).map((f) => f.name);
    const importantFeatures = ["sleep_duration", "deep_sleep"];
    const topContainsImportant = importantFeatures.some((f) => topFeatures.includes(f));
    expect(topContainsImportant).toBe(true);
  });

  it("excludes hrv and resting_hr from HRV features", () => {
    const days = generateSyntheticDays(60);
    const result = trainHrvPredictor(days);
    if (!result) throw new Error("expected result");

    const featureNames = result.featureImportances.map((f) => f.name);
    expect(featureNames).not.toContain("hrv");
    expect(featureNames).not.toContain("resting_hr");
  });

  it("generates tomorrow prediction from latest data", () => {
    const days = generateSyntheticDays(60);
    const result = trainHrvPredictor(days);
    if (!result) throw new Error("expected result");

    expect(result.tomorrowPrediction).not.toBeNull();
    expect(result.tomorrowPrediction?.linear).toBeGreaterThan(0);
    expect(result.tomorrowPrediction?.tree).toBeGreaterThan(0);
  });

  it("predictions have correct shape", () => {
    const days = generateSyntheticDays(60);
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
    const days = generateSyntheticDays(60, 42);
    const result = trainHrvPredictor(days);
    if (!result) throw new Error("expected result");

    expect(result.diagnostics).toEqual({
      linearRSquared: 0.3248,
      linearAdjustedRSquared: 0.0675,
      treeRSquared: 0.9906,
      crossValidatedRSquared: -0.2926,
      sampleCount: 59,
      featureCount: 16,
      linearFallbackUsed: false,
    });

    expect(result.predictions[0]).toEqual({
      date: "2024-01-01",
      actual: 57.7,
      linearPrediction: 65.09,
      treePrediction: 58.81,
    });
    expect(result.predictions[30]).toEqual({
      date: "2024-01-31",
      actual: 72,
      linearPrediction: 67.76,
      treePrediction: 71.94,
    });
    expect(result.tomorrowPrediction).toEqual({ linear: 71.21, tree: 71.8 });
    expect(result.featureImportances[0]?.name).toBe("calories");
    expect(result.featureImportances[0]?.treeImportance).toBeCloseTo(0.23712690166277647, 8);
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
      const days = generateSyntheticDays(60);
      expect(trainHrvPredictor(days)).toBeNull();
    } finally {
      PREDICTION_TARGETS.splice(0, PREDICTION_TARGETS.length, ...originalTargets);
    }
  });

  it("handles days with lots of missing nutrition data", () => {
    const days = generateSyntheticDays(60);
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

describe("trainFromDataset", () => {
  it("trains both models from a pre-built dataset", () => {
    const rng = mulberry32(123);
    const sampleCount = 100;
    const featureNames = ["feature_a", "feature_b", "feature_c"];
    const X: number[][] = [];
    const y: number[] = [];
    const dates: string[] = [];

    for (let i = 0; i < sampleCount; i++) {
      const featureA = rng() * 10;
      const featureB = rng() * 5;
      const featureC = rng() * 3;
      X.push([featureA, featureB, featureC]);
      // y is a function of featureA and featureB with noise
      y.push(featureA * 2 + featureB * 0.5 + (rng() - 0.5) * 2);
      dates.push(new Date(2024, 0, 1 + i).toISOString().slice(0, 10));
    }

    const dataset: ExtractedDataset = { featureNames, X, y, dates };
    const result = trainFromDataset(dataset, "test_target", "Test Target", "units");

    expect(result).toBeDefined();
    expect(result.targetId).toBe("test_target");
    expect(result.targetLabel).toBe("Test Target");
    expect(result.targetUnit).toBe("units");
    expect(result.predictions.length).toBe(sampleCount);
    expect(result.featureImportances.length).toBe(3);
    expect(result.diagnostics.sampleCount).toBe(sampleCount);
    expect(result.diagnostics.featureCount).toBe(3);

    // Activity-level predictions should not produce tomorrow prediction
    expect(result.tomorrowPrediction).toBeNull();

    // Feature importances should be sorted by tree importance descending
    for (let i = 1; i < result.featureImportances.length; i++) {
      const prev = result.featureImportances[i - 1];
      const curr = result.featureImportances[i];
      if (prev && curr) {
        expect(prev.treeImportance).toBeGreaterThanOrEqual(curr.treeImportance);
      }
    }

    // feature_a should be most important since y depends heavily on it
    expect(result.featureImportances[0]?.name).toBe("feature_a");
  });

  it("produces deterministic diagnostics and predictions for seeded data", () => {
    const rng = mulberry32(123);
    const sampleCount = 100;
    const featureNames = ["feature_a", "feature_b", "feature_c"];
    const X: number[][] = [];
    const y: number[] = [];
    const dates: string[] = [];

    for (let i = 0; i < sampleCount; i++) {
      const featureA = rng() * 10;
      const featureB = rng() * 5;
      const featureC = rng() * 3;
      X.push([featureA, featureB, featureC]);
      y.push(featureA * 2 + featureB * 0.5 + (rng() - 0.5) * 2);
      dates.push(new Date(2024, 0, 1 + i).toISOString().slice(0, 10));
    }

    const result = trainFromDataset(
      { featureNames, X, y, dates },
      "test_target",
      "Test Target",
      "units",
    );

    expect(result.diagnostics).toEqual({
      linearRSquared: 0.9885,
      linearAdjustedRSquared: 0.9882,
      treeRSquared: 0.9981,
      crossValidatedRSquared: 0.9735,
      sampleCount: 100,
      featureCount: 3,
      linearFallbackUsed: false,
    });

    expect(result.predictions[0]).toEqual({
      date: "2024-01-01",
      actual: 15.654115306097083,
      linearPrediction: 16.15,
      treePrediction: 16.01,
    });
    expect(result.predictions[50]).toEqual({
      date: "2024-02-20",
      actual: 14.146024385932833,
      linearPrediction: 13.55,
      treePrediction: 13.73,
    });

    for (let i = 0; i < result.predictions.length; i++) {
      const prediction = result.predictions[i];
      const expectedDate = dates[i];
      if (!prediction || !expectedDate) continue;
      expect(prediction.date).toBe(expectedDate);
    }
  });

  it("handles minimal dataset (just enough for CV)", () => {
    const rng = mulberry32(456);
    const sampleCount = 30;
    const featureNames = ["x"];
    const X: number[][] = [];
    const y: number[] = [];
    const dates: string[] = [];

    for (let i = 0; i < sampleCount; i++) {
      const featureValue = rng() * 10;
      X.push([featureValue]);
      y.push(featureValue + (rng() - 0.5));
      dates.push(new Date(2024, 0, 1 + i).toISOString().slice(0, 10));
    }

    const dataset: ExtractedDataset = { featureNames, X, y, dates };
    const result = trainFromDataset(dataset, "min", "Minimal", "u");

    expect(result.predictions.length).toBe(sampleCount);
    // With only 30 samples, CV might return 0 (not enough for 5-fold)
    expect(result.diagnostics.crossValidatedRSquared).toBeTypeOf("number");
  });

  it("falls back when linear regression fails on collinear features", () => {
    const sampleCount = 24;
    const featureNames = ["x", "x_dup", "constant"];
    const X: number[][] = [];
    const y: number[] = [];
    const dates: string[] = [];

    for (let i = 0; i < sampleCount; i++) {
      const featureValue = i + 1;
      X.push([featureValue, featureValue, 1]); // perfect collinearity + constant feature
      y.push(featureValue * 2);
      dates.push(new Date(2024, 0, 1 + i).toISOString().slice(0, 10));
    }

    const dataset: ExtractedDataset = { featureNames, X, y, dates };
    const result = trainFromDataset(dataset, "cardio_power", "Cardio Power Output", "W");

    expect(result.predictions.length).toBe(sampleCount);
    expect(result.featureImportances).toHaveLength(3);
    // Linear diagnostics should degrade gracefully instead of throwing.
    expect(result.diagnostics).toEqual({
      linearRSquared: 0,
      linearAdjustedRSquared: 0,
      treeRSquared: 0.9965,
      crossValidatedRSquared: 0,
      sampleCount: 24,
      featureCount: 3,
      linearFallbackUsed: true,
    });

    for (const prediction of result.predictions) {
      expect(prediction.linearPrediction).toBe(prediction.treePrediction);
    }
    for (const importance of result.featureImportances) {
      expect(importance.linearImportance).toBe(0);
      expect(importance.linearCoefficient).toBe(0);
    }
  });

  it("computes non-zero cross-validation at the 25-sample boundary", () => {
    const featureNames = ["x"];
    const X: number[][] = [];
    const y: number[] = [];
    const dates: string[] = [];

    for (let i = 0; i < 25; i++) {
      const featureValue = i + 1;
      X.push([featureValue]);
      y.push(featureValue * 2 + 1);
      dates.push(new Date(2024, 0, 1 + i).toISOString().slice(0, 10));
    }

    const result = trainFromDataset({ featureNames, X, y, dates }, "t", "T", "u");
    expect(result.diagnostics.crossValidatedRSquared).not.toBe(0);
  });

  it("returns zero cross-validation when the target has no variance", () => {
    const featureNames = ["x"];
    const X: number[][] = [];
    const y: number[] = [];
    const dates: string[] = [];

    for (let i = 0; i < 100; i++) {
      X.push([i]);
      y.push(10);
      dates.push(new Date(2024, 0, 1 + i).toISOString().slice(0, 10));
    }

    const result = trainFromDataset({ featureNames, X, y, dates }, "flat", "Flat", "u");
    expect(result.diagnostics.crossValidatedRSquared).toBe(0);
  });
});

describe("trainPredictor", () => {
  it("returns null with empty data", () => {
    const target = PREDICTION_TARGETS.find((t) => t.id === "hrv");
    if (!target) throw new Error("expected hrv target");

    const result = trainPredictor([], target);
    expect(result).toBeNull();
  });

  it("returns null with data that has all-null target values", () => {
    const target = PREDICTION_TARGETS.find((t) => t.id === "hrv");
    if (!target) throw new Error("expected hrv target");

    const days: DailyFeatureRow[] = [];
    for (let i = 0; i < 100; i++) {
      days.push({
        date: new Date(2024, 0, 1 + i).toISOString().slice(0, 10),
        resting_hr: 60,
        hrv: null, // all null — can't build target
        spo2_avg: null,
        steps: null,
        active_energy_kcal: null,
        skin_temp_c: null,
        sleep_duration_min: 420,
        deep_min: 80,
        rem_min: 90,
        sleep_efficiency: 85,
        exercise_minutes: 30,
        cardio_minutes: 20,
        strength_minutes: 10,
        calories: 2000,
        protein_g: 100,
        carbs_g: 200,
        fat_g: 70,
        fiber_g: 25,
        weight_kg: 75,
      });
    }

    const result = trainPredictor(days, target);
    expect(result).toBeNull();
  });

  it("diagnostics contain adjusted R-squared", () => {
    const days = generateSyntheticDays(60);
    const target = PREDICTION_TARGETS.find((t) => t.id === "hrv");
    if (!target) throw new Error("expected hrv target");

    const result = trainPredictor(days, target);
    if (!result) throw new Error("expected result");

    // Adjusted R-squared should be <= R-squared (penalizes extra features)
    expect(result.diagnostics.linearAdjustedRSquared).toBeLessThanOrEqual(
      result.diagnostics.linearRSquared + 0.01, // small tolerance for floating point
    );
  });

  it("cross-validation R-squared is lower than training R-squared", () => {
    const days = generateSyntheticDays(30);
    const target = PREDICTION_TARGETS.find((t) => t.id === "hrv");
    if (!target) throw new Error("expected hrv target");

    const result = trainPredictor(days, target);
    if (!result) throw new Error("expected result");

    // CV R² should generally be less than or equal to training R²
    // (out-of-sample performance is worse than in-sample)
    expect(result.diagnostics.crossValidatedRSquared).toBeLessThanOrEqual(
      result.diagnostics.treeRSquared + 0.1, // generous tolerance
    );
  });

  it("falls back to tree predictions when daily features are singular", () => {
    const target = PREDICTION_TARGETS.find((t) => t.id === "hrv");
    if (!target) throw new Error("expected hrv target");

    const days: DailyFeatureRow[] = [];
    for (let i = 0; i < 30; i++) {
      days.push({
        date: new Date(2024, 0, 1 + i).toISOString().slice(0, 10),
        resting_hr: 60,
        hrv: 50,
        spo2_avg: 98,
        steps: 5000,
        active_energy_kcal: 300,
        skin_temp_c: 34,
        sleep_duration_min: 420,
        deep_min: 80,
        rem_min: 90,
        sleep_efficiency: 85,
        exercise_minutes: 30,
        cardio_minutes: 20,
        strength_minutes: 10,
        calories: 2000,
        protein_g: 100,
        carbs_g: 200,
        fat_g: 70,
        fiber_g: 25,
        weight_kg: 75,
      });
    }

    const result = trainPredictor(days, target);
    if (!result) throw new Error("expected result");

    expect(result.diagnostics.linearFallbackUsed).toBe(true);
    expect(result.tomorrowPrediction).toEqual({ linear: 50, tree: 50 });
    expect(result.featureImportances[0]?.linearImportance).toBe(0);
    expect(result.featureImportances[0]?.linearCoefficient).toBe(0);
  });

  it("trains resting HR prediction", () => {
    const target = PREDICTION_TARGETS.find((t) => t.id === "resting_hr");
    if (!target) throw new Error("expected resting_hr target");
    const days = generateSyntheticDays(60);
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
    const days = generateSyntheticDays(60);
    const result = trainPredictor(days, target);

    expect(result).not.toBeNull();
    expect(result?.targetId).toBe("sleep_efficiency");
    expect(result?.targetLabel).toBe("Sleep Efficiency");
    expect(result?.targetUnit).toBe("%");

    // Should not include any sleep metrics as features
    const featureNames = result?.featureImportances.map((f) => f.name);
    expect(featureNames).not.toContain("sleep_efficiency");
    expect(featureNames).not.toContain("sleep_duration");
    expect(featureNames).not.toContain("deep_sleep");
    expect(featureNames).not.toContain("rem_sleep");
  });

  it("trains weight prediction", () => {
    const target = PREDICTION_TARGETS.find((t) => t.id === "weight");
    if (!target) throw new Error("expected weight target");
    const days = generateSyntheticDays(60);
    const result = trainPredictor(days, target);

    expect(result).not.toBeNull();
    expect(result?.targetId).toBe("weight");
    expect(result?.targetLabel).toBe("Body Weight");
    expect(result?.targetUnit).toBe("kg");

    // Should not include weight itself as a feature
    const featureNames = result?.featureImportances.map((f) => f.name);
    expect(featureNames).not.toContain("weight_kg");
  });
});
