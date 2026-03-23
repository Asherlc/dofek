import { type CyclePhase, computePhase } from "@dofek/scoring/menstrual-cycle";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { dateStringSchema, executeWithSchema } from "../lib/typed-sql.ts";
import { CacheTTL, cachedProtectedQuery, protectedProcedure, router } from "../trpc.ts";

const DEFAULT_CYCLE_LENGTH = 28;

const currentPhaseRowSchema = z.object({
  start_date: dateStringSchema,
  avg_cycle_length: z.coerce.number().nullable(),
});

const periodHistoryRowSchema = z.object({
  id: z.string(),
  start_date: dateStringSchema,
  end_date: dateStringSchema.nullable(),
  cycle_length: z.coerce.number().nullable(),
  notes: z.string().nullable(),
});

const periodMutationRowSchema = z.object({
  id: z.string(),
  start_date: dateStringSchema,
  end_date: dateStringSchema.nullable(),
  cycle_length: z.coerce.number().nullable(),
  notes: z.string().nullable(),
});

export interface CurrentPhaseResult {
  phase: CyclePhase | null;
  dayOfCycle: number | null;
  cycleLength: number | null;
}

export const menstrualCycleRouter = router({
  /** Current cycle phase based on most recent period start */
  currentPhase: cachedProtectedQuery(CacheTTL.SHORT).query(
    async ({ ctx }): Promise<CurrentPhaseResult> => {
      const rows = await executeWithSchema(
        ctx.db,
        currentPhaseRowSchema,
        sql`SELECT
              mp.start_date,
              AVG(mp.cycle_length) AS avg_cycle_length
            FROM fitness.menstrual_period mp
            WHERE mp.user_id = ${ctx.userId}
              AND mp.start_date <= CURRENT_DATE
            GROUP BY mp.start_date
            ORDER BY mp.start_date DESC
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
      const today = new Date();
      const dayOfCycle =
        Math.floor((today.getTime() - startDate.getTime()) / (1000 * 60 * 60 * 24)) + 1;

      // If we're past the expected cycle length, we can't determine the phase
      if (dayOfCycle > cycleLength + 7) {
        return { phase: null, dayOfCycle: null, cycleLength };
      }

      const phase = computePhase(dayOfCycle, cycleLength);

      return { phase, dayOfCycle, cycleLength };
    },
  ),

  /** Log a new period start/end */
  logPeriod: protectedProcedure
    .input(
      z.object({
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        endDate: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .nullable()
          .default(null),
        notes: z.string().nullable().default(null),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const rows = await executeWithSchema(
        ctx.db,
        periodMutationRowSchema,
        sql`INSERT INTO fitness.menstrual_period (user_id, start_date, end_date, notes)
            VALUES (${ctx.userId}, ${input.startDate}::date, ${input.endDate}::date, ${input.notes})
            ON CONFLICT (user_id, start_date) DO UPDATE SET
              end_date = EXCLUDED.end_date,
              notes = EXCLUDED.notes
            RETURNING id, start_date, end_date, cycle_length, notes`,
      );
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        startDate: row.start_date,
        endDate: row.end_date,
        cycleLength: row.cycle_length != null ? Number(row.cycle_length) : null,
        notes: row.notes,
      };
    }),

  /** Period history for the past N months */
  history: cachedProtectedQuery(CacheTTL.SHORT)
    .input(z.object({ months: z.number().min(1).max(24).default(6) }))
    .query(async ({ ctx, input }) => {
      const rows = await executeWithSchema(
        ctx.db,
        periodHistoryRowSchema,
        sql`SELECT id, start_date, end_date, cycle_length, notes
            FROM fitness.menstrual_period
            WHERE user_id = ${ctx.userId}
              AND start_date >= CURRENT_DATE - (${input.months}::int || ' months')::interval
            ORDER BY start_date ASC`,
      );

      return rows.map((row) => ({
        id: row.id,
        startDate: row.start_date,
        endDate: row.end_date,
        cycleLength: row.cycle_length != null ? Number(row.cycle_length) : null,
        notes: row.notes,
      }));
    }),
});
