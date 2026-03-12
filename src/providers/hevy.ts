import { and, eq } from "drizzle-orm";
import type { Database } from "../db/index.ts";
import { exercise, exerciseAlias, strengthSet, strengthWorkout } from "../db/schema.ts";
import { ensureProvider } from "../db/tokens.ts";
import type { Provider, SyncError, SyncResult } from "./types.ts";

// ============================================================
// Hevy API types
// ============================================================

export interface HevySet {
  index: number;
  type: string;
  weight_kg: number | null;
  reps: number | null;
  distance_meters: number | null;
  duration_seconds: number | null;
  rpe: number | null;
  custom_metric: number | null;
}

export interface HevyExercise {
  index: number;
  title: string;
  notes: string | null;
  exercise_template_id: string;
  supersets_id: number | null;
  sets: HevySet[];
}

export interface HevyWorkout {
  id: string;
  title: string | null;
  description: string | null;
  start_time: string;
  end_time: string | null;
  updated_at: string;
  created_at: string;
  exercises: HevyExercise[];
}

export interface HevyExerciseTemplate {
  id: string;
  title: string;
  type: string;
  primary_muscle_group: string | null;
  secondary_muscle_groups: string[];
  is_custom: boolean;
}

interface HevyUpdatedEvent {
  type: "updated";
  workout: HevyWorkout;
}

interface HevyDeletedEvent {
  type: "deleted";
  id: string;
  deleted_at: string;
}

type HevyWorkoutEvent = HevyUpdatedEvent | HevyDeletedEvent;

interface HevyPaginatedWorkoutEvents {
  page: number;
  page_count: number;
  events: HevyWorkoutEvent[];
}

interface HevyExerciseTemplateListResponse {
  page: number;
  page_count: number;
  exercise_templates: HevyExerciseTemplate[];
}

// ============================================================
// Set type mapping
// ============================================================

const HEVY_SET_TYPE_MAP: Record<string, "working" | "warmup" | "failure" | "dropset"> = {
  normal: "working",
  warmup: "warmup",
  failure: "failure",
  dropset: "dropset",
};

export function mapSetType(hevyType: string): "working" | "warmup" | "failure" | "dropset" {
  return HEVY_SET_TYPE_MAP[hevyType] ?? "working";
}

// ============================================================
// Pure parsing functions
// ============================================================

export interface ParsedStrengthWorkout {
  externalId: string;
  startedAt: Date;
  endedAt: Date | null;
  name: string | null;
  notes: string | null;
}

export function parseWorkout(workout: HevyWorkout): ParsedStrengthWorkout {
  return {
    externalId: workout.id,
    startedAt: new Date(workout.start_time),
    endedAt: workout.end_time ? new Date(workout.end_time) : null,
    name: workout.title ?? null,
    notes: workout.description ?? null,
  };
}

export interface ParsedSet {
  exerciseTemplateId: string;
  exerciseTitle: string;
  exerciseIndex: number;
  setIndex: number;
  setType: "working" | "warmup" | "failure" | "dropset";
  weightKg: number | null;
  reps: number | null;
  distanceMeters: number | null;
  durationSeconds: number | null;
  rpe: number | null;
  notes: string | null;
}

export function parseSets(workout: HevyWorkout): ParsedSet[] {
  const sets: ParsedSet[] = [];
  for (const ex of workout.exercises) {
    for (const set of ex.sets) {
      sets.push({
        exerciseTemplateId: ex.exercise_template_id,
        exerciseTitle: ex.title,
        exerciseIndex: ex.index,
        setIndex: set.index,
        setType: mapSetType(set.type),
        weightKg: set.weight_kg,
        reps: set.reps,
        distanceMeters: set.distance_meters,
        durationSeconds: set.duration_seconds,
        rpe: set.rpe,
        notes: ex.notes ?? null,
      });
    }
  }
  return sets;
}

export interface ParsedExerciseTemplate {
  templateId: string;
  name: string;
  muscleGroup: string | null;
}

export function parseExerciseTemplate(template: HevyExerciseTemplate): ParsedExerciseTemplate {
  return {
    templateId: template.id,
    name: template.title,
    muscleGroup: template.primary_muscle_group ?? null,
  };
}

// ============================================================
// API client
// ============================================================

const HEVY_API_BASE = "https://api.hevyapp.com";

export class HevyClient {
  private apiKey: string;
  private fetchFn: typeof globalThis.fetch;

  constructor(apiKey: string, fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.apiKey = apiKey;
    this.fetchFn = fetchFn;
  }

  private async get<T>(path: string, params?: Record<string, string>): Promise<T> {
    const url = new URL(path, HEVY_API_BASE);
    if (params) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, value);
      }
    }
    const response = await this.fetchFn(url.toString(), {
      headers: { "api-key": this.apiKey },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Hevy API error (${response.status}): ${text}`);
    }
    return response.json() as Promise<T>;
  }

  async getWorkoutEvents(page: number, since: Date): Promise<HevyPaginatedWorkoutEvents> {
    return this.get<HevyPaginatedWorkoutEvents>("/v1/workouts/events", {
      page: String(page),
      pageSize: "10",
      since: since.toISOString(),
    });
  }

  async getExerciseTemplates(page: number): Promise<HevyExerciseTemplateListResponse> {
    return this.get<HevyExerciseTemplateListResponse>("/v1/exercise_templates", {
      page: String(page),
      pageSize: "100",
    });
  }
}

// ============================================================
// Provider
// ============================================================

export class HevyProvider implements Provider {
  readonly id = "hevy";
  readonly name = "Hevy";
  private fetchFn: typeof globalThis.fetch;

  constructor(fetchFn: typeof globalThis.fetch = globalThis.fetch) {
    this.fetchFn = fetchFn;
  }

  validate(): string | null {
    if (!process.env.HEVY_API_KEY) return "HEVY_API_KEY is not set";
    return null;
  }

  async sync(db: Database, since: Date): Promise<SyncResult> {
    const start = Date.now();
    const errors: SyncError[] = [];
    let recordsSynced = 0;

    const apiKey = process.env.HEVY_API_KEY;
    if (!apiKey) {
      return {
        provider: this.id,
        recordsSynced: 0,
        errors: [{ message: "HEVY_API_KEY is not set" }],
        duration: Date.now() - start,
      };
    }

    const client = new HevyClient(apiKey, this.fetchFn);
    await ensureProvider(db, this.id, this.name, HEVY_API_BASE);

    // Phase 1: sync exercise templates and build alias map
    const templateIdToExerciseId = await this.syncExerciseTemplates(db, client, errors);

    // Phase 2: paginate workout events and upsert/delete
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      const response = await client.getWorkoutEvents(page, since);

      for (const event of response.events) {
        if (event.type === "deleted") {
          try {
            await db
              .delete(strengthWorkout)
              .where(
                and(
                  eq(strengthWorkout.providerId, this.id),
                  eq(strengthWorkout.externalId, event.id),
                ),
              );
          } catch (err) {
            errors.push({
              message: `Failed to delete workout ${event.id}: ${err instanceof Error ? err.message : String(err)}`,
              externalId: event.id,
              cause: err,
            });
          }
          continue;
        }

        // type === "updated"
        try {
          const parsed = parseWorkout(event.workout);
          const [row] = await db
            .insert(strengthWorkout)
            .values({
              providerId: this.id,
              externalId: parsed.externalId,
              startedAt: parsed.startedAt,
              endedAt: parsed.endedAt,
              name: parsed.name,
              notes: parsed.notes,
            })
            .onConflictDoUpdate({
              target: [strengthWorkout.providerId, strengthWorkout.externalId],
              set: {
                startedAt: parsed.startedAt,
                endedAt: parsed.endedAt,
                name: parsed.name,
                notes: parsed.notes,
              },
            })
            .returning({ id: strengthWorkout.id });

          const workoutId = row?.id;
          if (!workoutId) continue;

          // Delete old sets, then insert new ones
          await db.delete(strengthSet).where(eq(strengthSet.workoutId, workoutId));

          const parsedSets = parseSets(event.workout);
          const setRows = await this.buildSetRows(
            parsedSets,
            workoutId,
            templateIdToExerciseId,
            db,
            errors,
          );
          if (setRows.length > 0) {
            await db.insert(strengthSet).values(setRows);
          }

          recordsSynced++;
        } catch (err) {
          errors.push({
            message: `Failed to sync workout ${event.workout.id}: ${err instanceof Error ? err.message : String(err)}`,
            externalId: event.workout.id,
            cause: err,
          });
        }
      }

      hasMore = page < response.page_count;
      page++;
    }

    return { provider: this.id, recordsSynced, errors, duration: Date.now() - start };
  }

  private async syncExerciseTemplates(
    db: Database,
    client: HevyClient,
    errors: SyncError[],
  ): Promise<Map<string, string>> {
    let page = 1;
    let hasMore = true;

    while (hasMore) {
      try {
        const response = await client.getExerciseTemplates(page);

        for (const template of response.exercise_templates) {
          const parsed = parseExerciseTemplate(template);

          // Upsert exercise
          await db
            .insert(exercise)
            .values({
              name: parsed.name,
              muscleGroup: parsed.muscleGroup,
            })
            .onConflictDoNothing();

          // Look up the exercise ID
          const [exerciseRow] = await db
            .select({ id: exercise.id })
            .from(exercise)
            .where(and(eq(exercise.name, parsed.name), eq(exercise.equipment, "")))
            .limit(1);

          // Try with null equipment if empty string didn't match
          let exerciseId = exerciseRow?.id;
          if (!exerciseId) {
            const rows = await db
              .select({ id: exercise.id })
              .from(exercise)
              .where(eq(exercise.name, parsed.name))
              .limit(1);
            exerciseId = rows[0]?.id;
          }

          if (exerciseId) {
            await db
              .insert(exerciseAlias)
              .values({
                exerciseId,
                providerId: this.id,
                providerExerciseId: parsed.templateId,
                providerExerciseName: parsed.name,
              })
              .onConflictDoNothing();
          }
        }

        hasMore = page < response.page_count;
        page++;
      } catch (err) {
        errors.push({
          message: `Failed to sync exercise templates page ${page}: ${err instanceof Error ? err.message : String(err)}`,
          cause: err,
        });
        break;
      }
    }

    // Build the map from all aliases
    const aliases = await db
      .select({
        providerExerciseId: exerciseAlias.providerExerciseId,
        exerciseId: exerciseAlias.exerciseId,
      })
      .from(exerciseAlias)
      .where(eq(exerciseAlias.providerId, this.id));

    const map = new Map<string, string>();
    for (const alias of aliases) {
      if (alias.providerExerciseId) {
        map.set(alias.providerExerciseId, alias.exerciseId);
      }
    }
    return map;
  }

  private async buildSetRows(
    parsedSets: ParsedSet[],
    workoutId: string,
    templateIdToExerciseId: Map<string, string>,
    db: Database,
    errors: SyncError[],
  ): Promise<(typeof strengthSet.$inferInsert)[]> {
    const rows: (typeof strengthSet.$inferInsert)[] = [];

    for (const set of parsedSets) {
      let exerciseId = templateIdToExerciseId.get(set.exerciseTemplateId);

      // Fallback: create exercise from workout exercise title
      if (!exerciseId) {
        try {
          await db
            .insert(exercise)
            .values({
              name: set.exerciseTitle,
            })
            .onConflictDoNothing();

          const [exerciseRow] = await db
            .select({ id: exercise.id })
            .from(exercise)
            .where(eq(exercise.name, set.exerciseTitle))
            .limit(1);

          if (exerciseRow) {
            exerciseId = exerciseRow.id;
            templateIdToExerciseId.set(set.exerciseTemplateId, exerciseId);

            await db
              .insert(exerciseAlias)
              .values({
                exerciseId,
                providerId: this.id,
                providerExerciseId: set.exerciseTemplateId,
                providerExerciseName: set.exerciseTitle,
              })
              .onConflictDoNothing();
          }
        } catch (err) {
          errors.push({
            message: `Failed to create fallback exercise for template ${set.exerciseTemplateId}: ${err instanceof Error ? err.message : String(err)}`,
            cause: err,
          });
          continue;
        }
      }

      if (!exerciseId) continue;

      rows.push({
        workoutId,
        exerciseId,
        exerciseIndex: set.exerciseIndex,
        setIndex: set.setIndex,
        setType: set.setType,
        weightKg: set.weightKg,
        reps: set.reps,
        distanceMeters: set.distanceMeters,
        durationSeconds: set.durationSeconds,
        rpe: set.rpe,
        notes: set.notes,
      });
    }

    return rows;
  }
}
