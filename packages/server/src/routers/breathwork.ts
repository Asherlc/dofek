import { type BreathworkTechnique, TECHNIQUES } from "@dofek/scoring/breathwork";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import { CacheTTL, cachedProtectedQuery, protectedProcedure, router } from "../trpc.ts";

const sessionRowSchema = z.object({
  id: z.string(),
  technique_id: z.string(),
  rounds: z.coerce.number(),
  duration_seconds: z.coerce.number(),
  started_at: timestampStringSchema,
  notes: z.string().nullable(),
});

export const breathworkRouter = router({
  /** Get all available breathwork techniques */
  techniques: cachedProtectedQuery(CacheTTL.LONG).query((): BreathworkTechnique[] => {
    return TECHNIQUES;
  }),

  /** Log a completed breathwork session */
  logSession: protectedProcedure
    .input(
      z.object({
        techniqueId: z.string().min(1),
        rounds: z.number().int().min(1),
        durationSeconds: z.number().int().min(1),
        startedAt: z.string(),
        notes: z.string().nullable().default(null),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const rows = await executeWithSchema(
        ctx.db,
        sessionRowSchema,
        sql`INSERT INTO fitness.breathwork_session (user_id, technique_id, rounds, duration_seconds, started_at, notes)
            VALUES (${ctx.userId}, ${input.techniqueId}, ${input.rounds}, ${input.durationSeconds}, ${input.startedAt}::timestamptz, ${input.notes})
            RETURNING id, technique_id, rounds, duration_seconds, started_at, notes`,
      );

      const row = rows[0];
      if (!row) return null;

      return {
        id: row.id,
        techniqueId: row.technique_id,
        rounds: Number(row.rounds),
        durationSeconds: Number(row.duration_seconds),
        startedAt: row.started_at,
        notes: row.notes,
      };
    }),

  /** Get breathwork session history */
  history: cachedProtectedQuery(CacheTTL.SHORT)
    .input(z.object({ days: z.number().min(1).max(365).default(30) }))
    .query(async ({ ctx, input }) => {
      const rows = await executeWithSchema(
        ctx.db,
        sessionRowSchema,
        sql`SELECT id, technique_id, rounds, duration_seconds, started_at, notes
            FROM fitness.breathwork_session
            WHERE user_id = ${ctx.userId}
              AND started_at >= NOW() - (${input.days}::int || ' days')::interval
            ORDER BY started_at DESC`,
      );

      return rows.map((row) => ({
        id: row.id,
        techniqueId: row.technique_id,
        rounds: Number(row.rounds),
        durationSeconds: Number(row.duration_seconds),
        startedAt: row.started_at,
        notes: row.notes,
      }));
    }),
});
