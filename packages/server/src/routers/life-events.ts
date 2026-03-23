import { sql } from "drizzle-orm";
import { z } from "zod";
import { executeWithSchema } from "../lib/typed-sql.ts";
import { CacheTTL, cachedProtectedQuery, protectedProcedure, router } from "../trpc.ts";

const lifeEventRowSchema = z.object({
  id: z.string(),
  label: z.string(),
  started_at: z.string(),
  ended_at: z.string().nullable(),
  category: z.string().nullable(),
  ongoing: z.coerce.boolean(),
  notes: z.string().nullable(),
  created_at: z.string(),
});

/** Schema for life event rows from RETURNING * (includes user_id) */
const lifeEventFullRowSchema = lifeEventRowSchema.extend({
  user_id: z.string(),
});

const metricsComparisonRowSchema = z.object({
  period: z.string(),
  days: z.coerce.number(),
  avg_resting_hr: z.coerce.number().nullable(),
  avg_hrv: z.coerce.number().nullable(),
  avg_steps: z.coerce.number().nullable(),
  avg_active_energy: z.coerce.number().nullable(),
});

const sleepComparisonRowSchema = z.object({
  period: z.string(),
  nights: z.coerce.number(),
  avg_sleep_min: z.coerce.number().nullable(),
  avg_deep_min: z.coerce.number().nullable(),
  avg_rem_min: z.coerce.number().nullable(),
  avg_efficiency: z.coerce.number().nullable(),
});

const bodyComparisonRowSchema = z.object({
  period: z.string(),
  measurements: z.coerce.number(),
  avg_weight: z.coerce.number().nullable(),
  avg_body_fat: z.coerce.number().nullable(),
});

export const lifeEventsRouter = router({
  list: cachedProtectedQuery(CacheTTL.SHORT).query(async ({ ctx }) => {
    const rows = await executeWithSchema(
      ctx.db,
      lifeEventRowSchema,
      sql`SELECT id, label, started_at, ended_at, category, ongoing, notes, created_at
          FROM fitness.life_events
          WHERE user_id = ${ctx.userId}
          ORDER BY started_at DESC`,
    );
    return rows;
  }),

  create: protectedProcedure
    .input(
      z.object({
        label: z.string().min(1),
        startedAt: z.string(), // YYYY-MM-DD
        endedAt: z.string().nullable().default(null),
        category: z.string().nullable().default(null),
        ongoing: z.boolean().default(false),
        notes: z.string().nullable().default(null),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const rows = await executeWithSchema(
        ctx.db,
        lifeEventFullRowSchema,
        sql`INSERT INTO fitness.life_events (user_id, label, started_at, ended_at, category, ongoing, notes)
            VALUES (${ctx.userId}, ${input.label}, ${input.startedAt}::date, ${input.endedAt}::date, ${input.category}, ${input.ongoing}, ${input.notes})
            RETURNING *`,
      );
      return rows[0];
    }),

  update: protectedProcedure
    .input(
      z.object({
        id: z.string().uuid(),
        label: z.string().min(1).optional(),
        startedAt: z.string().optional(),
        endedAt: z.string().nullable().optional(),
        category: z.string().nullable().optional(),
        ongoing: z.boolean().optional(),
        notes: z.string().nullable().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const { id, ...fields } = input;
      const setClauses: ReturnType<typeof sql>[] = [];
      if (fields.label !== undefined) setClauses.push(sql`label = ${fields.label}`);
      if (fields.startedAt !== undefined)
        setClauses.push(sql`started_at = ${fields.startedAt}::date`);
      if (fields.endedAt !== undefined)
        setClauses.push(
          fields.endedAt ? sql`ended_at = ${fields.endedAt}::date` : sql`ended_at = NULL`,
        );
      if (fields.category !== undefined)
        setClauses.push(
          fields.category ? sql`category = ${fields.category}` : sql`category = NULL`,
        );
      if (fields.ongoing !== undefined) setClauses.push(sql`ongoing = ${fields.ongoing}`);
      if (fields.notes !== undefined)
        setClauses.push(fields.notes ? sql`notes = ${fields.notes}` : sql`notes = NULL`);

      if (setClauses.length === 0) return null;

      const setExpr = sql.join(setClauses, sql`, `);
      const rows = await executeWithSchema(
        ctx.db,
        lifeEventFullRowSchema,
        sql`UPDATE fitness.life_events SET ${setExpr} WHERE user_id = ${ctx.userId} AND id = ${id} RETURNING *`,
      );
      return rows[0] ?? null;
    }),

  delete: protectedProcedure
    .input(z.object({ id: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.execute(
        sql`DELETE FROM fitness.life_events WHERE user_id = ${ctx.userId} AND id = ${input.id}`,
      );
      return { success: true };
    }),

  /** Analyze: compare metrics before vs after (or during vs outside) a life event */
  analyze: cachedProtectedQuery(CacheTTL.SHORT)
    .input(
      z.object({
        id: z.string().uuid(),
        windowDays: z.number().default(30),
      }),
    )
    .query(async ({ ctx, input }) => {
      // Get the event
      const lifeEventSchema = z
        .object({
          started_at: z.string(),
          ended_at: z.string().nullable(),
          ongoing: z.boolean(),
        })
        .passthrough();

      const events = await executeWithSchema(
        ctx.db,
        lifeEventSchema,
        sql`SELECT * FROM fitness.life_events WHERE user_id = ${ctx.userId} AND id = ${input.id}`,
      );
      if (!events[0]) return null;
      const event = events[0];

      const startDate = event.started_at;
      const endDate = event.ended_at ?? (event.ongoing ? "NOW()" : null);
      const windowDays = input.windowDays;

      // For point events or ongoing: compare windowDays before start vs windowDays after start
      // For ranged events: compare windowDays before start vs during the range
      const beforeClause = sql`user_id = ${ctx.userId} AND date BETWEEN (${startDate}::date - ${windowDays}::int) AND (${startDate}::date - 1)`;
      const afterClause = endDate
        ? sql`user_id = ${ctx.userId} AND date BETWEEN ${startDate}::date AND ${endDate === "NOW()" ? sql`CURRENT_DATE` : sql`${endDate}::date`}`
        : sql`user_id = ${ctx.userId} AND date BETWEEN ${startDate}::date AND (${startDate}::date + ${windowDays}::int)`;

      const results = await executeWithSchema(
        ctx.db,
        metricsComparisonRowSchema,
        sql`
        WITH before_period AS (
          SELECT 'before' as period, *
          FROM fitness.v_daily_metrics
          WHERE ${beforeClause}
        ),
        after_period AS (
          SELECT 'after' as period, *
          FROM fitness.v_daily_metrics
          WHERE ${afterClause}
        ),
        combined AS (
          SELECT * FROM before_period
          UNION ALL
          SELECT * FROM after_period
        )
        SELECT
          period,
          COUNT(*) as days,
          AVG(resting_hr)::numeric(10,1) as avg_resting_hr,
          AVG(hrv)::numeric(10,1) as avg_hrv,
          AVG(steps)::numeric(10,0) as avg_steps,
          AVG(active_energy_kcal)::numeric(10,0) as avg_active_energy
        FROM combined
        GROUP BY period
        ORDER BY period
      `,
      );

      // Sleep + body comp queries in parallel
      const [sleepResults, bodyResults] = await Promise.all([
        executeWithSchema(
          ctx.db,
          sleepComparisonRowSchema,
          sql`
          WITH before_sleep AS (
            SELECT 'before' as period, *
            FROM fitness.v_sleep
            WHERE user_id = ${ctx.userId}
              AND (started_at AT TIME ZONE ${ctx.timezone})::date BETWEEN (${startDate}::date - ${windowDays}::int) AND (${startDate}::date - 1)
              AND NOT is_nap
          ),
          after_sleep AS (
            SELECT 'after' as period, *
            FROM fitness.v_sleep
            WHERE user_id = ${ctx.userId}
              AND ${
                endDate
                  ? endDate === "NOW()"
                    ? sql`(started_at AT TIME ZONE ${ctx.timezone})::date BETWEEN ${startDate}::date AND CURRENT_DATE`
                    : sql`(started_at AT TIME ZONE ${ctx.timezone})::date BETWEEN ${startDate}::date AND ${endDate}::date`
                  : sql`(started_at AT TIME ZONE ${ctx.timezone})::date BETWEEN ${startDate}::date AND (${startDate}::date + ${windowDays}::int)`
              }
              AND NOT is_nap
          ),
          combined AS (
            SELECT * FROM before_sleep
            UNION ALL
            SELECT * FROM after_sleep
          )
          SELECT
            period,
            COUNT(*) as nights,
            AVG(duration_minutes)::numeric(10,0) as avg_sleep_min,
            AVG(deep_minutes)::numeric(10,0) as avg_deep_min,
            AVG(rem_minutes)::numeric(10,0) as avg_rem_min,
            AVG(efficiency_pct)::numeric(10,1) as avg_efficiency
          FROM combined
          GROUP BY period
          ORDER BY period
        `,
        ),
        executeWithSchema(
          ctx.db,
          bodyComparisonRowSchema,
          sql`
          WITH before_body AS (
            SELECT 'before' as period, *
            FROM fitness.v_body_measurement
            WHERE user_id = ${ctx.userId}
              AND (recorded_at AT TIME ZONE ${ctx.timezone})::date BETWEEN (${startDate}::date - ${windowDays}::int) AND (${startDate}::date - 1)
          ),
          after_body AS (
            SELECT 'after' as period, *
            FROM fitness.v_body_measurement
            WHERE user_id = ${ctx.userId}
              AND ${
                endDate
                  ? endDate === "NOW()"
                    ? sql`(recorded_at AT TIME ZONE ${ctx.timezone})::date BETWEEN ${startDate}::date AND CURRENT_DATE`
                    : sql`(recorded_at AT TIME ZONE ${ctx.timezone})::date BETWEEN ${startDate}::date AND ${endDate}::date`
                  : sql`(recorded_at AT TIME ZONE ${ctx.timezone})::date BETWEEN ${startDate}::date AND (${startDate}::date + ${windowDays}::int)`
              }
          ),
          combined AS (
            SELECT * FROM before_body
            UNION ALL
            SELECT * FROM after_body
          )
          SELECT
            period,
            COUNT(*) as measurements,
            AVG(weight_kg)::numeric(10,2) as avg_weight,
            AVG(body_fat_pct)::numeric(10,1) as avg_body_fat
          FROM combined
          GROUP BY period
          ORDER BY period
        `,
        ),
      ]);

      return {
        event,
        metrics: results,
        sleep: sleepResults,
        bodyComp: bodyResults,
      };
    }),
});
