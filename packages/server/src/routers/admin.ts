import { createTrainingExportQueue } from "dofek/jobs/queues";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { startWorker } from "../lib/start-worker.ts";
import { executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import { logger } from "../logger.ts";
import { adminProcedure, router } from "../trpc.ts";

const ALL_MATERIALIZED_VIEWS = [
  "fitness.v_activity",
  "fitness.v_sleep",
  "fitness.v_body_measurement",
  "fitness.v_daily_metrics",
  "fitness.activity_summary",
] as const;

const trainingExportQueue = createTrainingExportQueue();

// ── Schemas for admin queries ──

const overviewCountSchema = z.object({
  table_name: z.string(),
  row_count: z.coerce.number(),
});

const userRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  birth_date: z.string().nullable(),
  is_admin: z.boolean(),
  created_at: timestampStringSchema,
  updated_at: timestampStringSchema,
});

const userDetailAccountSchema = z.object({
  id: z.string(),
  auth_provider: z.string(),
  provider_account_id: z.string(),
  email: z.string().nullable(),
  name: z.string().nullable(),
  created_at: timestampStringSchema,
});

const userDetailProviderSchema = z.object({
  id: z.string(),
  name: z.string(),
  created_at: timestampStringSchema,
});

const userDetailSessionSchema = z.object({
  id: z.string(),
  created_at: timestampStringSchema,
  expires_at: timestampStringSchema,
});

const syncLogRowSchema = z.object({
  id: z.string(),
  provider_id: z.string(),
  user_id: z.string(),
  user_name: z.string().nullable(),
  data_type: z.string(),
  status: z.string(),
  record_count: z.coerce.number().nullable(),
  error_message: z.string().nullable(),
  duration_ms: z.coerce.number().nullable(),
  synced_at: timestampStringSchema,
});

const activityRowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  user_name: z.string().nullable(),
  provider_id: z.string(),
  activity_type: z.string().nullable(),
  name: z.string().nullable(),
  started_at: timestampStringSchema,
  duration_seconds: z.coerce.number().nullable(),
  source_name: z.string().nullable(),
});

const sleepRowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  user_name: z.string().nullable(),
  provider_id: z.string(),
  started_at: timestampStringSchema,
  ended_at: timestampStringSchema,
  sleep_type: z.string().nullable(),
  source_name: z.string().nullable(),
});

const sessionRowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  user_name: z.string().nullable(),
  created_at: timestampStringSchema,
  expires_at: timestampStringSchema,
  is_expired: z.boolean(),
});

const foodEntryRowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  user_name: z.string().nullable(),
  food_name: z.string(),
  calories: z.coerce.number().nullable(),
  protein_g: z.coerce.number().nullable(),
  meal: z.string().nullable(),
  logged_at: timestampStringSchema.nullable(),
  provider_id: z.string(),
});

const bodyMeasurementRowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  user_name: z.string().nullable(),
  recorded_at: timestampStringSchema,
  source_name: z.string().nullable(),
  provider_id: z.string().nullable(),
});

const dailyMetricRowSchema = z.object({
  id: z.string(),
  user_id: z.string(),
  user_name: z.string().nullable(),
  date: z.string(),
  provider_id: z.string(),
  source_name: z.string().nullable(),
});

const oauthTokenRowSchema = z.object({
  user_id: z.string(),
  user_name: z.string().nullable(),
  provider_id: z.string(),
  expires_at: timestampStringSchema.nullable(),
  scopes: z.string().nullable(),
  updated_at: timestampStringSchema,
});

const paginationInput = z.object({
  limit: z.number().min(1).max(200).default(50),
  offset: z.number().min(0).default(0),
});

const countSchema = z.object({ count: z.coerce.number() });

export const adminRouter = router({
  /** High-level overview: row counts for all key tables */
  overview: adminProcedure.query(async ({ ctx }) => {
    const rows = await executeWithSchema(
      ctx.db,
      overviewCountSchema,
      sql`SELECT table_name, row_count FROM (
        SELECT 'user_profile' AS table_name, COUNT(*)::text AS row_count FROM fitness.user_profile
        UNION ALL SELECT 'activity', COUNT(*)::text FROM fitness.activity
        UNION ALL SELECT 'sleep_session', COUNT(*)::text FROM fitness.sleep_session
        UNION ALL SELECT 'food_entry', COUNT(*)::text FROM fitness.food_entry
        UNION ALL SELECT 'daily_metrics', COUNT(*)::text FROM fitness.daily_metrics
        UNION ALL SELECT 'body_measurement', COUNT(*)::text FROM fitness.body_measurement
        UNION ALL SELECT 'strength_workout', COUNT(*)::text FROM fitness.strength_workout
        UNION ALL SELECT 'sync_log', COUNT(*)::text FROM fitness.sync_log
        UNION ALL SELECT 'session', COUNT(*)::text FROM fitness.session
        UNION ALL SELECT 'auth_account', COUNT(*)::text FROM fitness.auth_account
        UNION ALL SELECT 'oauth_token', COUNT(*)::text FROM fitness.oauth_token
        UNION ALL SELECT 'provider', COUNT(*)::text FROM fitness.provider
        UNION ALL SELECT 'lab_panel', COUNT(*)::text FROM fitness.lab_panel
        UNION ALL SELECT 'journal_entry', COUNT(*)::text FROM fitness.journal_entry
        UNION ALL SELECT 'breathwork_session', COUNT(*)::text FROM fitness.breathwork_session
        UNION ALL SELECT 'supplement', COUNT(*)::text FROM fitness.supplement
        UNION ALL SELECT 'life_events', COUNT(*)::text FROM fitness.life_events
        UNION ALL SELECT 'nutrition_data', COUNT(*)::text FROM fitness.nutrition_data
        UNION ALL SELECT 'metric_stream', COUNT(*)::text FROM fitness.metric_stream
      ) counts ORDER BY row_count DESC`,
    );
    return rows;
  }),

  /** List all users with their profiles */
  users: adminProcedure.query(async ({ ctx }) => {
    return executeWithSchema(
      ctx.db,
      userRowSchema,
      sql`SELECT id, name, email, birth_date::text, is_admin, created_at::text, updated_at::text
          FROM fitness.user_profile
          ORDER BY created_at`,
    );
  }),

  /** Detailed view of a single user: their accounts, providers, sessions */
  userDetail: adminProcedure
    .input(z.object({ userId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      const [accounts, providers, sessions] = await Promise.all([
        executeWithSchema(
          ctx.db,
          userDetailAccountSchema,
          sql`SELECT id, auth_provider, provider_account_id, email, name, created_at::text
              FROM fitness.auth_account WHERE user_id = ${input.userId}
              ORDER BY created_at`,
        ),
        executeWithSchema(
          ctx.db,
          userDetailProviderSchema,
          sql`SELECT p.id, p.name, MAX(ot.created_at)::text AS created_at
              FROM fitness.oauth_token ot
              JOIN fitness.provider p ON p.id = ot.provider_id
              WHERE ot.user_id = ${input.userId}
              GROUP BY p.id, p.name
              ORDER BY created_at`,
        ),
        executeWithSchema(
          ctx.db,
          userDetailSessionSchema,
          sql`SELECT id, created_at::text, expires_at::text
              FROM fitness.session WHERE user_id = ${input.userId}
              ORDER BY created_at DESC LIMIT 20`,
        ),
      ]);
      return { accounts, providers, sessions };
    }),

  /** Toggle admin status for a user */
  setAdmin: adminProcedure
    .input(z.object({ userId: z.string().uuid(), isAdmin: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.execute(
        sql`UPDATE fitness.user_profile SET is_admin = ${input.isAdmin}, updated_at = NOW()
            WHERE id = ${input.userId}`,
      );
      return { ok: true };
    }),

  /** Paginated sync logs (most recent first) */
  syncLogs: adminProcedure.input(paginationInput).query(async ({ ctx, input }) => {
    const [rows, countRows] = await Promise.all([
      executeWithSchema(
        ctx.db,
        syncLogRowSchema,
        sql`SELECT sl.id, sl.provider_id, sl.user_id, up.name AS user_name,
                   sl.data_type, sl.status, sl.record_count::text, sl.error_message,
                   sl.duration_ms::text, sl.synced_at::text
            FROM fitness.sync_log sl
            LEFT JOIN fitness.user_profile up ON up.id = sl.user_id
            ORDER BY sl.synced_at DESC
            LIMIT ${input.limit} OFFSET ${input.offset}`,
      ),
      executeWithSchema(
        ctx.db,
        countSchema,
        sql`SELECT COUNT(*)::text AS count FROM fitness.sync_log`,
      ),
    ]);
    return { rows, total: countRows[0]?.count ?? 0 };
  }),

  /** Paginated activities */
  activities: adminProcedure.input(paginationInput).query(async ({ ctx, input }) => {
    const [rows, countRows] = await Promise.all([
      executeWithSchema(
        ctx.db,
        activityRowSchema,
        sql`SELECT a.id, a.user_id, up.name AS user_name, a.provider_id,
                   a.activity_type, a.name, a.started_at::text,
                   EXTRACT(EPOCH FROM (a.ended_at - a.started_at))::text AS duration_seconds,
                   a.source_name
            FROM fitness.activity a
            LEFT JOIN fitness.user_profile up ON up.id = a.user_id
            ORDER BY a.started_at DESC
            LIMIT ${input.limit} OFFSET ${input.offset}`,
      ),
      executeWithSchema(
        ctx.db,
        countSchema,
        sql`SELECT COUNT(*)::text AS count FROM fitness.activity`,
      ),
    ]);
    return { rows, total: countRows[0]?.count ?? 0 };
  }),

  /** Paginated sleep sessions */
  sleepSessions: adminProcedure.input(paginationInput).query(async ({ ctx, input }) => {
    const [rows, countRows] = await Promise.all([
      executeWithSchema(
        ctx.db,
        sleepRowSchema,
        sql`SELECT ss.id, ss.user_id, up.name AS user_name, ss.provider_id,
                   ss.started_at::text, ss.ended_at::text, ss.sleep_type, ss.source_name
            FROM fitness.sleep_session ss
            LEFT JOIN fitness.user_profile up ON up.id = ss.user_id
            ORDER BY ss.started_at DESC
            LIMIT ${input.limit} OFFSET ${input.offset}`,
      ),
      executeWithSchema(
        ctx.db,
        countSchema,
        sql`SELECT COUNT(*)::text AS count FROM fitness.sleep_session`,
      ),
    ]);
    return { rows, total: countRows[0]?.count ?? 0 };
  }),

  /** Active/expired sessions */
  sessions: adminProcedure.input(paginationInput).query(async ({ ctx, input }) => {
    const [rows, countRows] = await Promise.all([
      executeWithSchema(
        ctx.db,
        sessionRowSchema,
        sql`SELECT s.id, s.user_id, up.name AS user_name,
                   s.created_at::text, s.expires_at::text,
                   (s.expires_at <= NOW()) AS is_expired
            FROM fitness.session s
            LEFT JOIN fitness.user_profile up ON up.id = s.user_id
            ORDER BY s.created_at DESC
            LIMIT ${input.limit} OFFSET ${input.offset}`,
      ),
      executeWithSchema(
        ctx.db,
        countSchema,
        sql`SELECT COUNT(*)::text AS count FROM fitness.session`,
      ),
    ]);
    return { rows, total: countRows[0]?.count ?? 0 };
  }),

  /** Delete a session (force logout) */
  deleteSession: adminProcedure
    .input(z.object({ sessionId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.execute(sql`DELETE FROM fitness.session WHERE id = ${input.sessionId}`);
      return { ok: true };
    }),

  /** Paginated food entries */
  foodEntries: adminProcedure.input(paginationInput).query(async ({ ctx, input }) => {
    const [rows, countRows] = await Promise.all([
      executeWithSchema(
        ctx.db,
        foodEntryRowSchema,
        sql`SELECT fe.id, fe.user_id, up.name AS user_name,
                   fe.food_name, nd.calories::text, nd.protein_g::text, fe.meal,
                   fe.logged_at::text, fe.provider_id
            FROM fitness.food_entry fe
            LEFT JOIN fitness.user_profile up ON up.id = fe.user_id
            LEFT JOIN fitness.nutrition_data nd ON nd.id = fe.nutrition_data_id
            ORDER BY fe.logged_at DESC NULLS LAST
            LIMIT ${input.limit} OFFSET ${input.offset}`,
      ),
      executeWithSchema(
        ctx.db,
        countSchema,
        sql`SELECT COUNT(*)::text AS count FROM fitness.food_entry`,
      ),
    ]);
    return { rows, total: countRows[0]?.count ?? 0 };
  }),

  /** Paginated body measurements */
  bodyMeasurements: adminProcedure.input(paginationInput).query(async ({ ctx, input }) => {
    const [rows, countRows] = await Promise.all([
      executeWithSchema(
        ctx.db,
        bodyMeasurementRowSchema,
        sql`SELECT bm.id, bm.user_id, up.name AS user_name,
                   bm.recorded_at::text, bm.source_name, bm.provider_id
            FROM fitness.body_measurement bm
            LEFT JOIN fitness.user_profile up ON up.id = bm.user_id
            ORDER BY bm.recorded_at DESC
            LIMIT ${input.limit} OFFSET ${input.offset}`,
      ),
      executeWithSchema(
        ctx.db,
        countSchema,
        sql`SELECT COUNT(*)::text AS count FROM fitness.body_measurement`,
      ),
    ]);
    return { rows, total: countRows[0]?.count ?? 0 };
  }),

  /** Paginated daily metrics */
  dailyMetrics: adminProcedure.input(paginationInput).query(async ({ ctx, input }) => {
    const [rows, countRows] = await Promise.all([
      executeWithSchema(
        ctx.db,
        dailyMetricRowSchema,
        sql`SELECT dm.id, dm.user_id, up.name AS user_name,
                   dm.date::text, dm.provider_id, dm.source_name
            FROM fitness.daily_metrics dm
            LEFT JOIN fitness.user_profile up ON up.id = dm.user_id
            ORDER BY dm.date DESC
            LIMIT ${input.limit} OFFSET ${input.offset}`,
      ),
      executeWithSchema(
        ctx.db,
        countSchema,
        sql`SELECT COUNT(*)::text AS count FROM fitness.daily_metrics`,
      ),
    ]);
    return { rows, total: countRows[0]?.count ?? 0 };
  }),

  /** OAuth tokens (no secrets exposed, just metadata) */
  oauthTokens: adminProcedure.query(async ({ ctx }) => {
    return executeWithSchema(
      ctx.db,
      oauthTokenRowSchema,
      sql`SELECT ot.user_id, up.name AS user_name,
                 ot.provider_id, ot.expires_at::text, ot.scopes, ot.updated_at::text
          FROM fitness.oauth_token ot
          LEFT JOIN fitness.user_profile up ON up.id = ot.user_id
          ORDER BY ot.updated_at DESC`,
    );
  }),

  /** Sync health: success/failure counts per provider in last 7 days */
  syncHealth: adminProcedure.query(async ({ ctx }) => {
    const healthSchema = z.object({
      provider_id: z.string(),
      total: z.coerce.number(),
      succeeded: z.coerce.number(),
      failed: z.coerce.number(),
      last_sync: timestampStringSchema.nullable(),
    });
    return executeWithSchema(
      ctx.db,
      healthSchema,
      sql`SELECT provider_id,
                 COUNT(*)::text AS total,
                 COUNT(*) FILTER (WHERE status = 'success')::text AS succeeded,
                 COUNT(*) FILTER (WHERE status = 'error')::text AS failed,
                 MAX(synced_at)::text AS last_sync
          FROM fitness.sync_log
          WHERE synced_at > NOW() - INTERVAL '7 days'
          GROUP BY provider_id
          ORDER BY failed DESC, total DESC`,
    );
  }),

  /** Trigger a global training data export */
  triggerTrainingExport: adminProcedure
    .input(
      z.object({
        since: z.string().optional(),
        until: z.string().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const queue = trainingExportQueue;
      const job = await queue.add("training-export", {
        since: input.since,
        until: input.until,
      });
      startWorker();
      return { jobId: String(job.id) };
    }),

  /** Force-refresh all materialized views (dedup + rollup). */
  refreshViews: adminProcedure.mutation(async ({ ctx }) => {
    logger.info("[admin] Refreshing all materialized views");
    const refreshed: string[] = [];
    for (const view of ALL_MATERIALIZED_VIEWS) {
      try {
        await ctx.db.execute(sql.raw(`REFRESH MATERIALIZED VIEW CONCURRENTLY ${view}`));
      } catch {
        await ctx.db.execute(sql.raw(`REFRESH MATERIALIZED VIEW ${view}`));
      }
      refreshed.push(view);
    }
    logger.info(`[admin] Refreshed ${refreshed.length} materialized views`);
    return { refreshed };
  }),

  /** Get training export watermark status */
  trainingExportStatus: adminProcedure.query(async ({ ctx }) => {
    const watermarkSchema = z.object({
      table_name: z.string(),
      last_exported_at: timestampStringSchema,
      row_count: z.coerce.number(),
      updated_at: timestampStringSchema,
    });
    const watermarks = await executeWithSchema(
      ctx.db,
      watermarkSchema,
      sql`SELECT table_name, last_exported_at::text, row_count::text, updated_at::text
          FROM fitness.training_export_watermark
          ORDER BY table_name`,
    );
    return { watermarks };
  }),
});
