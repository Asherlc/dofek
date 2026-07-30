import {
  type BreathworkOutcomeReport,
  PERCEIVED_BREATHWORK_EFFECTS,
} from "@dofek/scoring/breathwork";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";

const perceivedEffectSchema = z.enum(PERCEIVED_BREATHWORK_EFFECTS);
const OUTCOME_WINDOW_DAYS = 30;

// ---------------------------------------------------------------------------
// Zod schema for raw DB rows
// ---------------------------------------------------------------------------

const sessionRowSchema = z.object({
  id: z.string(),
  technique_id: z.string(),
  rounds: z.coerce.number(),
  duration_seconds: z.coerce.number(),
  started_at: timestampStringSchema,
  notes: z.string().nullable(),
  stress_before: z.coerce.number().int().min(0).max(10).nullable(),
  stress_after: z.coerce.number().int().min(0).max(10).nullable(),
  dizziness_after: z.boolean().nullable(),
  perceived_effect: perceivedEffectSchema.nullable(),
});

type SessionRow = z.infer<typeof sessionRowSchema>;

const outcomeSummaryRowSchema = z.object({
  technique_id: z.string(),
  session_count: z.coerce.number().int().nonnegative(),
  stress_pair_count: z.coerce.number().int().nonnegative(),
  lower_stress_count: z.coerce.number().int().nonnegative(),
  same_stress_count: z.coerce.number().int().nonnegative(),
  higher_stress_count: z.coerce.number().int().nonnegative(),
  perceived_effect_count: z.coerce.number().int().nonnegative(),
  better_count: z.coerce.number().int().nonnegative(),
  same_effect_count: z.coerce.number().int().nonnegative(),
  worse_count: z.coerce.number().int().nonnegative(),
  dizziness_report_count: z.coerce.number().int().nonnegative(),
  dizziness_count: z.coerce.number().int().nonnegative(),
});

// ---------------------------------------------------------------------------
// Domain model
// ---------------------------------------------------------------------------

export class BreathworkSession {
  readonly #row: SessionRow;

  constructor(row: SessionRow) {
    this.#row = row;
  }

  toDetail() {
    return {
      id: this.#row.id,
      techniqueId: this.#row.technique_id,
      rounds: Number(this.#row.rounds),
      durationSeconds: Number(this.#row.duration_seconds),
      startedAt: this.#row.started_at,
      notes: this.#row.notes,
      stressBefore: this.#row.stress_before,
      stressAfter: this.#row.stress_after,
      dizzinessAfter: this.#row.dizziness_after,
      perceivedEffect: this.#row.perceived_effect,
    };
  }
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Data access for breathwork sessions. */
export class BreathworkRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;

  constructor(db: Pick<Database, "execute">, userId: string) {
    this.#db = db;
    this.#userId = userId;
  }

  async logSession(
    input: BreathworkOutcomeReport & {
      techniqueId: string;
      rounds: number;
      durationSeconds: number;
      startedAt: string;
      notes: string | null;
    },
  ): Promise<BreathworkSession | null> {
    const rows = await executeWithSchema(
      this.#db,
      sessionRowSchema,
      sql`INSERT INTO fitness.breathwork_session (
            user_id,
            technique_id,
            rounds,
            duration_seconds,
            started_at,
            notes,
            stress_before,
            stress_after,
            dizziness_after,
            perceived_effect
          )
          VALUES (
            ${this.#userId},
            ${input.techniqueId},
            ${input.rounds},
            ${input.durationSeconds},
            ${input.startedAt}::timestamptz,
            ${input.notes},
            ${input.stressBefore},
            ${input.stressAfter},
            ${input.dizzinessAfter},
            ${input.perceivedEffect}
          )
          RETURNING
            id,
            technique_id,
            rounds,
            duration_seconds,
            started_at,
            notes,
            stress_before,
            stress_after,
            dizziness_after,
            perceived_effect`,
    );

    const row = rows[0];
    return row ? new BreathworkSession(row) : null;
  }

  async getHistory(days: number): Promise<BreathworkSession[]> {
    const rows = await executeWithSchema(
      this.#db,
      sessionRowSchema,
      sql`SELECT
            id,
            technique_id,
            rounds,
            duration_seconds,
            started_at,
            notes,
            stress_before,
            stress_after,
            dizziness_after,
            perceived_effect
          FROM fitness.breathwork_session
          WHERE user_id = ${this.#userId}
            AND started_at >= NOW() - (${days}::int || ' days')::interval
          ORDER BY started_at DESC`,
    );

    return rows.map((row) => new BreathworkSession(row));
  }

  async getOutcomeSummaries() {
    const rows = await executeWithSchema(
      this.#db,
      outcomeSummaryRowSchema,
      sql`SELECT
            technique_id,
            COUNT(*)::int AS session_count,
            COUNT(*) FILTER (
              WHERE stress_before IS NOT NULL AND stress_after IS NOT NULL
            )::int AS stress_pair_count,
            COUNT(*) FILTER (
              WHERE stress_before IS NOT NULL
                AND stress_after IS NOT NULL
                AND stress_after < stress_before
            )::int AS lower_stress_count,
            COUNT(*) FILTER (
              WHERE stress_before IS NOT NULL
                AND stress_after IS NOT NULL
                AND stress_after = stress_before
            )::int AS same_stress_count,
            COUNT(*) FILTER (
              WHERE stress_before IS NOT NULL
                AND stress_after IS NOT NULL
                AND stress_after > stress_before
            )::int AS higher_stress_count,
            COUNT(perceived_effect)::int AS perceived_effect_count,
            COUNT(*) FILTER (WHERE perceived_effect = 'better')::int AS better_count,
            COUNT(*) FILTER (WHERE perceived_effect = 'same')::int AS same_effect_count,
            COUNT(*) FILTER (WHERE perceived_effect = 'worse')::int AS worse_count,
            COUNT(dizziness_after)::int AS dizziness_report_count,
            COUNT(*) FILTER (WHERE dizziness_after IS TRUE)::int AS dizziness_count
          FROM fitness.breathwork_session
          WHERE user_id = ${this.#userId}
            AND started_at >= CURRENT_TIMESTAMP - make_interval(days => ${OUTCOME_WINDOW_DAYS}::int)
          GROUP BY technique_id
          ORDER BY technique_id`,
    );

    return {
      windowDays: OUTCOME_WINDOW_DAYS,
      windowKind: "rolling-instant" as const,
      techniques: rows.map((row) => ({
        techniqueId: row.technique_id,
        sessionCount: row.session_count,
        stress: {
          reportCount: row.stress_pair_count,
          lowerCount: row.lower_stress_count,
          sameCount: row.same_stress_count,
          higherCount: row.higher_stress_count,
        },
        perceivedEffect: {
          reportCount: row.perceived_effect_count,
          betterCount: row.better_count,
          sameCount: row.same_effect_count,
          worseCount: row.worse_count,
        },
        dizziness: {
          reportCount: row.dizziness_report_count,
          yesCount: row.dizziness_count,
        },
      })),
    };
  }
}
