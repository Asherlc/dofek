import { describe, expect, it } from "vitest";
import { estimateStrengthSet, estimateStrengthSources } from "./strength-set-estimate.ts";

const raw = {
  exerciseName: "Bench Press (Barbell)",
  setTag: "Failure",
  weightUnit: "kg",
  reportedWeightUnit: "kg",
  weight: 100,
  reps: 2,
};

const row = {
  set_provider: "strong-csv",
  exercise_name: "Bench Press",
  equipment: "Barbell",
  set_type: "working",
  weight_kg: 100,
  reps: 2,
  raw,
};

describe("estimateStrengthSet", () => {
  it.each([
    [1, null],
    [2, 106.66],
    [10, 133.3],
    [11, null],
  ])("uses completed reps (%i) within the supported range", (reps, expected) => {
    const result = estimateStrengthSet({ ...row, reps, raw: { ...raw, reps } });
    if (expected === null) expect(result.value).toBeNull();
    else expect(result.value).toBeCloseTo(expected, 8);
  });

  it("uses the persisted real from a pounds conversion rounded during import", () => {
    const weight = Math.fround(45.813);
    const result = estimateStrengthSet({
      ...row,
      weight_kg: weight,
      raw: { ...raw, weight: 101, weightUnit: "lbs", reportedWeightUnit: "lbs" },
    });
    expect(result.value).toBeCloseTo(weight * 1.0666, 8);
  });

  it.each([
    ["missing weight", { weight_kg: null }],
    ["negative weight", { weight_kg: -100 }],
    ["disagreeing weights", { weight_kg: 101 }],
    ["other provider", { set_provider: "hevy" }],
    ["unknown effort", { raw: { ...raw, setTag: undefined } }],
    ["RPE without fatigue", { raw: { ...raw, setTag: undefined, rpe: 10 } }],
    ["missing unit", { raw: { ...raw, reportedWeightUnit: undefined } }],
    ["mismatched units", { raw: { ...raw, reportedWeightUnit: "lbs" } }],
    ["unknown equipment", { equipment: null }],
    ["other equipment", { equipment: "Dumbbell" }],
    ["other exercise", { exercise_name: "Incline Bench Press" }],
    ["conflicting exercise", { raw: { ...raw, exerciseName: "Squat (Barbell)" } }],
    ["dropset", { set_type: "dropset" }],
  ])("excludes %s", (_label, override) => {
    expect(estimateStrengthSet({ ...row, ...override }).value).toBeNull();
  });
});

describe("estimateStrengthSources", () => {
  it("accepts independently verified kg and lb equivalents and chooses a stable source", () => {
    const kilograms = { ...row, set_id: "kg-set" };
    const pounds = {
      ...row,
      set_id: "lb-set",
      raw: { ...raw, weight: 220.462, weightUnit: "lbs", reportedWeightUnit: "lbs" },
    };
    for (const sources of [
      [pounds, kilograms],
      [kilograms, pounds],
    ]) {
      const estimate = estimateStrengthSources(sources);
      expect(estimate.value).toBeCloseTo(106.66, 8);
      expect(estimate.source?.set_id).toBe(kilograms.set_id);
    }
  });
});
