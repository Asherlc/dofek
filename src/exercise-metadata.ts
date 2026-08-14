import { z } from "zod";
import exerciseMetadataOverrides from "./exercise-metadata-overrides.json" with { type: "json" };
import freeExerciseDbExercises from "./free-exercise-db.json" with { type: "json" };

export interface ExerciseMuscleMapping {
  primaryMuscleGroups: string[];
  secondaryMuscleGroups?: string[];
}

const FREE_EXERCISE_DB_MUSCLES = [
  "abdominals",
  "abductors",
  "adductors",
  "biceps",
  "calves",
  "chest",
  "forearms",
  "glutes",
  "hamstrings",
  "lats",
  "lower back",
  "middle back",
  "neck",
  "quadriceps",
  "shoulders",
  "traps",
  "triceps",
] as const;

type FreeExerciseDbMuscle = (typeof FREE_EXERCISE_DB_MUSCLES)[number];

const MUSCLE_GROUPS_BY_FREE_EXERCISE_DB_MUSCLE = {
  abdominals: "ABDOMINALS",
  abductors: "ABDUCTORS",
  adductors: "ADDUCTORS",
  biceps: "BICEPS",
  calves: "CALVES",
  chest: "CHEST",
  forearms: "FOREARMS",
  glutes: "GLUTES",
  hamstrings: "HAMSTRINGS",
  lats: "LATS",
  "lower back": "LOWER_BACK",
  "middle back": "MIDDLE_BACK",
  neck: "NECK",
  quadriceps: "QUADRICEPS",
  shoulders: "SHOULDERS",
  traps: "TRAPS",
  triceps: "TRICEPS",
} as const satisfies Record<FreeExerciseDbMuscle, string>;

const freeExerciseDbMuscleSchema = z.enum(FREE_EXERCISE_DB_MUSCLES);
const freeExerciseDbExerciseSchema = z.object({
  name: z.string(),
  primaryMuscles: z.array(freeExerciseDbMuscleSchema),
  secondaryMuscles: z.array(freeExerciseDbMuscleSchema),
});
const exerciseMuscleMappingSchema = z.object({
  primaryMuscleGroups: z.array(z.string()),
  secondaryMuscleGroups: z.array(z.string()).optional(),
});
const freeExerciseDbExercisesSchema = z.array(freeExerciseDbExerciseSchema);
const exerciseMetadataOverridesSchema = z.record(z.string(), exerciseMuscleMappingSchema);

type FreeExerciseDbExercise = z.infer<typeof freeExerciseDbExerciseSchema>;

export const EXERCISE_MUSCLE_GROUPS: Record<string, ExerciseMuscleMapping> =
  buildExerciseMuscleGroups(
    freeExerciseDbExercisesSchema.parse(freeExerciseDbExercises),
    exerciseMetadataOverridesSchema.parse(exerciseMetadataOverrides),
  );

export function lookupExerciseMuscleGroups(exerciseName: string): string[] | null {
  const mapping = EXERCISE_MUSCLE_GROUPS[normalizeExerciseName(exerciseName)];
  if (!mapping) return null;

  return [...mapping.primaryMuscleGroups, ...(mapping.secondaryMuscleGroups ?? [])];
}

function normalizeExerciseName(exerciseName: string): string {
  return exerciseName.trim().toLowerCase().replace(/\s+/g, " ");
}

function buildExerciseMuscleGroups(
  exercises: FreeExerciseDbExercise[],
  overrides: Record<string, ExerciseMuscleMapping>,
): Record<string, ExerciseMuscleMapping> {
  return Object.assign(
    Object.fromEntries(
      exercises
        .map((exercise): [string, ExerciseMuscleMapping] => [
          normalizeExerciseName(exercise.name),
          toExerciseMuscleMapping(exercise),
        ])
        .sort(([left], [right]) => left.localeCompare(right)),
    ),
    overrides,
  );
}

function toExerciseMuscleMapping(exercise: FreeExerciseDbExercise): ExerciseMuscleMapping {
  const primaryMuscleGroups = unique(exercise.primaryMuscles.map(normalizeFreeExerciseDbMuscle));
  const primaryMuscleGroupSet = new Set(primaryMuscleGroups);
  const secondaryMuscleGroups = unique(
    exercise.secondaryMuscles.map(normalizeFreeExerciseDbMuscle),
  ).filter((muscleGroup) => !primaryMuscleGroupSet.has(muscleGroup));

  return {
    primaryMuscleGroups,
    ...(secondaryMuscleGroups.length > 0 ? { secondaryMuscleGroups } : {}),
  };
}

function normalizeFreeExerciseDbMuscle(muscleName: FreeExerciseDbMuscle): string {
  return MUSCLE_GROUPS_BY_FREE_EXERCISE_DB_MUSCLE[muscleName];
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
