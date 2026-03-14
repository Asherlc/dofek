import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Database } from "../db/index.ts";
import { exercise, exerciseAlias, strengthSet, strengthWorkout } from "../db/schema.ts";
import { ensureProvider } from "../db/tokens.ts";
import type { Provider, SyncError, SyncResult } from "./types.ts";

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
    // Stryker disable next-line all — regex groups (.+?) and ([^)]+) always capture non-empty; guard is unreachable
    if (!name || !equip) return { exerciseName: trimmed, equipment: null };
    return { exerciseName: name.trim(), equipment: equip.trim() };
  }
  return { exerciseName: trimmed, equipment: null };
}

export function parseDurationString(duration: string): number {
  if (!duration) return 0;

  // Try HH:MM:SS format
  const hmsMatch = duration.match(/^(\d{1,2}):(\d{2}):(\d{2})$/);
  if (hmsMatch) {
    // Stryker disable all — regex capture groups (\d{1,2}), (\d{2}), (\d{2}) always present on match
    const h = hmsMatch[1] ?? "0";
    const m = hmsMatch[2] ?? "0";
    const s = hmsMatch[3] ?? "0";
    // Stryker restore all
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

// Stryker disable all — mutations are equivalent: all code paths produce null for invalid input regardless of guard order
function parseOptionalFloat(value: string): number | null {
  if (!value || value.trim() === "") return null;
  const num = Number.parseFloat(value);
  return Number.isNaN(num) ? null : num;
}

function parseOptionalInt(value: string): number | null {
  if (!value || value.trim() === "") return null;
  const num = Number.parseInt(value, 10);
  return Number.isNaN(num) ? null : num;
}
// Stryker restore all

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

    // Stryker disable all — indices 0-6 always exist (length >= 7 checked); parseOptional* returns null for any non-numeric fallback string
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
    // Stryker restore all
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
// Import function
// ============================================================

// Stryker disable all — DB import function only tested via integration tests
export async function importStrongCsv(
  db: Database,
  csvText: string,
  userId: string,
  weightUnit: "kg" | "lbs",
): Promise<SyncResult> {
  const start = Date.now();
  const errors: SyncError[] = [];
  let recordsSynced = 0;

  await ensureProvider(db, STRONG_PROVIDER_ID, "Strong");

  const groups = parseStrongCsv(csvText);
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
          target: [strengthWorkout.providerId, strengthWorkout.externalId],
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
        if (weightKg !== null && weightUnit === "lbs") {
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

// Stryker restore all

// ============================================================
// Provider (stub — real import happens via upload endpoint)
// ============================================================

// Stryker disable all — stub provider, no meaningful logic to mutate
export class StrongCsvProvider implements Provider {
  readonly id = STRONG_PROVIDER_ID;
  readonly name = "Strong";

  validate(): string | null {
    return null; // Always valid — file import, no API key needed
  }

  async sync(_db: Database, _since: Date): Promise<SyncResult> {
    return { provider: this.id, recordsSynced: 0, errors: [], duration: 0 };
  }
}
