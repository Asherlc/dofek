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
  it.each([
    ["Ab Wheel", ["ABDOMINALS", "SHOULDERS"]],
    ["Bent Over Row", ["MIDDLE_BACK", "BICEPS", "LATS", "SHOULDERS"]],
    ["Bicep Curl", ["BICEPS", "FOREARMS"]],
    ["Bicycle Crunch", ["ABDOMINALS"]],
    ["Calf Press on Leg Press", ["CALVES"]],
    ["Chest Dip", ["CHEST", "SHOULDERS", "TRICEPS"]],
    ["Chest Fly", ["CHEST"]],
    ["Crunch", ["ABDOMINALS"]],
    ["Flat Leg Raise", ["ABDOMINALS"]],
    ["Leg Extension", ["QUADRICEPS"]],
    ["Prone Leg Curl", ["HAMSTRINGS"]],
    ["Standing Calf Raise", ["CALVES"]],
    ["Strict Military Press", ["SHOULDERS", "TRICEPS"]],
    ["Triceps Dip", ["TRICEPS", "CHEST", "SHOULDERS"]],
    ["Wide Pull Up", ["LATS", "BICEPS", "MIDDLE_BACK", "SHOULDERS"]],
  ])("maps the uploaded Strong alias %s through the bundled catalog", (name, muscleGroups) => {
    expect(lookupExerciseMuscleGroups(name)).toEqual(muscleGroups);
  });

  it.each(["Skullcrusher", "Triceps Extension", "V Up"])(
    "leaves the unresolved uploaded Strong name %s unenriched",
    (name) => {
      expect(lookupExerciseMuscleGroups(name)).toBeNull();
    },
  );

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
    expect(lookupExerciseMuscleGroups("Squat")).toEqual([
      "QUADRICEPS",
      "GLUTES",
      "HAMSTRINGS",
      "LOWER_BACK",
    ]);
    expect(lookupExerciseMuscleGroups("Deadlift")).toEqual([
      "HAMSTRINGS",
      "GLUTES",
      "LOWER_BACK",
      "QUADRICEPS",
      "TRAPS",
      "FOREARMS",
    ]);
  });

  it("maps reported upper-body exercises to muscle groups", () => {
    expect(lookupExerciseMuscleGroups("Overhead Press")).toEqual(["SHOULDERS", "TRICEPS"]);
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
