import { describe, expect, it } from "vitest";
import type { ExerciseMuscleMapping } from "./exercise-metadata.ts";
import { EXERCISE_MUSCLE_GROUPS, lookupExerciseMuscleGroups } from "./exercise-metadata.ts";
import exerciseMetadataOverrides from "./exercise-metadata-overrides.json" with { type: "json" };
import freeExerciseDbExercises from "./free-exercise-db.json" with { type: "json" };

const typedExerciseMetadata: Record<string, ExerciseMuscleMapping> = EXERCISE_MUSCLE_GROUPS;

describe("exercise metadata source files", () => {
  it("stores local corrections separately from the upstream catalog", () => {
    expect(exerciseMetadataOverrides["romanian deadlift"]).toEqual({
      primaryMuscleGroups: ["HAMSTRINGS", "GLUTES"],
      secondaryMuscleGroups: ["LOWER_BACK"],
    });
  });

  it("keeps the upstream Free Exercise DB catalog in its original shape", () => {
    expect(freeExerciseDbExercises).toHaveLength(873);
    expect(freeExerciseDbExercises).toContainEqual(
      expect.objectContaining({
        name: "Barbell Full Squat",
        primaryMuscles: ["quadriceps"],
        secondaryMuscles: ["calves", "glutes", "hamstrings", "lower back"],
      }),
    );
  });
});

describe("EXERCISE_MUSCLE_GROUPS", () => {
  it("uses Free Exercise DB plus local overrides as the broad baseline", () => {
    expect(Object.keys(EXERCISE_MUSCLE_GROUPS)).toHaveLength(878);
    expect(EXERCISE_MUSCLE_GROUPS["barbell full squat"]).toEqual({
      primaryMuscleGroups: ["QUADRICEPS"],
      secondaryMuscleGroups: ["CALVES", "GLUTES", "HAMSTRINGS", "LOWER_BACK"],
    });
    expect(EXERCISE_MUSCLE_GROUPS["weighted pull ups"]).toEqual({
      primaryMuscleGroups: ["LATS"],
      secondaryMuscleGroups: ["BICEPS", "MIDDLE_BACK"],
    });
  });

  it("does not repeat primary muscles as secondary muscles", () => {
    for (const mapping of Object.values(typedExerciseMetadata)) {
      const primaryMuscleGroups = new Set(mapping.primaryMuscleGroups);
      for (const secondaryMuscleGroup of mapping.secondaryMuscleGroups ?? []) {
        expect(primaryMuscleGroups.has(secondaryMuscleGroup)).toBe(false);
      }
    }
  });
});

describe("lookupExerciseMuscleGroups", () => {
  it("maps reported lower-body exercises to muscle groups", () => {
    expect(lookupExerciseMuscleGroups("Romanian Deadlift")).toEqual([
      "HAMSTRINGS",
      "GLUTES",
      "LOWER_BACK",
    ]);
    expect(lookupExerciseMuscleGroups("Bulgarian Split Squat")).toEqual([
      "QUADRICEPS",
      "GLUTES",
      "HAMSTRINGS",
    ]);
  });

  it("normalizes imported exercise names from any provider", () => {
    expect(lookupExerciseMuscleGroups("  romanian   deadlift  ")).toEqual([
      "HAMSTRINGS",
      "GLUTES",
      "LOWER_BACK",
    ]);
  });

  it("returns null for unknown exercise names", () => {
    expect(lookupExerciseMuscleGroups("Custom Movement")).toBeNull();
  });

  it("returns only primary muscles when the upstream exercise has no secondary muscles", () => {
    expect(lookupExerciseMuscleGroups("3/4 Sit-Up")).toEqual(["ABDOMINALS"]);
  });
});
