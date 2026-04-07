import { describe, expect, it } from "vitest";
import { parseWeightliftingWorkout } from "./whoop/parsing.ts";
import type { WhoopWeightliftingWorkoutResponse } from "./whoop/re-exports.ts";

// ============================================================
// Sample WHOOP weightlifting-service response
// (from live API call against activity 546e0dd6-88e1-4eb2-9cd0-73aa8b729bd3)
// ============================================================

const sampleWeightliftingResponse: WhoopWeightliftingWorkoutResponse = {
  activity_id: "546e0dd6-88e1-4eb2-9cd0-73aa8b729bd3",
  user_id: 35557944,
  zone_durations: {
    zone0_to10_duration: 0,
    zone10_to20_duration: 0,
    zone20_to30_duration: 0,
    zone30_to40_duration: 4,
    zone40_to50_duration: 2,
    zone50_to60_duration: 15,
    zone60_to70_duration: 8,
    zone70_to80_duration: 0,
    zone80_to90_duration: 0,
    zone90_to100_duration: 0,
  },
  workout_groups: [
    {
      workout_exercises: [
        {
          sets: [
            {
              weight_kg: 0,
              number_of_reps: 0,
              msk_total_volume_kg: 255.876,
              time_in_seconds: 60,
              during: "['2026-03-12T21:37:00.000Z','2026-03-12T21:37:00.001Z')",
              complete: true,
              strap_location: null,
              strap_location_laterality: null,
            },
            {
              weight_kg: 0,
              number_of_reps: 0,
              msk_total_volume_kg: 255.876,
              time_in_seconds: 60,
              during: "['2026-03-12T21:40:00.000Z','2026-03-12T21:40:00.001Z')",
              complete: true,
              strap_location: null,
              strap_location_laterality: null,
            },
            {
              weight_kg: 0,
              number_of_reps: 0,
              msk_total_volume_kg: 255.876,
              time_in_seconds: 60,
              during: "['2026-03-12T21:43:00.000Z','2026-03-12T21:43:00.001Z')",
              complete: true,
              strap_location: null,
              strap_location_laterality: null,
            },
          ],
          exercise_details: {
            exercise_id: "FRONTPLANKELBOW",
            name: "Front Plank",
            equipment: "BODY",
            exercise_type: "STRENGTH",
            muscle_groups: ["CORE"],
            volume_input_format: "TIME",
          },
        },
        {
          sets: [
            {
              weight_kg: 0,
              number_of_reps: 0,
              msk_total_volume_kg: 255.876,
              time_in_seconds: 60,
              during: "['2026-03-12T21:46:00.000Z','2026-03-12T21:46:00.001Z')",
              complete: true,
              strap_location: null,
              strap_location_laterality: null,
            },
          ],
          exercise_details: {
            exercise_id: "SIDEPLANKL",
            name: "Side Plank L",
            equipment: "BODY",
            exercise_type: "STRENGTH",
            muscle_groups: ["CORE"],
            volume_input_format: "TIME",
          },
        },
      ],
    },
    {
      workout_exercises: [
        {
          sets: [
            {
              weight_kg: 50,
              number_of_reps: 8,
              msk_total_volume_kg: 400,
              time_in_seconds: 0,
              during: "['2026-03-12T22:00:00.000Z','2026-03-12T22:00:00.001Z')",
              complete: true,
              strap_location: null,
              strap_location_laterality: null,
            },
            {
              weight_kg: 55,
              number_of_reps: 6,
              msk_total_volume_kg: 330,
              time_in_seconds: 0,
              during: "['2026-03-12T22:03:00.000Z','2026-03-12T22:03:00.001Z')",
              complete: true,
              strap_location: null,
              strap_location_laterality: null,
            },
          ],
          exercise_details: {
            exercise_id: "BENCHPRESS",
            name: "Bench Press",
            equipment: "BARBELL",
            exercise_type: "STRENGTH",
            muscle_groups: ["CHEST", "TRICEPS"],
            volume_input_format: "REPS_AND_WEIGHT",
          },
        },
      ],
    },
  ],
  total_effective_volume_kg: 2047.008,
  raw_msk_strain_score: 0.0288,
  scaled_msk_strain_score: 2.85552,
  cardio_strain_score: 1.549,
  cardio_strain_contribution_percent: 0.329,
  msk_strain_contribution_percent: 0.671,
};

describe("parseWeightliftingWorkout", () => {
  it("extracts activityId as externalId", () => {
    const result = parseWeightliftingWorkout(sampleWeightliftingResponse);
    expect(result.activityId).toBe("546e0dd6-88e1-4eb2-9cd0-73aa8b729bd3");
  });

  it("flattens exercises across all workout groups", () => {
    const result = parseWeightliftingWorkout(sampleWeightliftingResponse);
    // Group 1 has 2 exercises (Front Plank, Side Plank L), Group 2 has 1 (Bench Press)
    expect(result.exercises).toHaveLength(3);
  });

  it("assigns sequential exercise indices across groups", () => {
    const result = parseWeightliftingWorkout(sampleWeightliftingResponse);
    expect(result.exercises[0]?.exerciseIndex).toBe(0);
    expect(result.exercises[1]?.exerciseIndex).toBe(1);
    expect(result.exercises[2]?.exerciseIndex).toBe(2);
  });

  it("maps exercise names and equipment", () => {
    const result = parseWeightliftingWorkout(sampleWeightliftingResponse);
    expect(result.exercises[0]?.exerciseName).toBe("Front Plank");
    expect(result.exercises[0]?.equipment).toBe("BODY");
    expect(result.exercises[0]?.providerExerciseId).toBe("FRONTPLANKELBOW");

    expect(result.exercises[2]?.exerciseName).toBe("Bench Press");
    expect(result.exercises[2]?.equipment).toBe("BARBELL");
  });

  it("parses timed sets (TIME volume format)", () => {
    const result = parseWeightliftingWorkout(sampleWeightliftingResponse);
    const frontPlank = result.exercises[0];
    expect(frontPlank?.sets).toHaveLength(3);

    const set = frontPlank?.sets[0];
    expect(set?.setIndex).toBe(0);
    expect(set?.weightKg).toBeNull(); // 0 weight = null for timed exercises
    expect(set?.reps).toBeNull(); // 0 reps = null for timed exercises
    expect(set?.durationSeconds).toBe(60);
  });

  it("parses weighted sets (REPS_AND_WEIGHT volume format)", () => {
    const result = parseWeightliftingWorkout(sampleWeightliftingResponse);
    const benchPress = result.exercises[2];
    expect(benchPress?.sets).toHaveLength(2);

    const set1 = benchPress?.sets[0];
    expect(set1?.weightKg).toBe(50);
    expect(set1?.reps).toBe(8);
    expect(set1?.durationSeconds).toBeNull(); // 0 duration = null for weighted exercises

    const set2 = benchPress?.sets[1];
    expect(set2?.weightKg).toBe(55);
    expect(set2?.reps).toBe(6);
  });

  it("handles empty workout groups", () => {
    const empty: WhoopWeightliftingWorkoutResponse = {
      ...sampleWeightliftingResponse,
      workout_groups: [],
    };
    const result = parseWeightliftingWorkout(empty);
    expect(result.exercises).toHaveLength(0);
  });

  it("skips incomplete sets", () => {
    const withIncomplete: WhoopWeightliftingWorkoutResponse = {
      ...sampleWeightliftingResponse,
      workout_groups: [
        {
          workout_exercises: [
            {
              sets: [
                {
                  weight_kg: 50,
                  number_of_reps: 8,
                  msk_total_volume_kg: 400,
                  time_in_seconds: 0,
                  during: "['2026-03-12T22:00:00.000Z','2026-03-12T22:00:00.001Z')",
                  complete: true,
                  strap_location: null,
                  strap_location_laterality: null,
                },
                {
                  weight_kg: 0,
                  number_of_reps: 0,
                  msk_total_volume_kg: 0,
                  time_in_seconds: 0,
                  during: "['2026-03-12T22:03:00.000Z','2026-03-12T22:03:00.001Z')",
                  complete: false,
                  strap_location: null,
                  strap_location_laterality: null,
                },
              ],
              exercise_details: {
                exercise_id: "BENCHPRESS",
                name: "Bench Press",
                equipment: "BARBELL",
                exercise_type: "STRENGTH",
                muscle_groups: ["CHEST"],
                volume_input_format: "REPS_AND_WEIGHT",
              },
            },
          ],
        },
      ],
    };
    const result = parseWeightliftingWorkout(withIncomplete);
    expect(result.exercises[0]?.sets).toHaveLength(1);
  });
});
