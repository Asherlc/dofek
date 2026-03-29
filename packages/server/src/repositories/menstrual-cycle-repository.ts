import { type CyclePhase, computePhase } from "@dofek/scoring/menstrual-cycle";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_CYCLE_LENGTH = 28;

// ---------------------------------------------------------------------------
// Zod schemas for raw DB rows
// ---------------------------------------------------------------------------

const currentPhaseRowSchema = z.object({
  start_date: dateStringSchema,
  avg_cycle_length: z.coerce.number().nullable(),
});

const periodHistoryRowSchema = z.object({
  id: z.string(),
  start_date: dateStringSchema,
  end_date: dateStringSchema.nullable(),
  notes: z.string().nullable(),
});

const periodMutationRowSchema = z.object({
  id: z.string(),
  start_date: dateStringSchema,
  end_date: dateStringSchema.nullable(),
  notes: z.string().nullable(),
});

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface CurrentPhaseResult {
  phase: CyclePhase | null;
  dayOfCycle: number | null;
  cycleLength: number | null;
}

export interface MenstrualPeriod {
  id: string;
  startDate: string;
  endDate: string | null;
  notes: string | null;
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

/** Data access for menstrual cycle tracking. */
export class MenstrualCycleRepository {
  readonly #db: Pick<Database, "execute">;
  readonly #userId: string;

  constructor(db: Pick<Database, "execute">, userId: string) {
    this.#db = db;
    this.#userId = userId;
  }

  /** Compute the current cycle phase based on the most recent period start. */
  async getCurrentPhase(today?: Date): Promise<CurrentPhaseResult> {
    const rows = await executeWithSchema(
      this.#db,
      currentPhaseRowSchema,
      sql`WITH cycles AS (
            SELECT start_date,
                   start_date - LAG(start_date) OVER (ORDER BY start_date) AS cycle_days
            FROM fitness.menstrual_period
            WHERE user_id = ${this.#userId}
              AND start_date <= CURRENT_DATE
          )
          SELECT start_date,
                 (SELECT AVG(cycle_days) FROM cycles WHERE cycle_days IS NOT NULL)::numeric AS avg_cycle_length
          FROM cycles
          ORDER BY start_date DESC
          LIMIT 1`,
    );

    const latest = rows[0];
    if (!latest) {
      return { phase: null, dayOfCycle: null, cycleLength: null };
    }

    const cycleLength = latest.avg_cycle_length
      ? Math.round(Number(latest.avg_cycle_length))
      : DEFAULT_CYCLE_LENGTH;

    const startDate = new Date(latest.start_date);
    const referenceDate = today ?? new Date();
    const dayOfCycle =
      Math.floor((referenceDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;

    // If we're past the expected cycle length + 7 days, we can't determine the phase
    if (dayOfCycle > cycleLength + 7) {
      return { phase: null, dayOfCycle: null, cycleLength };
    }

    const phase = computePhase(dayOfCycle, cycleLength);

    return { phase, dayOfCycle, cycleLength };
  }

  /** Log a new period start/end (upserts on user+start_date). */
  async logPeriod(
    startDate: string,
    endDate: string | null,
    notes: string | null,
  ): Promise<MenstrualPeriod | null> {
    const rows = await executeWithSchema(
      this.#db,
      periodMutationRowSchema,
      sql`INSERT INTO fitness.menstrual_period (user_id, start_date, end_date, notes)
          VALUES (${this.#userId}, ${startDate}::date, ${endDate}::date, ${notes})
          ON CONFLICT (user_id, start_date) DO UPDATE SET
            end_date = EXCLUDED.end_date,
            notes = EXCLUDED.notes
          RETURNING id, start_date, end_date, notes`,
    );

    const row = rows[0];
    if (!row) return null;

    return {
      id: row.id,
      startDate: row.start_date,
      endDate: row.end_date,
      notes: row.notes,
    };
  }

  /** Period history for the past N months. */
  async getHistory(months: number): Promise<MenstrualPeriod[]> {
    const rows = await executeWithSchema(
      this.#db,
      periodHistoryRowSchema,
      sql`SELECT id, start_date, end_date, notes
          FROM fitness.menstrual_period
          WHERE user_id = ${this.#userId}
            AND start_date >= CURRENT_DATE - (${months}::int || ' months')::interval
          ORDER BY start_date ASC`,
    );

    return rows.map((row) => ({
      id: row.id,
      startDate: row.start_date,
      endDate: row.end_date,
      notes: row.notes,
    }));
  }
}
