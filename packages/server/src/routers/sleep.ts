import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { CacheTTL, cachedProtectedQuery, router } from "../trpc.ts";

export const sleepListRowSchema = z.object({
  started_at: z.string(),
  duration_minutes: z.coerce.number().nullable(),
  deep_minutes: z.coerce.number().nullable(),
  rem_minutes: z.coerce.number().nullable(),
  light_minutes: z.coerce.number().nullable(),
  awake_minutes: z.coerce.number().nullable(),
  efficiency_pct: z.coerce.number().nullable(),
});

export const sleepRouter = router({
  list: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(
      z.object({
        days: z.number().default(30),
      }),
    )
    .query(async ({ ctx, input }) => {
      return executeWithSchema(
        ctx.db,
        sleepListRowSchema,
        sql`SELECT
              to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS started_at,
              duration_minutes,
              deep_minutes,
              rem_minutes,
              light_minutes,
              awake_minutes,
              efficiency_pct
            FROM fitness.v_sleep
            WHERE user_id = ${ctx.userId}
              AND started_at > NOW() - ${input.days}::int * INTERVAL '1 day'
            ORDER BY started_at ASC`,
      );
    }),

  latest: cachedProtectedQuery(CacheTTL.SHORT).query(async ({ ctx }) => {
    const rows = await executeWithSchema(
      ctx.db,
      sleepListRowSchema,
      sql`SELECT
            to_char(started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS started_at,
            duration_minutes,
            deep_minutes,
            rem_minutes,
            light_minutes,
            awake_minutes,
            efficiency_pct
          FROM fitness.v_sleep
          WHERE user_id = ${ctx.userId}
            AND is_nap = false
          ORDER BY started_at DESC LIMIT 1`,
    );
    return rows[0] ?? null;
  }),
});
