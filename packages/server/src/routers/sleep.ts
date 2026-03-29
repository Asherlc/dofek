import { sql } from "drizzle-orm";
import { z } from "zod";
import { dateWindowInput, timestampWindowStart } from "../lib/date-window.ts";
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

const sleepStageRowSchema = z.object({
  stage: z.string(),
  started_at: z.string(),
  ended_at: z.string(),
});

export const sleepRouter = router({
  list: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(dateWindowInput)
    .query(async ({ ctx, input }) => {
      return executeWithSchema(
        ctx.db,
        sleepListRowSchema,
        sql`WITH raw_sleep AS (
              SELECT
                to_char(started_at AT TIME ZONE ${ctx.timezone}, 'YYYY-MM-DD"T"HH24:MI:SS') AS started_at,
                (started_at AT TIME ZONE ${ctx.timezone})::date AS sleep_date,
                duration_minutes, deep_minutes, rem_minutes, light_minutes, awake_minutes, efficiency_pct
              FROM fitness.v_sleep
              WHERE user_id = ${ctx.userId}
                AND is_nap = false
                AND started_at > ${timestampWindowStart(input.endDate, input.days)}
            ),
            deduped AS (
              SELECT DISTINCT ON (sleep_date)
                started_at, duration_minutes, deep_minutes, rem_minutes, light_minutes, awake_minutes, efficiency_pct
              FROM raw_sleep
              ORDER BY sleep_date, duration_minutes DESC NULLS LAST
            )
            SELECT started_at, duration_minutes, deep_minutes, rem_minutes, light_minutes, awake_minutes, efficiency_pct
            FROM deduped
            ORDER BY started_at ASC`,
      );
    }),

  stages: cachedProtectedQuery(CacheTTL.MEDIUM)
    .input(z.object({ sessionId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      return executeWithSchema(
        ctx.db,
        sleepStageRowSchema,
        sql`SELECT
              st.stage,
              to_char(st.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS started_at,
              to_char(st.ended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ended_at
            FROM fitness.sleep_stage st
            JOIN fitness.v_sleep vs ON vs.id = st.session_id
            WHERE vs.id = ${input.sessionId}
              AND vs.user_id = ${ctx.userId}
            ORDER BY st.started_at ASC`,
      );
    }),

  latestStages: cachedProtectedQuery(CacheTTL.SHORT).query(async ({ ctx }) => {
    return executeWithSchema(
      ctx.db,
      sleepStageRowSchema,
      sql`SELECT
            st.stage,
            to_char(st.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS started_at,
            to_char(st.ended_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ended_at
          FROM fitness.sleep_stage st
          WHERE st.session_id = (
            SELECT vs.id FROM fitness.v_sleep vs
            WHERE vs.user_id = ${ctx.userId}
              AND vs.is_nap = false
            ORDER BY vs.started_at DESC
            LIMIT 1
          )
          ORDER BY st.started_at ASC`,
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
