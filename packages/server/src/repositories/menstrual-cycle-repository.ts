import { type CyclePhase, computePhase, PHASE_DISPLAY } from "@dofek/scoring/menstrual-cycle";
import type { Database } from "dofek/db";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";

// ---------------------------------------------------------------------------
// Estimate boundaries
// ---------------------------------------------------------------------------

const MINIMUM_COMPLETED_CYCLES = 3;
const MINIMUM_REGULAR_CYCLE_DAYS = 21;
const MAXIMUM_REGULAR_CYCLE_DAYS = 35;
const MAXIMUM_REGULAR_VARIATION_DAYS = 9;

// ---------------------------------------------------------------------------
// Zod schemas for raw DB rows
// ---------------------------------------------------------------------------

const currentPhaseRowSchema = z.object({
  start_date: dateStringSchema,
  avg_cycle_length: z.coerce.number().nullable(),
  completed_cycle_count: z.coerce.number().int().nonnegative(),
  min_cycle_length: z.coerce.number().int().nullable(),
  max_cycle_length: z.coerce.number().int().nullable(),
});

const periodHistoryRowSchema = z.object({
  id: z.string(),
  start_date: dateStringSchema,
  end_date: dateStringSchema.nullable(),
  duration_days: z.coerce.number().int().nullable(),
  notes: z.string().nullable(),
});

const periodMutationRowSchema = z.object({
  id: z.string(),
  start_date: dateStringSchema,
  end_date: dateStringSchema.nullable(),
  duration_days: z.coerce.number().int().nullable(),
  notes: z.string().nullable(),
});

const deletedPeriodRowSchema = z.object({
  id: z.string(),
});

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export type CycleEstimateStatus =
  | "no-history"
  | "sparse-history"
  | "irregular-history"
  | "stale-history"
  | "estimated";

export interface CycleEstimateAvailability {
  status: CycleEstimateStatus;
  label: string;
}

export interface CyclePhaseEstimate {
  basis: "personal-cycle-average";
  completedCycleCount: number;
  observedCycleLengthRange: {
    minimumDays: number;
    maximumDays: number;
  } | null;
  phaseLabel: string;
  cycleDayLabel: string;
  dayBasisLabel: string;
  methodLabel: string;
  uncertaintyLabel: string;
  limitationLabel: string;
}

export interface CurrentPhaseResult {
  phase: CyclePhase | null;
  dayOfCycle: number | null;
  cycleLength: number | null;
  estimate: CyclePhaseEstimate | null;
  availability: CycleEstimateAvailability;
}

export interface MenstrualPeriod {
  id: string;
  startDate: string;
  endDate: string | null;
  durationDays: number | null;
  durationLabel: string | null;
  notes: string | null;
}

export class PeriodStartDateConflictError extends Error {
  constructor(startDate: string) {
    super(`A period is already recorded for ${startDate}. Choose a different start date.`);
    this.name = "PeriodStartDateConflictError";
  }
}

function isUniqueViolation(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error && error.code === "23505") return true;
  return (
    "cause" in error &&
    typeof error.cause === "object" &&
    error.cause !== null &&
    "code" in error.cause &&
    error.cause.code === "23505"
  );
}

function formatPeriodDuration(durationDays: number | null): string | null {
  if (durationDays === null) return null;
  return `${durationDays} ${durationDays === 1 ? "day" : "days"}`;
}

function mapPeriod(row: z.infer<typeof periodMutationRowSchema>): MenstrualPeriod {
  return {
    id: row.id,
    startDate: row.start_date,
    endDate: row.end_date,
    durationDays: row.duration_days,
    durationLabel: formatPeriodDuration(row.duration_days),
    notes: row.notes,
  };
}

function buildCyclePhaseEstimate({
  phase,
  dayOfCycle,
  cycleLength,
  completedCycleCount,
  minimumCycleLength,
  maximumCycleLength,
}: {
  phase: CyclePhase;
  dayOfCycle: number;
  cycleLength: number;
  completedCycleCount: number;
  minimumCycleLength: number;
  maximumCycleLength: number;
}): CyclePhaseEstimate {
  const methodLabel = `Phase and cycle length use the average of ${completedCycleCount} completed cycles.`;
  const uncertaintyLabel =
    minimumCycleLength === maximumCycleLength
      ? `All ${completedCycleCount} recorded cycles were ${minimumCycleLength} days long.`
      : `Recorded cycle lengths ranged from ${minimumCycleLength} to ${maximumCycleLength} days.`;

  return {
    basis: "personal-cycle-average",
    completedCycleCount,
    observedCycleLengthRange: {
      minimumDays: minimumCycleLength,
      maximumDays: maximumCycleLength,
    },
    phaseLabel: `Estimated ${PHASE_DISPLAY[phase].label} phase`,
    cycleDayLabel: `Day ${dayOfCycle} of an estimated ${cycleLength}-day cycle`,
    dayBasisLabel: "Cycle day is counted from the latest recorded period start.",
    methodLabel,
    uncertaintyLabel,
    limitationLabel: "No calibrated confidence score or next-period forecast is available.",
  };
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

  /** Estimate the current phase and expose the recorded history behind that estimate. */
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
          ),
          cycle_stats AS (
            SELECT AVG(cycle_days)::numeric AS avg_cycle_length,
                   COUNT(cycle_days)::int AS completed_cycle_count,
                   MIN(cycle_days)::int AS min_cycle_length,
                   MAX(cycle_days)::int AS max_cycle_length
            FROM cycles
            WHERE cycle_days IS NOT NULL
          )
          SELECT start_date,
                 cycle_stats.avg_cycle_length,
                 cycle_stats.completed_cycle_count,
                 cycle_stats.min_cycle_length,
                 cycle_stats.max_cycle_length
          FROM cycles
          CROSS JOIN cycle_stats
          ORDER BY start_date DESC
          LIMIT 1`,
    );

    const latest = rows[0];
    if (!latest) {
      return {
        phase: null,
        dayOfCycle: null,
        cycleLength: null,
        estimate: null,
        availability: {
          status: "no-history",
          label: "No periods logged. Add a period start to begin tracking.",
        },
      };
    }

    if (
      latest.completed_cycle_count < MINIMUM_COMPLETED_CYCLES ||
      latest.avg_cycle_length === null ||
      latest.min_cycle_length === null ||
      latest.max_cycle_length === null
    ) {
      return {
        phase: null,
        dayOfCycle: null,
        cycleLength: null,
        estimate: null,
        availability: {
          status: "sparse-history",
          label:
            "Not enough recorded history for a phase estimate. At least 3 completed cycles are needed.",
        },
      };
    }

    const cycleLengthVariation = latest.max_cycle_length - latest.min_cycle_length;
    const hasIrregularHistory =
      latest.min_cycle_length < MINIMUM_REGULAR_CYCLE_DAYS ||
      latest.max_cycle_length > MAXIMUM_REGULAR_CYCLE_DAYS ||
      cycleLengthVariation > MAXIMUM_REGULAR_VARIATION_DAYS;
    if (hasIrregularHistory) {
      return {
        phase: null,
        dayOfCycle: null,
        cycleLength: null,
        estimate: null,
        availability: {
          status: "irregular-history",
          label: `No phase estimate is shown because recorded cycle lengths do not support a regular-cycle model (observed range: ${latest.min_cycle_length} to ${latest.max_cycle_length} days).`,
        },
      };
    }

    const cycleLength = Math.round(Number(latest.avg_cycle_length));

    const startDate = new Date(latest.start_date);
    const referenceDate = today ?? new Date();
    const dayOfCycle =
      Math.floor((referenceDate.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;

    // If we're past the expected cycle length + 7 days, we can't determine the phase
    if (dayOfCycle > cycleLength + 7) {
      return {
        phase: null,
        dayOfCycle: null,
        cycleLength,
        estimate: null,
        availability: {
          status: "stale-history",
          label:
            "The latest period start is beyond the expected cycle window. Correct it or log a newer period start to resume estimates.",
        },
      };
    }

    const phase = computePhase(dayOfCycle, cycleLength);

    return {
      phase,
      dayOfCycle,
      cycleLength,
      estimate: buildCyclePhaseEstimate({
        phase,
        dayOfCycle,
        cycleLength,
        completedCycleCount: latest.completed_cycle_count,
        minimumCycleLength: latest.min_cycle_length,
        maximumCycleLength: latest.max_cycle_length,
      }),
      availability: {
        status: "estimated",
        label: "Phase estimate available from recorded cycle history.",
      },
    };
  }

  /** Log a new period start/end (upserts on user+start_date). */
  async logPeriod(
    startDate: string,
    endDate: string | null,
    notes: string | null,
  ): Promise<MenstrualPeriod | null> {
    if (endDate !== null && endDate < startDate) {
      throw new Error("Period end date cannot be before start date.");
    }

    const rows = await executeWithSchema(
      this.#db,
      periodMutationRowSchema,
      sql`INSERT INTO fitness.menstrual_period (user_id, start_date, end_date, notes)
          VALUES (${this.#userId}, ${startDate}::date, ${endDate}::date, ${notes})
          ON CONFLICT (user_id, start_date) DO UPDATE SET
            end_date = EXCLUDED.end_date,
            notes = EXCLUDED.notes
          RETURNING id, start_date, end_date,
                    end_date - start_date + 1 AS duration_days,
                    notes`,
    );

    const row = rows[0];
    if (!row) return null;

    return mapPeriod(row);
  }

  /** Correct an existing period owned by this user. */
  async updatePeriod(
    id: string,
    startDate: string,
    endDate: string | null,
    notes: string | null,
  ): Promise<MenstrualPeriod | null> {
    if (endDate !== null && endDate < startDate) {
      throw new Error("Period end date cannot be before start date.");
    }

    try {
      const rows = await executeWithSchema(
        this.#db,
        periodMutationRowSchema,
        sql`UPDATE fitness.menstrual_period
            SET start_date = ${startDate}::date,
                end_date = ${endDate}::date,
                notes = ${notes}
            WHERE id = ${id}::uuid
              AND user_id = ${this.#userId}
            RETURNING id, start_date, end_date,
                      end_date - start_date + 1 AS duration_days,
                      notes`,
      );

      const row = rows[0];
      return row ? mapPeriod(row) : null;
    } catch (error: unknown) {
      if (isUniqueViolation(error)) {
        throw new PeriodStartDateConflictError(startDate);
      }
      throw error;
    }
  }

  /** Delete an erroneous period owned by this user. */
  async deletePeriod(id: string): Promise<boolean> {
    const rows = await executeWithSchema(
      this.#db,
      deletedPeriodRowSchema,
      sql`DELETE FROM fitness.menstrual_period
          WHERE id = ${id}::uuid
            AND user_id = ${this.#userId}
          RETURNING id`,
    );

    return rows.length > 0;
  }

  /** Period history for the past N months. */
  async getHistory(months: number): Promise<MenstrualPeriod[]> {
    const rows = await executeWithSchema(
      this.#db,
      periodHistoryRowSchema,
      sql`SELECT id, start_date, end_date,
                 end_date - start_date + 1 AS duration_days,
                 notes
          FROM fitness.menstrual_period
          WHERE user_id = ${this.#userId}
            AND start_date >= CURRENT_DATE - (${months}::int || ' months')::interval
          ORDER BY start_date ASC`,
    );

    return rows.map(mapPeriod);
  }
}
