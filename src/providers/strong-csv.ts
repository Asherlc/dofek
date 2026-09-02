import { createHash } from "node:crypto";
import { resolveRecordLocalTimeContext } from "@dofek/format/record-local-time";
import { resolveProviderActivityType } from "@dofek/training/activity-types";
import { eq } from "drizzle-orm";
import { resolveUserExerciseWithProvenance } from "../db/exercise-provenance.ts";
import type { SyncDatabase } from "../db/index.ts";
import { upsertProviderActivity } from "../db/provider-activity-sync.ts";
import { strengthSet } from "../db/schema/activity.ts";
import { ensureProvider } from "../db/tokens.ts";
import { lookupExerciseMuscleGroups } from "../exercise-metadata.ts";
import type { ImportProvider, SyncError, SyncResult } from "./types.ts";

// ============================================================
// Constants
// ============================================================

export const STRONG_PROVIDER_ID = "strong-csv";

export class StrongCsvValidationError extends Error {
  override name = "StrongCsvValidationError";
}

// ============================================================
// Types
// ============================================================

export interface StrongCsvRow {
  date: string;
  workoutName: string;
  duration: string;
  exerciseName: string;
  setOrder: number;
  weight: number | null;
  reps: number | null;
  distance: number | null;
  seconds: number | null;
  notes: string | null;
  workoutNotes: string | null;
  rpe: number | null;
}

export interface StrongWorkoutGroup {
  date: string;
  workoutName: string;
  duration: string;
  workoutNotes: string | null;
  sets: StrongCsvRow[];
}

// ============================================================
// Pure parsing functions
// ============================================================

export function parseStrongExerciseName(rawName: string): {
  exerciseName: string;
  equipment: string | null;
} {
  const trimmed = rawName.trim();
  if (trimmed.endsWith(")")) {
    const openingParen = trimmed.lastIndexOf("(");
    const exerciseName = trimmed.slice(0, openingParen).trim();
    const equipment = trimmed.slice(openingParen + 1, -1).trim();
    if (openingParen > 0 && exerciseName && equipment) {
      return { exerciseName, equipment };
    }
  }
  return { exerciseName: trimmed, equipment: null };
}

export function parseDurationString(duration: string): number {
  if (!duration) return 0;

  // Try HH:MM:SS format
  const hmsMatch = duration.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (hmsMatch) {
    const [, h = "0", m = "0", s = "0"] = hmsMatch;
    return Number.parseInt(h, 10) * 3600 + Number.parseInt(m, 10) * 60 + Number.parseInt(s, 10);
  }

  // Try Xh Ym format
  const match = duration.match(/^(?:(\d+)h\s*)?(?:(\d+)m)?$/);
  if (!match) return 0;

  const hours = match[1] ? Number.parseInt(match[1], 10) : 0;
  const minutes = match[2] ? Number.parseInt(match[2], 10) : 0;
  return hours * 3600 + minutes * 60;
}

/**
 * Parse RFC 4180 CSV fields from a single line, handling quoted fields.
 */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      fields.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

export function parseOptionalFloat(value: string): number | null {
  const trimmed = value.trim();
  const num = Number.parseFloat(trimmed);
  return Number.isNaN(num) ? null : num;
}

export function parseOptionalInt(value: string): number | null {
  const trimmed = value.trim();
  const num = Number.parseInt(trimmed, 10);
  return Number.isNaN(num) ? null : num;
}

export function parseStrongCsv(csvText: string): StrongWorkoutGroup[] {
  // Strip BOM
  const text = csvText.replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");

  if (lines.length <= 1) return [];

  const header = parseCsvLine(lines[0] ?? "").map((field) => field.trim().toLowerCase());
  const indexFor = (name: string, fallbackIndex: number): number => {
    const index = header.indexOf(name);
    return index >= 0 ? index : fallbackIndex;
  };
  const columns = {
    date: indexFor("date", 0),
    workoutName: indexFor("workout name", 1),
    duration: indexFor("duration", 2),
    exerciseName: indexFor("exercise name", 3),
    setOrder: indexFor("set order", 4),
    weight: indexFor("weight", 5),
    reps: indexFor("reps", 6),
    distance: indexFor("distance", 7),
    seconds: indexFor("seconds", 8),
    notes: indexFor("notes", 9),
    workoutNotes: indexFor("workout notes", 10),
    rpe: indexFor("rpe", 11),
  };

  // Skip header
  const dataLines = lines.slice(1);
  const rows: StrongCsvRow[] = [];

  for (const line of dataLines) {
    const fields = parseCsvLine(line);
    if (fields.length < 7) continue;

    rows.push({
      date: fields[columns.date] ?? "",
      workoutName: fields[columns.workoutName] ?? "",
      duration: fields[columns.duration] ?? "",
      exerciseName: fields[columns.exerciseName] ?? "",
      setOrder: Number.parseInt(fields[columns.setOrder] ?? "0", 10) || 0,
      weight: parseOptionalFloat(fields[columns.weight] ?? ""),
      reps: parseOptionalInt(fields[columns.reps] ?? ""),
      distance: parseOptionalFloat(fields[columns.distance] ?? ""),
      seconds: parseOptionalInt(fields[columns.seconds] ?? ""),
      notes: fields[columns.notes]?.trim() || null,
      workoutNotes: fields[columns.workoutNotes]?.trim() || null,
      rpe: parseOptionalFloat(fields[columns.rpe] ?? ""),
    });
  }

  // Group by date + workout name
  const groupMap = new Map<string, StrongWorkoutGroup>();
  for (const row of rows) {
    const key = `${row.date}|${row.workoutName}`;
    let group = groupMap.get(key);
    if (!group) {
      group = {
        date: row.date,
        workoutName: row.workoutName,
        duration: row.duration,
        workoutNotes: row.workoutNotes,
        sets: [],
      };
      groupMap.set(key, group);
    }
    group.sets.push(row);
    // Capture workout notes from any row that has them
    if (row.workoutNotes && !group.workoutNotes) {
      group.workoutNotes = row.workoutNotes;
    }
  }

  return Array.from(groupMap.values());
}

/** Return the explicit weight unit in a Strong CSV export, if present. */
export function strongCsvWeightUnit(csvText: string): "kg" | "lbs" | null {
  const [headerLine, ...dataLines] = csvText.replace(/^\uFEFF/, "").split(/\r?\n/);
  if (!headerLine) return null;
  const index = parseCsvLine(headerLine)
    .map((field) => field.trim().toLowerCase())
    .indexOf("weight unit");
  if (index < 0) return null;
  const declarations = dataLines
    .filter((line) => line.trim() !== "")
    .map((line) => parseCsvLine(line)[index]?.trim().toLowerCase() ?? "");
  const values = new Set(declarations.filter((value) => value !== ""));
  if (values.size === 0) return null;
  if (declarations.some((value) => value === "") || values.size !== 1) {
    throw new StrongCsvValidationError("Strong CSV must declare one consistent weight unit");
  }
  const [value] = values;
  if (value === "kg" || value === "kgs" || value === "kilograms") return "kg";
  if (value === "lb" || value === "lbs" || value === "pounds") return "lbs";
  throw new StrongCsvValidationError(`Unsupported Strong CSV weight unit: ${value}`);
}

// ============================================================
// Single-workout text format parsing
// ============================================================

const MONTH_NAMES: Record<string, number> = {
  January: 0,
  February: 1,
  March: 2,
  April: 3,
  May: 4,
  June: 5,
  July: 6,
  August: 7,
  September: 8,
  October: 9,
  November: 10,
  December: 11,
};

/**
 * Detect whether the input is Strong's CSV export (vs the single-workout text share format).
 */
export function isStrongCsvFormat(text: string): boolean {
  const header = parseCsvLine(text.replace(/^\uFEFF/, "").split(/\r?\n/, 1)[0] ?? "").map((field) =>
    field.trim().toLowerCase(),
  );
  return ["date", "workout name", "exercise name", "set order"].every((column) =>
    header.includes(column),
  );
}

/**
 * Parse the natural-language date from Strong's text share format.
 * Example: "Friday, April 10, 2026 at 16:39"
 */
export function parseStrongTextDate(dateStr: string): Date {
  const match = dateStr.match(/^\w+,\s+(\w+)\s+(\d{1,2}),\s+(\d{4})\s+at\s+(\d{1,2}):(\d{2})$/);
  if (!match) return new Date(Number.NaN);

  const [, monthName = "", dayStr = "0", yearStr = "0", hourStr = "0", minuteStr = "0"] = match;
  const month = MONTH_NAMES[monthName];
  if (month === undefined) return new Date(Number.NaN);

  return new Date(
    Number.parseInt(yearStr, 10),
    month,
    Number.parseInt(dayStr, 10),
    Number.parseInt(hourStr, 10),
    Number.parseInt(minuteStr, 10),
  );
}

/**
 * Parse Strong's naive CSV timestamp without letting Date normalize impossible
 * calendar values (for example, February 30) into a different workout day.
 */
export function parseStrongWallClockTimestamp(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value.trim());
  if (!match) return new Date(Number.NaN);
  const [, yearText, monthText, dayText, hourText = "00", minuteText = "00", secondText = "00"] =
    match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const parsed = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day &&
    parsed.getUTCHours() === hour &&
    parsed.getUTCMinutes() === minute &&
    parsed.getUTCSeconds() === second
    ? parsed
    : new Date(Number.NaN);
}

// Set line with weight: "Set 1: 50 lb × 13" or "Set 1: 50 lb × 13 [Failure]"
const WEIGHTED_SET_RE = /^Set\s+(\d+):\s+([\d.]+)\s+(lb|kg)\s+×\s+(\d+)(?:\s+\[.*\])?$/;
// Bodyweight set: "Set 1: 8 reps" or "Set 1: 8 reps [Failure]"
const BODYWEIGHT_SET_RE = /^Set\s+(\d+):\s+(\d+)\s+reps(?:\s+\[.*\])?$/;

export interface StrongTextParseResult {
  groups: StrongWorkoutGroup[];
  weightUnit: "kg" | "lbs";
}

/**
 * Parse Strong's single-workout text share format into the same StrongWorkoutGroup structure
 * used by the CSV parser, enabling a unified import pipeline.
 */
export function parseStrongText(text: string): StrongTextParseResult {
  const lines = text.split(/\r?\n/);
  if (lines.length < 2) return { groups: [], weightUnit: "kg" };

  const workoutName = lines[0]?.trim() ?? "";
  const dateLine = lines[1]?.trim() ?? "";
  const parsedDate = parseStrongTextDate(dateLine);

  if (Number.isNaN(parsedDate.getTime())) return { groups: [], weightUnit: "kg" };

  // Format date to match CSV parser output: "YYYY-MM-DD HH:MM:SS"
  const year = parsedDate.getFullYear();
  const month = String(parsedDate.getMonth() + 1).padStart(2, "0");
  const day = String(parsedDate.getDate()).padStart(2, "0");
  const hours = String(parsedDate.getHours()).padStart(2, "0");
  const minutes = String(parsedDate.getMinutes()).padStart(2, "0");
  const dateString = `${year}-${month}-${day} ${hours}:${minutes}:00`;

  const sets: StrongCsvRow[] = [];
  let currentExercise = "";
  let detectedUnit: "kg" | "lbs" | null = null;

  for (let index = 2; index < lines.length; index++) {
    const line = lines[index]?.trim() ?? "";
    if (line === "") continue;

    // Skip share URLs
    if (line.startsWith("http://") || line.startsWith("https://")) continue;

    // Try to match a weighted set line
    const weightedMatch = line.match(WEIGHTED_SET_RE);
    if (weightedMatch) {
      const [, setOrderStr = "0", weightStr = "0", unit = "lb", repsStr = "0"] = weightedMatch;
      if (unit === "lb" && detectedUnit === null) detectedUnit = "lbs";
      if (unit === "kg" && detectedUnit === null) detectedUnit = "kg";

      sets.push({
        date: dateString,
        workoutName,
        duration: "",
        exerciseName: currentExercise,
        setOrder: Number.parseInt(setOrderStr, 10),
        weight: Number.parseFloat(weightStr),
        reps: Number.parseInt(repsStr, 10),
        distance: null,
        seconds: null,
        notes: null,
        workoutNotes: null,
        rpe: null,
      });
      continue;
    }

    // Try to match a bodyweight set line
    const bodyweightMatch = line.match(BODYWEIGHT_SET_RE);
    if (bodyweightMatch) {
      const [, setOrderStr = "0", repsStr = "0"] = bodyweightMatch;
      sets.push({
        date: dateString,
        workoutName,
        duration: "",
        exerciseName: currentExercise,
        setOrder: Number.parseInt(setOrderStr, 10),
        weight: null,
        reps: Number.parseInt(repsStr, 10),
        distance: null,
        seconds: null,
        notes: null,
        workoutNotes: null,
        rpe: null,
      });
      continue;
    }

    // Not a set line and not empty/URL — must be an exercise name
    currentExercise = line;
  }

  if (sets.length === 0) return { groups: [], weightUnit: "kg" };

  const group: StrongWorkoutGroup = {
    date: dateString,
    workoutName,
    duration: "",
    workoutNotes: null,
    sets,
  };

  return { groups: [group], weightUnit: detectedUnit ?? "kg" };
}

// ============================================================
// Import function
// ============================================================

function resolveStrongStartedAt(date: string, timezone?: string): Date {
  const wallClockDate = parseStrongWallClockTimestamp(date);
  if (Number.isNaN(wallClockDate.getTime())) {
    throw new StrongCsvValidationError(`Invalid Strong workout timestamp: ${date}`);
  }
  if (timezone == null) return wallClockDate;

  const resolveStartedAt = (candidate: Date): Date => {
    const context = resolveRecordLocalTimeContext({
      startedAt: candidate,
      timezone,
      source: "device_timezone",
    });
    if (context.startUtcOffsetMinutes === null) {
      throw new Error("Strong timezone context did not include a UTC offset");
    }
    return new Date(wallClockDate.getTime() - context.startUtcOffsetMinutes * 60_000);
  };
  const startedAt = resolveStartedAt(resolveStartedAt(wallClockDate));
  const resolvedContext = resolveRecordLocalTimeContext({
    startedAt,
    timezone,
    source: "device_timezone",
  });
  const resolvedWallClock = new Date(
    startedAt.getTime() + (resolvedContext.startUtcOffsetMinutes ?? 0) * 60_000,
  );
  if (resolvedWallClock.getTime() !== wallClockDate.getTime()) {
    throw new StrongCsvValidationError(
      `Strong workout timestamp does not exist in ${timezone}: ${date}`,
    );
  }
  return startedAt;
}

export async function importStrongCsv(
  db: SyncDatabase,
  csvText: string,
  userId: string,
  weightUnit?: "kg" | "lbs",
  timezone?: string,
): Promise<SyncResult> {
  const start = Date.now();
  const errors: SyncError[] = [];
  let recordsSynced = 0;

  await ensureProvider(db, STRONG_PROVIDER_ID, "Strong", undefined, userId);

  // Auto-detect format: CSV export vs single-workout text share
  let groups: StrongWorkoutGroup[];
  let effectiveWeightUnit: "kg" | "lbs";
  const parsed = (
    [parseStrongText, parseStrongCsv][Number(isStrongCsvFormat(csvText))] ?? parseStrongText
  )(csvText);
  groups = Array.isArray(parsed) ? parsed : parsed.groups;
  if (Array.isArray(parsed)) {
    effectiveWeightUnit =
      strongCsvWeightUnit(csvText) ??
      weightUnit ??
      (() => {
        throw new StrongCsvValidationError(
          "Strong CSV has no Weight Unit declaration; choose kg or lbs before importing",
        );
      })();
  } else {
    effectiveWeightUnit = parsed.weightUnit;
  }
  const groupStartTimes = groups.map((group) => resolveStrongStartedAt(group.date, timezone));
  const exerciseCache = new Map<string, string>();

  for (const [groupIndex, group] of groups.entries()) {
    try {
      const externalId = `strong:${createHash("sha256").update(`${group.date}|${group.workoutName}`).digest("hex").slice(0, 16)}`;

      const startedAt = groupStartTimes[groupIndex];
      if (!startedAt) throw new Error(`Missing validated Strong workout timestamp: ${group.date}`);
      const durationSeconds = parseDurationString(group.duration);
      const endedAt =
        durationSeconds > 0 ? new Date(startedAt.getTime() + durationSeconds * 1000) : null;
      const localTimeContext = timezone
        ? resolveRecordLocalTimeContext({
            startedAt,
            endedAt,
            timezone,
            source: "device_timezone",
          })
        : null;

      const activityRow = await upsertProviderActivity(
        db,
        {
          providerId: STRONG_PROVIDER_ID,
          userId,
          externalId,
          activityType: resolveProviderActivityType("strength", "strength"),
          startedAt,
          endedAt,
          name: group.workoutName,
          notes: group.workoutNotes,
          timezone: localTimeContext?.timezone,
          startUtcOffsetMinutes: localTimeContext?.startUtcOffsetMinutes,
          endUtcOffsetMinutes: localTimeContext?.endUtcOffsetMinutes,
          localTimeSource: localTimeContext?.source,
        },
        {
          activityType: resolveProviderActivityType("strength", "strength"),
          startedAt,
          endedAt,
          name: group.workoutName,
          notes: group.workoutNotes,
          timezone: localTimeContext?.timezone,
          startUtcOffsetMinutes: localTimeContext?.startUtcOffsetMinutes,
          endUtcOffsetMinutes: localTimeContext?.endUtcOffsetMinutes,
          localTimeSource: localTimeContext?.source,
        },
      );

      const activityId = activityRow?.id;
      if (!activityId) continue;

      // Delete old sets, re-insert
      await db.delete(strengthSet).where(eq(strengthSet.activityId, activityId));

      // Track exercise index per exercise name within this workout
      const exerciseIndexMap = new Map<string, number>();
      const setIndexMap = new Map<string, number>();
      let nextExerciseIndex = 0;

      const setRows: (typeof strengthSet.$inferInsert)[] = [];

      for (const csvRow of group.sets) {
        const { exerciseName, equipment } = parseStrongExerciseName(csvRow.exerciseName);
        const cacheKey = `${exerciseName}|${equipment ?? ""}`;
        const inferredMuscleGroups = lookupExerciseMuscleGroups(exerciseName);

        let exerciseId = exerciseCache.get(cacheKey);
        if (!exerciseId) {
          exerciseId = await resolveUserExerciseWithProvenance(db, {
            equipment,
            exerciseType: inferredMuscleGroups ? "STRENGTH" : null,
            muscleGroups: inferredMuscleGroups,
            name: exerciseName,
            providerExerciseId: null,
            providerExerciseName: csvRow.exerciseName,
            providerId: STRONG_PROVIDER_ID,
            userId,
          });
          exerciseCache.set(cacheKey, exerciseId);
        }

        // Compute exercise index (order of first appearance within workout)
        if (!exerciseIndexMap.has(cacheKey)) {
          exerciseIndexMap.set(cacheKey, nextExerciseIndex++);
        }
        const exerciseIndex = exerciseIndexMap.get(cacheKey) ?? 0;
        const setIndex = setIndexMap.get(cacheKey) ?? 0;
        setIndexMap.set(cacheKey, setIndex + 1);

        // Convert weight
        let weightKg = csvRow.weight;
        if (weightKg !== null && effectiveWeightUnit === "lbs") {
          weightKg = Math.round(weightKg * 0.453592 * 1000) / 1000;
        }

        // Convert distance (Strong exports in km)
        const distanceMeters = csvRow.distance !== null ? csvRow.distance * 1000 : null;

        setRows.push({
          activityId,
          exerciseId,
          exerciseIndex,
          setIndex,
          setType:
            csvRow.weight === 0 && csvRow.reps === 0 && (csvRow.seconds ?? 0) > 0
              ? "rest"
              : "working",
          weightKg,
          reps: csvRow.reps,
          distanceMeters,
          durationSeconds: csvRow.seconds,
          rpe: csvRow.rpe,
          notes: csvRow.notes,
        });
      }

      if (setRows.length > 0) {
        await db.insert(strengthSet).values(setRows);
      }

      recordsSynced++;
    } catch (err) {
      if (err instanceof StrongCsvValidationError) throw err;
      errors.push({
        message: `Failed to import workout "${group.workoutName}" on ${group.date}: ${err instanceof Error ? err.message : String(err)}`,
        cause: err,
      });
    }
  }

  return { provider: STRONG_PROVIDER_ID, recordsSynced, errors, duration: Date.now() - start };
}

// ============================================================
// Provider (stub — real import happens via upload endpoint)
// ============================================================

export class StrongCsvProvider implements ImportProvider {
  readonly id = STRONG_PROVIDER_ID;
  readonly name = "Strong";
  readonly importOnly = true as const;

  validate(): string | null {
    return null; // Always valid — file import, no API key needed
  }
}
