import { shiftDateYmd } from "@dofek/format/format";
import { resolveProviderActivityType } from "@dofek/training/activity-types";
import { STRAVA_ACTIVITY_TYPE_MAP } from "@dofek/training/training";
import type { Database } from "dofek/db";
import { PLANNED_WORKOUT_HORIZON_DAYS } from "dofek/db/planned-workout-repository";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { type AccessWindow, dateAccessPredicate } from "../billing/entitlement.ts";
import { dateStringSchema, executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";

export const plannedWorkoutTargetTypeSchema = z.enum(["power", "heart_rate", "pace", "cadence"]);

/** One authored target as it was written, including a value or a start/end range. */
export const plannedWorkoutTargetSchema = z.object({
  type: plannedWorkoutTargetTypeSchema,
  value: z.number().nullable(),
  start: z.number().nullable(),
  end: z.number().nullable(),
  unit: z.string().nullable(),
});
export type PlannedWorkoutTarget = z.infer<typeof plannedWorkoutTargetSchema>;

export type PlannedWorkoutStep =
  | {
      kind: "step";
      text: string | null;
      durationSeconds: number | null;
      distanceMeters: number | null;
      targets: PlannedWorkoutTarget[];
    }
  | { kind: "repeat"; repetitions: number; text: string | null; steps: PlannedWorkoutStep[] }
  /** A neutral marker for a step the app cannot render; no vendor JSON crosses tRPC. */
  | { kind: "unsupported" };

export const plannedWorkoutStepSchema: z.ZodType<PlannedWorkoutStep> = z.lazy(() =>
  z.union([
    z.object({
      kind: z.literal("step"),
      text: z.string().nullable(),
      durationSeconds: z.number().nullable(),
      distanceMeters: z.number().nullable(),
      targets: z.array(plannedWorkoutTargetSchema),
    }),
    z.object({
      kind: z.literal("repeat"),
      repetitions: z.number(),
      text: z.string().nullable(),
      steps: z.array(plannedWorkoutStepSchema),
    }),
    z.object({ kind: z.literal("unsupported") }),
  ]),
);

export const plannedWorkoutDaySchema = z.object({
  date: dateStringSchema,
  workouts: z.array(
    z.object({
      id: z.string(),
      providerId: z.string(),
      title: z.string().nullable(),
      description: z.string().nullable(),
      sportType: z.string().nullable(),
      startTime: z.string().nullable(),
      steps: z.array(plannedWorkoutStepSchema),
      /** Present only when the provider connection is gone; last importer confirmation. */
      snapshotImportedAt: z.string().optional(),
    }),
  ),
});
export type PlannedWorkoutDay = z.infer<typeof plannedWorkoutDaySchema>;

export interface PlannedWorkoutUpcomingInput {
  dateRange?: { startDate: string; endDate: string };
  activityType?: string;
}

function plannedSportMatches(sportType: string | null, activityType: string): boolean {
  // Retained plans may store whitespace-only sport; trim-empty must not take down the feed.
  if (!sportType || sportType.trim().length === 0) return false;
  const mapped = resolveProviderActivityType(
    sportType,
    STRAVA_ACTIVITY_TYPE_MAP[sportType] ?? "other",
  );
  return mapped.canonicalType === activityType;
}

// Bounds for untrusted authoring data: an absurd source document must never
// hang the request or produce an unbounded response. The original document
// stays in the database; only neutral projected steps cross tRPC.
const MAX_PROJECTION_DEPTH = 12;
const MAX_PROJECTION_NODES = 500;

const AUTHORED_TARGETS = [
  ["power", "power"],
  ["heart_rate", "hr"],
  ["pace", "pace"],
  ["cadence", "cadence"],
] as const;

const authoredValueSchema = z.object({
  value: z.number().finite().nullish(),
  start: z.number().finite().nullish(),
  end: z.number().finite().nullish(),
  units: z.string().nullish(),
});

const finite = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim().length > 0 ? value : null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function projectTargets(step: Record<string, unknown>): PlannedWorkoutTarget[] {
  const targets: PlannedWorkoutTarget[] = [];
  for (const [type, key] of AUTHORED_TARGETS) {
    const parsed = authoredValueSchema.safeParse(step[key]);
    if (!parsed.success) continue;
    const { value, start, end, units } = parsed.data;
    if (value == null && start == null && end == null) continue;
    targets.push({
      type,
      value: value ?? null,
      start: start ?? null,
      end: end ?? null,
      unit: units ?? null,
    });
  }
  return targets;
}

function projectList(
  nodes: readonly unknown[],
  depth: number,
  budget: { used: number },
): PlannedWorkoutStep[] {
  if (depth > MAX_PROJECTION_DEPTH) return [{ kind: "unsupported" }];
  const projected: PlannedWorkoutStep[] = [];
  for (const node of nodes) {
    if (++budget.used > MAX_PROJECTION_NODES) {
      // One marker ends the bounded response; never emit vendor JSON.
      projected.push({ kind: "unsupported" });
      break;
    }
    if (node === null || node === undefined) continue;
    if (!isRecord(node)) {
      projected.push({ kind: "unsupported" });
      continue;
    }
    const step = node;
    const repetitions = finite(step.reps);
    const label = text(step.text);
    if (repetitions !== null && Array.isArray(step.steps)) {
      projected.push({
        kind: "repeat",
        repetitions,
        text: label,
        steps: projectList(step.steps, depth + 1, budget),
      });
      continue;
    }
    const durationSeconds = finite(step.duration);
    const distanceMeters = finite(step.distance);
    const targets = projectTargets(step);
    if (
      label === null &&
      durationSeconds === null &&
      distanceMeters === null &&
      targets.length === 0
    ) {
      // An empty leaf carries nothing to render; one marker signals the
      // unsupported step without leaking the source document.
      projected.push({ kind: "unsupported" });
      continue;
    }
    projected.push({ kind: "step", text: label, durationSeconds, distanceMeters, targets });
  }
  return projected;
}

/** Project the authored workout document; unsupported nodes are never fatal. */
export function projectWorkoutSteps(doc: unknown): PlannedWorkoutStep[] {
  const parsed = z.object({ steps: z.array(z.unknown()) }).safeParse(doc);
  return parsed.success ? projectList(parsed.data.steps, 0, { used: 0 }) : [];
}

const rowSchema = z.object({
  id: z.string(),
  provider_id: z.string(),
  start_date: dateStringSchema,
  start_time: z.string().nullable(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  sport_type: z.string().nullable(),
  workout_doc: z.unknown(),
  updated_at: timestampStringSchema,
  provider_connected: z.boolean(),
});

export class PlannedWorkoutRepository {
  readonly db: Pick<Database, "execute">;
  readonly userId: string;
  /** Today in the user's home timezone (YYYY-MM-DD), computed by the caller. */
  readonly today: string;
  readonly providerId?: string;
  readonly accessWindow?: AccessWindow;

  constructor(
    db: Pick<Database, "execute">,
    userId: string,
    today: string,
    providerId?: string,
    accessWindow?: AccessWindow,
  ) {
    this.db = db;
    this.userId = userId;
    this.today = today;
    this.providerId = providerId;
    this.accessWindow = accessWindow;
  }

  async upcoming(input: PlannedWorkoutUpcomingInput = {}): Promise<PlannedWorkoutDay[]> {
    const startDate = input.dateRange?.startDate ?? this.today;
    const endDate =
      input.dateRange?.endDate ?? shiftDateYmd(this.today, PLANNED_WORKOUT_HORIZON_DAYS);
    const rows = await executeWithSchema(
      this.db,
      rowSchema,
      sql`SELECT pw.external_id AS id, pw.provider_id, pw.start_date::text AS start_date,
                 to_char(pw.start_time, 'HH24:MI') AS start_time,
                 pw.title, pw.description, pw.sport_type, pw.workout_doc,
                 pw.updated_at AS updated_at,
                 (
                   CASE
                     WHEN pw.provider_id = 'intervals.icu' THEN
                       pc.user_id IS NOT NULL
                       AND ot.user_id IS NOT NULL
                       AND EXISTS (
                         SELECT 1
                         FROM unnest(string_to_array(coalesce(ot.scopes, ''), ',')) AS scope_name
                         WHERE btrim(scope_name) IN ('CALENDAR:READ', 'CALENDAR:WRITE')
                       )
                     ELSE pc.user_id IS NOT NULL
                   END
                 ) AS provider_connected
          FROM fitness.planned_workout pw
          LEFT JOIN fitness.provider_connection pc
            ON pc.user_id = pw.user_id
           AND pc.provider_id = pw.provider_id
          LEFT JOIN fitness.oauth_token ot
            ON ot.user_id = pw.user_id
           AND ot.provider_id = pw.provider_id
          WHERE pw.user_id = ${this.userId}::uuid
            AND pw.start_date BETWEEN ${startDate}::date AND ${endDate}::date
            ${dateAccessPredicate(this.accessWindow, sql`pw.start_date`)}
            ${this.providerId ? sql`AND pw.provider_id = ${this.providerId}` : sql``}
          ORDER BY pw.start_date, pw.start_time NULLS FIRST, pw.external_id`,
    );
    const days = new Map<string, PlannedWorkoutDay>();
    for (const row of rows) {
      if (input.activityType && !plannedSportMatches(row.sport_type, input.activityType)) {
        continue;
      }
      const day = days.get(row.start_date) ?? { date: row.start_date, workouts: [] };
      day.workouts.push({
        id: row.id,
        providerId: row.provider_id,
        title: row.title,
        description: row.description,
        sportType: row.sport_type,
        startTime: row.start_time,
        steps: projectWorkoutSteps(row.workout_doc),
        ...(row.provider_connected ? {} : { snapshotImportedAt: row.updated_at }),
      });
      days.set(row.start_date, day);
    }
    return [...days.values()];
  }
}
