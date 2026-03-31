import { surfaceColors } from "@dofek/scoring/colors";

// ---------------------------------------------------------------------------
// SVG path helpers
// ---------------------------------------------------------------------------

function ellipse(cx: number, cy: number, rx: number, ry: number): string {
  return `M ${cx - rx} ${cy} A ${rx} ${ry} 0 1 1 ${cx + rx} ${cy} A ${rx} ${ry} 0 1 1 ${cx - rx} ${cy} Z`;
}

function roundedRect(x: number, y: number, width: number, height: number, radius: number): string {
  const right = x + width;
  const bottom = y + height;
  return [
    `M ${x + radius} ${y}`,
    `L ${right - radius} ${y}`,
    `Q ${right} ${y} ${right} ${y + radius}`,
    `L ${right} ${bottom - radius}`,
    `Q ${right} ${bottom} ${right - radius} ${bottom}`,
    `L ${x + radius} ${bottom}`,
    `Q ${x} ${bottom} ${x} ${bottom - radius}`,
    `L ${x} ${y + radius}`,
    `Q ${x} ${y} ${x + radius} ${y}`,
    `Z`,
  ].join(" ");
}

// ---------------------------------------------------------------------------
// ViewBox
// ---------------------------------------------------------------------------

export const BODY_VIEWBOX = { width: 170, height: 360 };

// ---------------------------------------------------------------------------
// Path data — keyed by SVG region ID
// ---------------------------------------------------------------------------

/** Front-view muscle group SVG paths. Keys starting with `_` are structural (non-muscle). */
export const FRONT_PATHS: Record<string, string[]> = {
  // Structural (neutral fill)
  _head: [ellipse(85, 22, 13, 16)],
  _neck: [roundedRect(79, 39, 12, 14, 3)],
  _leftHand: [ellipse(24, 198, 7, 10)],
  _rightHand: [ellipse(146, 198, 7, 10)],
  _leftFoot: [ellipse(63, 326, 11, 8)],
  _rightFoot: [ellipse(107, 326, 11, 8)],

  // Muscle groups
  SHOULDERS: [
    ellipse(38, 62, 14, 10), // left deltoid
    ellipse(132, 62, 14, 10), // right deltoid
  ],
  CHEST: [
    ellipse(72, 84, 16, 13), // left pec
    ellipse(98, 84, 16, 13), // right pec
  ],
  BICEPS: [
    roundedRect(22, 74, 16, 54, 6), // left
    roundedRect(132, 74, 16, 54, 6), // right
  ],
  FOREARMS: [
    roundedRect(16, 132, 14, 58, 5), // left
    roundedRect(140, 132, 14, 58, 5), // right
  ],
  ABS: [roundedRect(68, 100, 34, 48, 5)],
  OBLIQUES: [
    roundedRect(54, 102, 12, 44, 4), // left
    roundedRect(104, 102, 12, 44, 4), // right
  ],
  QUADS: [
    roundedRect(48, 156, 28, 90, 8), // left
    roundedRect(94, 156, 28, 90, 8), // right
  ],
  CALVES: [
    roundedRect(52, 252, 22, 64, 6), // left
    roundedRect(96, 252, 22, 64, 6), // right
  ],
};

/** Back-view muscle group SVG paths. Keys starting with `_` are structural (non-muscle). */
export const BACK_PATHS: Record<string, string[]> = {
  // Structural
  _head: [ellipse(85, 22, 13, 16)],
  _neck: [roundedRect(79, 39, 12, 14, 3)],
  _leftHand: [ellipse(24, 198, 7, 10)],
  _rightHand: [ellipse(146, 198, 7, 10)],
  _leftFoot: [ellipse(63, 326, 11, 8)],
  _rightFoot: [ellipse(107, 326, 11, 8)],

  // Muscle groups
  TRAPS: ["M 85 50 L 66 62 L 62 82 L 85 92 L 108 82 L 104 62 Z"],
  SHOULDERS: [
    ellipse(38, 62, 14, 10), // left rear delt
    ellipse(132, 62, 14, 10), // right rear delt
  ],
  LATS: [
    roundedRect(50, 82, 16, 50, 5), // left
    roundedRect(104, 82, 16, 50, 5), // right
  ],
  UPPER_BACK: [roundedRect(68, 82, 34, 28, 4)],
  TRICEPS: [
    roundedRect(22, 74, 16, 54, 6), // left
    roundedRect(132, 74, 16, 54, 6), // right
  ],
  FOREARMS: [
    roundedRect(16, 132, 14, 58, 5), // left
    roundedRect(140, 132, 14, 58, 5), // right
  ],
  LOWER_BACK: [roundedRect(62, 114, 46, 36, 5)],
  GLUTES: [
    ellipse(68, 162, 16, 12), // left
    ellipse(102, 162, 16, 12), // right
  ],
  HAMSTRINGS: [
    roundedRect(48, 178, 28, 64, 8), // left
    roundedRect(94, 178, 28, 64, 8), // right
  ],
  CALVES: [
    roundedRect(52, 252, 22, 64, 6), // left
    roundedRect(96, 252, 22, 64, 6), // right
  ],
};

// ---------------------------------------------------------------------------
// Labels — human-readable display names
// ---------------------------------------------------------------------------

const MUSCLE_GROUP_LABELS: Record<string, string> = {
  SHOULDERS: "Shoulders",
  CHEST: "Chest",
  BICEPS: "Biceps",
  TRICEPS: "Triceps",
  FOREARMS: "Forearms",
  ABS: "Abs",
  OBLIQUES: "Obliques",
  QUADS: "Quads",
  QUADRICEPS: "Quads",
  HAMSTRINGS: "Hamstrings",
  CALVES: "Calves",
  GLUTES: "Glutes",
  TRAPS: "Traps",
  LATS: "Lats",
  UPPER_BACK: "Upper Back",
  LOWER_BACK: "Lower Back",
  BACK: "Back",
  CORE: "Core",
  LEGS: "Legs",
  ARMS: "Arms",
};

export function muscleGroupLabel(group: string): string {
  return MUSCLE_GROUP_LABELS[group.toUpperCase()] ?? titleCase(group);
}

function titleCase(value: string): string {
  return value
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

// ---------------------------------------------------------------------------
// Coarse-to-fine mapping: distribute data from broad groups to SVG regions
// ---------------------------------------------------------------------------

/**
 * Maps a coarse WHOOP muscle group name (e.g. "BACK") to the fine-grained
 * SVG region IDs it should color. Fine-grained names map to themselves.
 */
const COARSE_TO_FINE: Record<string, string[]> = {
  BACK: ["TRAPS", "LATS", "UPPER_BACK", "LOWER_BACK"],
  CORE: ["ABS", "OBLIQUES"],
  LEGS: ["QUADS", "HAMSTRINGS", "CALVES", "GLUTES"],
  ARMS: ["BICEPS", "TRICEPS", "FOREARMS"],
  QUADRICEPS: ["QUADS"],
  TRAPEZIUS: ["TRAPS"],
  LATISSIMUS: ["LATS"],
  ABDOMINALS: ["ABS"],
  DELTOIDS: ["SHOULDERS"],
  DELTS: ["SHOULDERS"],
};

/** Expand a muscle group name to SVG region IDs. */
export function expandMuscleGroup(group: string): string[] {
  const upper = group.toUpperCase();
  return COARSE_TO_FINE[upper] ?? [upper];
}

// ---------------------------------------------------------------------------
// Data aggregation
// ---------------------------------------------------------------------------

export interface MuscleGroupInput {
  muscleGroup: string;
  weeklyData: { week: string; sets: number }[];
}

/**
 * Compute total sets per SVG region from the API data.
 * Handles coarse-to-fine expansion (e.g., "BACK" distributes evenly
 * across TRAPS, LATS, UPPER_BACK, LOWER_BACK).
 */
export function computeRegionTotals(data: MuscleGroupInput[]): Map<string, number> {
  const totals = new Map<string, number>();

  for (const group of data) {
    const totalSets = group.weeklyData.reduce((sum, week) => sum + week.sets, 0);
    const regions = expandMuscleGroup(group.muscleGroup);
    const setsPerRegion = totalSets / regions.length;

    for (const region of regions) {
      totals.set(region, (totals.get(region) ?? 0) + setsPerRegion);
    }
  }

  return totals;
}

/**
 * Normalize region totals to 0-1 intensity values (relative to max).
 */
export function computeIntensities(regionTotals: Map<string, number>): Map<string, number> {
  const maxSets = Math.max(0, ...regionTotals.values());
  if (maxSets === 0) return new Map();

  const intensities = new Map<string, number>();
  for (const [region, sets] of regionTotals) {
    intensities.set(region, sets / maxSets);
  }
  return intensities;
}

// ---------------------------------------------------------------------------
// Color scale
// ---------------------------------------------------------------------------

const UNTRAINED_COLOR = surfaceColors.surfaceSecondary;
const STRUCTURAL_COLOR = "#d5dbd4";

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
  if (intensity <= 0) return UNTRAINED_COLOR;
  const clamped = Math.min(1, intensity);
  const red = lerp(MIN_RGB.red, MAX_RGB.red, clamped);
  const green = lerp(MIN_RGB.green, MAX_RGB.green, clamped);
  const blue = lerp(MIN_RGB.blue, MAX_RGB.blue, clamped);
  return `#${toHex(red)}${toHex(green)}${toHex(blue)}`;
}

/** Color for structural (non-muscle) elements like head, hands, feet. */
export { STRUCTURAL_COLOR, UNTRAINED_COLOR };
