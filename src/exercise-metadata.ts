import exerciseMetadataOverrides from "./exercise-metadata-overrides.json" with { type: "json" };
import freeExerciseDbExercises from "./free-exercise-db.json" with { type: "json" };

export interface ExerciseMuscleMapping {
  primaryMuscleGroups: string[];
  secondaryMuscleGroups?: string[];
}

interface FreeExerciseDbExercise {
  name: string;
  primaryMuscles: string[];
  secondaryMuscles: string[];
}

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
} as const satisfies Record<string, string>;

type FreeExerciseDbMuscle = keyof typeof MUSCLE_GROUPS_BY_FREE_EXERCISE_DB_MUSCLE;

export const EXERCISE_MUSCLE_GROUPS: Record<string, ExerciseMuscleMapping> =
  buildExerciseMuscleGroups(
    freeExerciseDbExercises satisfies FreeExerciseDbExercise[],
    exerciseMetadataOverrides,
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

function normalizeFreeExerciseDbMuscle(muscleName: string): string {
  if (!isFreeExerciseDbMuscle(muscleName)) {
    throw new Error(`Unsupported Free Exercise DB muscle: ${muscleName}`);
  }
  return MUSCLE_GROUPS_BY_FREE_EXERCISE_DB_MUSCLE[muscleName];
}

function isFreeExerciseDbMuscle(muscleName: string): muscleName is FreeExerciseDbMuscle {
  return muscleName in MUSCLE_GROUPS_BY_FREE_EXERCISE_DB_MUSCLE;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}
