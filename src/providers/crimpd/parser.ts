import type { GradeSystem } from "@dofek/training/climbing-grades";
import type { SourceClimbingAttempt, SourceClimbingLogEntry } from "../../db/climbing-log-sync.ts";
import {
  exportBoolean,
  exportCount,
  exportDate,
  exportGrades,
  exportNumber,
  nullableExportText,
  readClimbingCsv,
} from "../../lib/climbing-file.ts";
import { ClimbingImportValidationError } from "../../lib/climbing-import-error.ts";

const workoutHeaders = [
  "DATE",
  "WORKOUT_NAME",
  "TYPE",
  "TARGET",
  "INTENSITY",
  "COMPLETION",
  "WEIGHT_UNIT",
  "LENGTH_UNIT",
  "LB_CIRCUIT",
  "LB_ANGLE",
  "NOTES",
  "LOG_ID",
];
const setHeaders = [
  "LOG_ID",
  "DATE",
  "EXERCISE",
  "ACTIVITY_ORDER",
  "ACTIVITY_NOTES",
  "SET_ORDER",
  "NAME",
  "GRADE",
  "GRADE_SYSTEM",
  "REPS",
  "ASCENT",
  "COMPLETE",
  "EST_WORK_DURATION",
  "EST_REST_DURATION",
  "INTENSITY",
  "RESISTANCE",
  "WEIGHT_UNIT",
  "ANGLE",
  "LB_CIRCUIT",
  "DISTANCE",
  "LENGTH_UNIT",
  "LOCATION",
  "BOARD",
  "BOARD_LAYOUT",
  "WALL_ANGLE",
  "CLIMB_STYLE",
  "LENGTH",
  "HOLD_TYPE",
  "LOCATION_NAME",
  "OTHER_TAGS",
  "NOTES",
];
const gradeSystems: Record<string, GradeSystem> = {
  HUECO: "v_scale",
  FONT: "font",
  YDS: "yds",
  FRENCH: "french",
  UIAA: "uiaa",
  EWBANK: "ewbank",
};
const boardNames: Record<string, string> = {
  kilter_board: "Kilter Board",
  tension_board: "Tension Board",
  moonboard: "MoonBoard",
  grasshopper: "Grasshopper",
  decoy: "Decoy",
  so_ill: "So iLL",
  quantum: "Quantum",
};
type ClimbingHoldType = NonNullable<SourceClimbingLogEntry["holdTypes"]>[number];
const holdTypes: Record<string, ClimbingHoldType> = {
  jugs: "jug",
  edges: "crimp",
  small_crimps: "crimp",
  slopers: "sloper",
  pockets: "pocket",
  pinches: "pinch",
};

export interface CrimpdRecordedSet {
  exerciseName: string;
  exerciseIndex: number;
  setIndex: number;
  reps: number | null;
  distanceMeters: number | null;
  notes: string | null;
  raw: Record<string, string>;
}

export interface CrimpdRecordedWorkout {
  externalId: string;
  loggedAt: Date;
  name: string | null;
  notes: string | null;
  raw: Record<string, string>;
  climbingEntries: SourceClimbingLogEntry[];
  sets: CrimpdRecordedSet[];
}

function requiredText(value: string | undefined, field: string): string {
  const text = nullableExportText(value);
  if (text === null) throw new ClimbingImportValidationError(`Crimpd ${field} is required`);
  return text;
}

function positivePosition(value: string | undefined, field: string): number {
  const position = exportCount(value, `Crimpd ${field}`);
  if (position === null || position < 1)
    throw new ClimbingImportValidationError(`Crimpd ${field} must be a positive integer`);
  return position;
}

function recordedDistance(row: Record<string, string>): number | null {
  const distance = exportNumber(row.DISTANCE, "Crimpd DISTANCE");
  if (distance === null) return null;
  if (distance < 0) throw new ClimbingImportValidationError("Crimpd DISTANCE must not be negative");
  if (row.LENGTH_UNIT === "CM") return distance / 100;
  if (row.LENGTH_UNIT === "IN") return distance * 0.0254;
  return null;
}

/** CSV contract: https://crimpd.com/docs/data-export/ (September 2026). */
export function parseCrimpdExport(workoutsCsv: string, setsCsv: string): CrimpdRecordedWorkout[] {
  const workouts = new Map<string, CrimpdRecordedWorkout>();
  const sourceDates = new Map<string, string>();
  for (const row of readClimbingCsv(workoutsCsv, workoutHeaders, "Crimpd workouts.csv")) {
    const externalId = requiredText(row.LOG_ID, "LOG_ID");
    if (workouts.has(externalId))
      throw new ClimbingImportValidationError("Crimpd duplicate workout LOG_ID");
    const date = requiredText(row.DATE, "DATE");
    exportDate(date, "Crimpd workout");
    if (!date.endsWith("Z"))
      throw new ClimbingImportValidationError("Crimpd workout DATE must be a UTC timestamp");
    workouts.set(externalId, {
      externalId,
      loggedAt: new Date(date),
      name: nullableExportText(row.WORKOUT_NAME),
      notes: nullableExportText(row.NOTES),
      raw: Object.fromEntries(workoutHeaders.map((field) => [field, row[field] ?? ""])),
      climbingEntries: [],
      sets: [],
    });
    sourceDates.set(externalId, date);
  }

  const seenPositions = new Set<string>();
  for (const row of readClimbingCsv(setsCsv, setHeaders, "Crimpd sets.csv")) {
    const logId = requiredText(row.LOG_ID, "set LOG_ID");
    const workout = workouts.get(logId);
    if (!workout)
      throw new ClimbingImportValidationError(`Crimpd set references a missing workout: ${logId}`);
    if (row.DATE !== sourceDates.get(logId))
      throw new ClimbingImportValidationError("Crimpd set DATE does not match its workout");
    const exerciseOrder = positivePosition(row.ACTIVITY_ORDER, "ACTIVITY_ORDER");
    const setOrder = positivePosition(row.SET_ORDER, "SET_ORDER");
    const identity = JSON.stringify([logId, exerciseOrder, setOrder]);
    if (seenPositions.has(identity))
      throw new ClimbingImportValidationError("Crimpd duplicate set position");
    seenPositions.add(identity);
    const completed = exportBoolean(row.ASCENT, "Crimpd ASCENT");
    exportBoolean(row.COMPLETE, "Crimpd COMPLETE");
    const grade = nullableExportText(row.GRADE);
    const location = nullableExportText(row.LOCATION);
    const board = nullableExportText(row.BOARD);
    const climbing = completed !== null || grade !== null || location !== null || board !== null;
    const reps = climbing
      ? exportCount(row.REPS, "Crimpd REPS")
      : exportNumber(row.REPS, "Crimpd REPS");
    if (reps !== null && reps < 0)
      throw new ClimbingImportValidationError("Crimpd REPS must not be negative");
    if (!climbing) {
      workout.sets.push({
        exerciseName: requiredText(row.EXERCISE, "EXERCISE"),
        exerciseIndex: exerciseOrder - 1,
        setIndex: setOrder - 1,
        reps: reps !== null && Number.isInteger(reps) && reps <= 2_147_483_647 ? reps : null,
        distanceMeters: recordedDistance(row),
        notes: nullableExportText(row.NOTES),
        raw: row,
      });
      continue;
    }
    const system = gradeSystems[row.GRADE_SYSTEM ?? ""] ?? null;
    const kind =
      system === "v_scale" || system === "font"
        ? "boulder"
        : system !== null
          ? "route"
          : workout.raw.TARGET === "Bouldering"
            ? "boulder"
            : ["auto_belay", "top_rope", "lead", "circuit_board"].includes(location ?? "")
              ? "route"
              : null;
    const angle = exportNumber(row.ANGLE, "Crimpd ANGLE");
    if (angle !== null && (angle < -90 || angle > 90))
      throw new ClimbingImportValidationError("Crimpd ANGLE must be between -90 and 90 degrees");
    const attempt: SourceClimbingAttempt = {
      scope: "climb",
      sourceCompleted: completed,
      ...(location === "top_rope" || location === "auto_belay"
        ? { ropeMethod: "top_rope" }
        : location === "lead"
          ? { ropeMethod: "lead" }
          : {}),
    };
    const holds = [
      ...new Set(
        (row.HOLD_TYPE ?? "")
          .split("|")
          .map((hold) => holdTypes[hold])
          .filter((hold): hold is ClimbingHoldType => hold !== undefined),
      ),
    ];
    const layout = nullableExportText(row.BOARD_LAYOUT);
    const locationName = nullableExportText(row.LOCATION_NAME);
    workout.climbingEntries.push({
      externalId: `crimpd:set:${identity}`,
      climbedOn: exportDate(row.DATE, "Crimpd set"),
      discipline: "rock_climbing",
      reportedGrades: exportGrades(grade ?? undefined, system),
      ...(reps !== null && reps > 0
        ? { reportedAttemptCounts: [{ scope: "climb", count: reps }] }
        : {}),
      attempts: [attempt],
      notes: nullableExportText(row.NOTES),
      ...(board === null
        ? {}
        : {
            board: {
              name: boardNames[board] ?? board,
              externalId: board + (layout ? `:${layout}` : ""),
            },
          }),
      ...(angle === null ? {} : { wallAngle: { value: angle, unit: "degrees" } }),
      ...(holds.length ? { holdTypes: holds } : {}),
      climb: {
        externalId: null,
        name: nullableExportText(row.NAME),
        kind,
        setting: location === "outdoor" ? "outdoor" : location === null ? null : "indoor",
        ...(locationName ? { areas: [{ name: locationName, externalId: null }] } : {}),
      },
      sourceName: "Crimpd",
      raw: row,
    });
  }
  return [...workouts.values()];
}
