import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { SyncDatabase } from "../db/index.ts";
import { exercise, exerciseAlias, strengthSet, strengthWorkout } from "../db/schema.ts";
import { ensureProvider } from "../db/tokens.ts";
import type { ImportProvider, SyncError, SyncResult } from "./types.ts";

// ============================================================
// Constants
// ============================================================

export const STRONG_PROVIDER_ID = "strong-csv";

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
  const match = trimmed.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (match) {
    const name = match[1];
    const equip = match[2];
    return { exerciseName: (name ?? trimmed).trim(), equipment: (equip ?? "").trim() || null };
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
  if (trimmed === "") return null;
  const num = Number.parseFloat(trimmed);
  return Number.isNaN(num) ? null : num;
}

export function parseOptionalInt(value: string): number | null {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const num = Number.parseInt(trimmed, 10);
  return Number.isNaN(num) ? null : num;
}

export function parseStrongCsv(csvText: string): StrongWorkoutGroup[] {
  // Strip BOM
  const text = csvText.replace(/^\uFEFF/, "");
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== "");

  if (lines.length <= 1) return [];

  // Skip header
  const dataLines = lines.slice(1);
  const rows: StrongCsvRow[] = [];

  for (const line of dataLines) {
    const fields = parseCsvLine(line);
    if (fields.length < 7) continue;

    rows.push({
      date: fields[0] ?? "",
      workoutName: fields[1] ?? "",
      duration: fields[2] ?? "",
      exerciseName: fields[3] ?? "",
      setOrder: Number.parseInt(fields[4] ?? "0", 10) || 0,
      weight: parseOptionalFloat(fields[5] ?? ""),
      reps: parseOptionalInt(fields[6] ?? ""),
      distance: parseOptionalFloat(fields[7] ?? ""),
      seconds: parseOptionalInt(fields[8] ?? ""),
      notes: fields[9]?.trim() || null,
      workoutNotes: fields[10]?.trim() || null,
      rpe: parseOptionalFloat(fields[11] ?? ""),
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

const STRONG_CSV_HEADER_PREFIX = "Date,Workout Name,Duration,Exercise Name,Set Order";

/**
 * Detect whether the input is Strong's CSV export (vs the single-workout text share format).
 */
export function isStrongCsvFormat(text: string): boolean {
  const cleaned = text.replace(/^\uFEFF/, "");
  return cleaned.startsWith(STRONG_CSV_HEADER_PREFIX);
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

export async function importStrongCsv(
  db: SyncDatabase,
  csvText: string,
  userId: string,
  weightUnit: "kg" | "lbs",
): Promise<SyncResult> {
  const start = Date.now();
  const errors: SyncError[] = [];
  let recordsSynced = 0;

  await ensureProvider(db, STRONG_PROVIDER_ID, "Strong", undefined, userId);

  // Auto-detect format: CSV export vs single-workout text share
  let groups: StrongWorkoutGroup[];
  let effectiveWeightUnit = weightUnit;
  if (isStrongCsvFormat(csvText)) {
    groups = parseStrongCsv(csvText);
  } else {
    const textResult = parseStrongText(csvText);
    groups = textResult.groups;
    effectiveWeightUnit = textResult.weightUnit;
  }
  const exerciseCache = new Map<string, string>();

  for (const group of groups) {
    try {
      const externalId = `strong:${createHash("sha256").update(`${group.date}|${group.workoutName}`).digest("hex").slice(0, 16)}`;

      const startedAt = new Date(group.date);
      const durationSeconds = parseDurationString(group.duration);
      const endedAt =
        durationSeconds > 0 ? new Date(startedAt.getTime() + durationSeconds * 1000) : null;

      // Upsert workout
      const [row] = await db
        .insert(strengthWorkout)
        .values({
          providerId: STRONG_PROVIDER_ID,
          userId,
          externalId,
          startedAt,
          endedAt,
          name: group.workoutName,
          notes: group.workoutNotes,
        })
        .onConflictDoUpdate({
          target: [strengthWorkout.userId, strengthWorkout.providerId, strengthWorkout.externalId],
          set: {
            startedAt,
            endedAt,
            name: group.workoutName,
            notes: group.workoutNotes,
          },
        })
        .returning({ id: strengthWorkout.id });

      const workoutId = row?.id;
      if (!workoutId) continue;

      // Delete old sets, re-insert
      await db.delete(strengthSet).where(eq(strengthSet.workoutId, workoutId));

      // Track exercise index per exercise name within this workout
      const exerciseIndexMap = new Map<string, number>();
      let nextExerciseIndex = 0;

      const setRows: (typeof strengthSet.$inferInsert)[] = [];

      for (const csvRow of group.sets) {
        const { exerciseName, equipment } = parseStrongExerciseName(csvRow.exerciseName);
        const cacheKey = `${exerciseName}|${equipment ?? ""}`;

        let exerciseId = exerciseCache.get(cacheKey);
        if (!exerciseId) {
          // Upsert exercise
          await db.insert(exercise).values({ name: exerciseName, equipment }).onConflictDoNothing();

          const whereClause = equipment
            ? and(eq(exercise.name, exerciseName), eq(exercise.equipment, equipment))
            : and(eq(exercise.name, exerciseName));

          const exerciseRows = await db
            .select({ id: exercise.id })
            .from(exercise)
            .where(whereClause)
            .limit(1);

          exerciseId = exerciseRows[0]?.id;
          if (exerciseId) {
            exerciseCache.set(cacheKey, exerciseId);

            // Upsert alias
            await db
              .insert(exerciseAlias)
              .values({
                exerciseId,
                providerId: STRONG_PROVIDER_ID,
                providerExerciseName: csvRow.exerciseName,
              })
              .onConflictDoNothing();
          }
        }

        if (!exerciseId) {
          errors.push({ message: `Could not resolve exercise: ${csvRow.exerciseName}` });
          continue;
        }

        // Compute exercise index (order of first appearance within workout)
        if (!exerciseIndexMap.has(csvRow.exerciseName)) {
          exerciseIndexMap.set(csvRow.exerciseName, nextExerciseIndex++);
        }
        const exerciseIndex = exerciseIndexMap.get(csvRow.exerciseName) ?? 0;

        // Convert weight
        let weightKg = csvRow.weight;
        if (weightKg !== null && effectiveWeightUnit === "lbs") {
          weightKg = Math.round(weightKg * 0.453592 * 1000) / 1000;
        }

        // Convert distance (Strong exports in km)
        const distanceMeters = csvRow.distance !== null ? csvRow.distance * 1000 : null;

        setRows.push({
          workoutId,
          exerciseId,
          exerciseIndex,
          setIndex: csvRow.setOrder - 1, // Strong is 1-indexed
          setType: "working", // Strong doesn't distinguish set types
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
