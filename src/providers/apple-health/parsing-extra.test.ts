import { describe, expect, it } from "vitest";
import { parseWorkout } from "./workouts.ts";

describe("parseWorkout — Hang Ten validation", () => {
  it("reports malformed Hang Ten activity segment JSON", () => {
    const result = parseWorkout(
      {
        workoutActivityType: "HKWorkoutActivityTypeFunctionalStrengthTraining",
        duration: "10",
        durationUnit: "min",
        startDate: "2026-08-07 07:00:00 -0700",
        endDate: "2026-08-07 07:10:00 -0700",
        sourceName: "Hang Ten",
      },
      {
        HKMetadataKeyWorkoutBrandName: "Hang Ten",
        "HangTen.PlanName": "Max Hangs",
        "HangTen.ActivitySegments": "{not json",
      },
    );

    expect(result.activityType.canonicalType).toBe("hangboard");
    expect(result.hangTen?.rawActivitySegments).toBe("{not json");
    expect(result.hangTen?.activitySegments).toBeUndefined();
    expect(result.hangTen?.activitySegmentsError).toContain(
      "Invalid Hang Ten activity segments JSON",
    );
  });

  it("classifies a Hang Ten source as hangboarding without workout metadata", () => {
    const result = parseWorkout({
      workoutActivityType: "HKWorkoutActivityTypeFunctionalStrengthTraining",
      startDate: "2026-08-07 07:00:00 -0700",
      endDate: "2026-08-07 07:10:00 -0700",
      sourceName: "Hang Ten",
    });

    expect(result.activityType.canonicalType).toBe("hangboard");
    expect(result.hangTen).toBeUndefined();
  });

  it("uses the HealthKit source rather than Hang Ten metadata for classification", () => {
    const result = parseWorkout(
      {
        workoutActivityType: "HKWorkoutActivityTypeFunctionalStrengthTraining",
        startDate: "2026-08-07 07:00:00 -0700",
        endDate: "2026-08-07 07:10:00 -0700",
        sourceName: "Apple Watch",
      },
      {
        HKMetadataKeyWorkoutBrandName: "Hang Ten",
        "HangTen.PlanName": "Max Hangs",
      },
    );

    expect(result.activityType.canonicalType).toBe("strength");
  });

  it("reports structurally invalid Hang Ten activity segment JSON", () => {
    const result = parseWorkout(
      {
        workoutActivityType: "HKWorkoutActivityTypeFunctionalStrengthTraining",
        startDate: "2026-08-07 07:00:00 -0700",
        endDate: "2026-08-07 07:10:00 -0700",
        sourceName: "Hang Ten",
      },
      {
        HKMetadataKeyWorkoutBrandName: "Hang Ten",
        "HangTen.PlanName": "Max Hangs",
        "HangTen.ActivitySegments": JSON.stringify({
          segments: [{ stepID: "step-1" }],
        }),
      },
    );

    expect(result.hangTen?.activitySegments).toBeUndefined();
    expect(result.hangTen?.activitySegmentsError).toBe(
      "Invalid Hang Ten activity segments JSON: segment metadata has invalid fields",
    );
  });
});
