import { surfaceColors } from "@dofek/scoring/colors";

// ---------------------------------------------------------------------------
// Slug type — matches react-native-body-highlighter slugs
// ---------------------------------------------------------------------------

export type BodySlug =
  | "abs"
  | "biceps"
  | "calves"
  | "chest"
  | "deltoids"
  | "forearm"
  | "gluteal"
  | "hamstring"
  | "lower-back"
  | "obliques"
  | "quadriceps"
  | "trapezius"
  | "triceps"
  | "upper-back";

// ---------------------------------------------------------------------------
// Labels — human-readable display names for slugs
// ---------------------------------------------------------------------------

const SLUG_LABELS: Record<string, string> = {
  abs: "Abs",
  biceps: "Biceps",
  calves: "Calves",
  chest: "Chest",
  deltoids: "Shoulders",
  forearm: "Forearms",
  gluteal: "Glutes",
  hamstring: "Hamstrings",
  "lower-back": "Lower Back",
  obliques: "Obliques",
  quadriceps: "Quads",
  trapezius: "Traps",
  triceps: "Triceps",
  "upper-back": "Upper Back",
};

export function muscleGroupLabel(slug: string): string {
  return SLUG_LABELS[slug] ?? titleCase(slug);
}

function titleCase(value: string): string {
  return value.replace(/-/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

// ---------------------------------------------------------------------------
// WHOOP group → library slug mapping
// ---------------------------------------------------------------------------

/**
 * Maps a WHOOP muscle group name to body-highlighter library slugs.
 * Coarse groups (BACK, LEGS, CORE) are distributed across multiple slugs.
 */
const WHOOP_TO_SLUGS: Record<string, BodySlug[]> = {
  CHEST: ["chest"],
  BACK: ["trapezius", "upper-back", "lower-back"],
  SHOULDERS: ["deltoids"],
  BICEPS: ["biceps"],
  TRICEPS: ["triceps"],
  FOREARMS: ["forearm"],
  CORE: ["abs", "obliques"],
  ABS: ["abs"],
  OBLIQUES: ["obliques"],
  LEGS: ["quadriceps", "hamstring", "calves", "gluteal"],
  QUADRICEPS: ["quadriceps"],
  QUADS: ["quadriceps"],
  HAMSTRINGS: ["hamstring"],
  CALVES: ["calves"],
  GLUTES: ["gluteal"],
  GLUTEAL: ["gluteal"],
  TRAPS: ["trapezius"],
  TRAPEZIUS: ["trapezius"],
  LATS: ["upper-back"],
  UPPER_BACK: ["upper-back"],
  LOWER_BACK: ["lower-back"],
  DELTOIDS: ["deltoids"],
  DELTS: ["deltoids"],
  ARMS: ["biceps", "triceps", "forearm"],
  ABDOMINALS: ["abs"],
  LATISSIMUS: ["upper-back"],
};

/** Expand a WHOOP muscle group name to library-compatible slugs. */
export function expandMuscleGroup(group: string): string[] {
  const upper = group.toUpperCase();
  return WHOOP_TO_SLUGS[upper] ?? [group.toLowerCase()];
}

// ---------------------------------------------------------------------------
// Data aggregation
// ---------------------------------------------------------------------------

export interface MuscleGroupInput {
  muscleGroup: string;
  weeklyData: { week: string; sets: number }[];
}

/**
 * Compute total sets per slug from the API data.
 * Handles coarse-to-fine expansion (e.g., "BACK" distributes evenly
 * across trapezius, upper-back, lower-back).
 */
export function computeSlugTotals(data: MuscleGroupInput[]): Map<string, number> {
  const totals = new Map<string, number>();

  for (const group of data) {
    const totalSets = group.weeklyData.reduce((sum, week) => sum + week.sets, 0);
    const slugs = expandMuscleGroup(group.muscleGroup);
    const setsPerSlug = totalSets / slugs.length;

    for (const slug of slugs) {
      totals.set(slug, (totals.get(slug) ?? 0) + setsPerSlug);
    }
  }

  return totals;
}

/**
 * Normalize slug totals to 0-1 intensity values (relative to max).
 */
export function computeIntensities(slugTotals: Map<string, number>): Map<string, number> {
  const maxSets = Math.max(0, ...slugTotals.values());
  if (maxSets === 0) return new Map();

  const intensities = new Map<string, number>();
  for (const [slug, sets] of slugTotals) {
    intensities.set(slug, sets / maxSets);
  }
  return intensities;
}

// ---------------------------------------------------------------------------
// Color scale
// ---------------------------------------------------------------------------

/** Number of discrete color buckets for the gradient. */
export const COLOR_BUCKET_COUNT = 5;

// Green gradient endpoints
const MIN_RGB = { red: 200, green: 228, blue: 212 };
const MAX_RGB = { red: 45, green: 122, blue: 86 };

function lerp(from: number, to: number, ratio: number): number {
  return Math.round(from + (to - from) * ratio);
}

function toHex(value: number): string {
  return value.toString(16).padStart(2, "0");
}

/** Color for a trained muscle group at the given intensity (0-1). */
export function muscleGroupFillColor(intensity: number): string {
  if (intensity <= 0) return surfaceColors.surfaceSecondary;
  const clamped = Math.min(1, intensity);
  const red = lerp(MIN_RGB.red, MAX_RGB.red, clamped);
  const green = lerp(MIN_RGB.green, MAX_RGB.green, clamped);
  const blue = lerp(MIN_RGB.blue, MAX_RGB.blue, clamped);
  return `#${toHex(red)}${toHex(green)}${toHex(blue)}`;
}

/**
 * Pre-computed array of N colors from lightest to darkest green,
 * suitable for the `highlightedColors` / `colors` props of body highlighter libs.
 */
export const INTENSITY_COLORS: string[] = Array.from({ length: COLOR_BUCKET_COUNT }, (_, index) =>
  muscleGroupFillColor((index + 1) / COLOR_BUCKET_COUNT),
);

/**
 * Convert a 0-1 intensity to a 1-based bucket index (for library `frequency`/`intensity` props).
 */
export function intensityToBucket(intensity: number): number {
  if (intensity <= 0) return 0;
  return Math.max(1, Math.min(COLOR_BUCKET_COUNT, Math.ceil(intensity * COLOR_BUCKET_COUNT)));
}
