import { describe, expect, it } from "vitest";
import type { ConditionalTest } from "./conditional-tests.ts";
import { findConfounders } from "./confounders.ts";
import type { JoinedDay } from "./data-join.ts";

function makeExerciseDay(index: number, highExercise: boolean): JoinedDay {
  return {
    date: `2025-${highExercise ? "01" : "02"}-${String(index + 1).padStart(2, "0")}`,
    resting_hr: 60,
    hrv: 50,
    spo2_avg: 98,
    steps: (highExercise ? 15_000 : 3_000) + index,
    skin_temp_c: highExercise ? 36 : 34,
    sleep_duration_min: 480,
    deep_min: 90,
    rem_min: 100,
    sleep_efficiency: 90,
    exercise_minutes: (highExercise ? 90 : 10) + index,
    cardio_minutes: (highExercise ? 55 : 5) + index,
    strength_minutes: (highExercise ? 30 : 3) + index,
    flexibility_minutes: 5,
    calories: 2_000,
    protein_g: 120,
    carbs_g: 220,
    fat_g: 70,
    fiber_g: 25,
    weight_kg: 75,
    body_fat_pct: 18,
    weight_30d_avg: 75,
    body_fat_30d_avg: 18,
    weight_30d_delta: 0,
    body_fat_30d_delta: 0,
  };
}

describe("findConfounders", () => {
  it("keeps the exercise parent and removes its component confounders", () => {
    const joined = [
      ...Array.from({ length: 10 }, (_unused, index) => makeExerciseDay(index, true)),
      ...Array.from({ length: 10 }, (_unused, index) => makeExerciseDay(index, false)),
    ];
    const conditionalTest: ConditionalTest = {
      id: "skin-temperature-exercise-confounders",
      action: "higher skin temperature",
      metric: "HRV",
      splitFn: (day) => (day.skin_temp_c == null ? null : day.skin_temp_c >= 35),
      valueFn: (day) => day.hrv,
    };

    const labels = findConfounders(conditionalTest, joined).map(
      (confounder) => confounder.split(" also ")[0],
    );

    expect(labels).toContain("exercise duration");
    expect(labels).not.toContain("cardio duration");
    expect(labels).not.toContain("strength training duration");
    expect(labels).not.toContain("steps");
  });
});
