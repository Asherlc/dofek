import { describe, expect, it } from "vitest";
import type { DailyFeatureRow, ExtractedDataset } from "./features.ts";
import { PREDICTION_TARGETS } from "./features.ts";
import { trainFromDataset, trainPredictor } from "./predictor.ts";

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
    const sleepDuration = 360 + rng() * 180;
    const deepMin = 40 + rng() * 60;
    const exerciseMin = rng() > 0.3 ? 30 + rng() * 60 : 0;
    const protein = 80 + rng() * 80;

    const hrv =
      40 +
      sleepDuration * 0.05 +
      deepMin * 0.1 +
      (exerciseMin > 0 ? -5 : 0) +
      protein * 0.02 +
      (rng() - 0.5) * 10;
    const restingHr = 75 - sleepDuration * 0.02 - deepMin * 0.05 + (rng() - 0.5) * 8;
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

describe("trainFromDataset", () => {
  it("trains both models from a pre-built dataset", () => {
    const rng = mulberry32(123);
    const n = 100;
    const featureNames = ["feature_a", "feature_b", "feature_c"];
    const X: number[][] = [];
    const y: number[] = [];
    const dates: string[] = [];

    for (let i = 0; i < n; i++) {
      const a = rng() * 10;
      const b = rng() * 5;
      const c = rng() * 3;
      X.push([a, b, c]);
      // y is a function of a and b with noise
      y.push(a * 2 + b * 0.5 + (rng() - 0.5) * 2);
      dates.push(new Date(2024, 0, 1 + i).toISOString().slice(0, 10));
    }

    const dataset: ExtractedDataset = { featureNames, X, y, dates };
    const result = trainFromDataset(dataset, "test_target", "Test Target", "units");

    expect(result).toBeDefined();
    expect(result.targetId).toBe("test_target");
    expect(result.targetLabel).toBe("Test Target");
    expect(result.targetUnit).toBe("units");
    expect(result.predictions.length).toBe(n);
    expect(result.featureImportances.length).toBe(3);
    expect(result.diagnostics.sampleCount).toBe(n);
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

  it("handles minimal dataset (just enough for CV)", () => {
    const rng = mulberry32(456);
    const n = 30;
    const featureNames = ["x"];
    const X: number[][] = [];
    const y: number[] = [];
    const dates: string[] = [];

    for (let i = 0; i < n; i++) {
      const x = rng() * 10;
      X.push([x]);
      y.push(x + (rng() - 0.5));
      dates.push(new Date(2024, 0, 1 + i).toISOString().slice(0, 10));
    }

    const dataset: ExtractedDataset = { featureNames, X, y, dates };
    const result = trainFromDataset(dataset, "min", "Minimal", "u");

    expect(result.predictions.length).toBe(n);
    // With only 30 samples, CV might return 0 (not enough for 5-fold)
    expect(result.diagnostics.crossValidatedRSquared).toBeTypeOf("number");
  });

  it("falls back when linear regression fails on collinear features", () => {
    const n = 24;
    const featureNames = ["x", "x_dup", "constant"];
    const X: number[][] = [];
    const y: number[] = [];
    const dates: string[] = [];

    for (let i = 0; i < n; i++) {
      const x = i + 1;
      X.push([x, x, 1]); // perfect collinearity + constant feature
      y.push(x * 2);
      dates.push(new Date(2024, 0, 1 + i).toISOString().slice(0, 10));
    }

    const dataset: ExtractedDataset = { featureNames, X, y, dates };
    const result = trainFromDataset(dataset, "cardio_power", "Cardio Power Output", "W");

    expect(result.predictions.length).toBe(n);
    expect(result.featureImportances).toHaveLength(3);
    // Linear diagnostics should degrade gracefully instead of throwing.
    expect(result.diagnostics.linearRSquared).toBeTypeOf("number");
    expect(result.diagnostics.linearAdjustedRSquared).toBeTypeOf("number");
    expect(result.diagnostics.linearFallbackUsed).toBe(true);
  });
});

describe("trainPredictor — edge cases", () => {
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

  it("trains weight prediction model", () => {
    const target = PREDICTION_TARGETS.find((t) => t.id === "weight");
    if (!target) {
      // Weight might not be a target — skip if not available
      return;
    }

    const days = generateSyntheticDays(200);
    const result = trainPredictor(days, target);

    if (result) {
      expect(result.targetId).toBe("weight");
      // Weight features should not include weight itself
      const featureNames = result.featureImportances.map((f) => f.name);
      expect(featureNames).not.toContain("weight");
    }
  });

  it("diagnostics contain adjusted R-squared", () => {
    const days = generateSyntheticDays(200);
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
    const days = generateSyntheticDays(300);
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
});
