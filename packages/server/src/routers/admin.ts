import { PROVIDER_GUIDE_SETTINGS_KEY } from "@dofek/onboarding/provider-guide";
import { TRPCError } from "@trpc/server";
import { getProviderRateLimitStatusFromRedis } from "dofek/admin/provider-rate-limit-status";
import { invalidateAllUserQueries, queryCache } from "dofek/lib/cache";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { resolveAccessWindow } from "../billing/entitlement.ts";
import { executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import { adminProcedure, router } from "../trpc.ts";

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

const userDetailProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string().nullable(),
  birth_date: z.string().nullable(),
  is_admin: z.boolean(),
  created_at: timestampStringSchema,
  updated_at: timestampStringSchema,
});

const userDetailSettingsFlagSchema = z.object({
  value: z.unknown(),
});

const userDetailBillingSchema = z.object({
  user_id: z.string(),
  stripe_customer_id: z.string().nullable(),
  stripe_subscription_id: z.string().nullable(),
  stripe_subscription_status: z.string().nullable(),
  stripe_current_period_end: timestampStringSchema.nullable(),
  paid_grant_reason: z.string().nullable(),
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
  canonical_type: z.string().nullable(),
  provider_type: z.string(),
  modality: z.string().nullable(),
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
  food_name: z.string().nullable(),
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

function requireBodyMeasurementStore(sensorStore: ActivitySensorStore | undefined) {
  if (!sensorStore) {
    throw new Error("admin body measurements require the ClickHouse body measurement store");
  }
  return sensorStore;
}

export const adminRouter = router({
  /** High-level overview: row counts for all key tables */
  overview: adminProcedure.query(async ({ ctx }) => {
    const bodyStore = requireBodyMeasurementStore(ctx.sensorStore);
    const [rows, bodyRows] = await Promise.all([
      executeWithSchema(
        ctx.db,
        overviewCountSchema,
        sql`WITH target_tables(table_name) AS (
          VALUES
            ('user_profile'),
            ('activity'),
            ('sleep_session'),
            ('food_entry'),
            ('daily_metrics'),
            ('sync_log'),
            ('session'),
            ('auth_account'),
            ('oauth_token'),
            ('provider'),
            ('lab_panel'),
            ('journal_entry'),
            ('breathwork_session'),
            ('supplement'),
            ('life_events'),
            ('nutrient'),
            ('food_entry_nutrient'),
            ('supplement_definition'),
            ('supplement_definition_nutrient'),
            ('supplement_dose_event'),
            ('metric_stream')
        ),
        base_estimates AS (
          SELECT
            target_tables.table_name,
            GREATEST(pg_class.reltuples, 0)::bigint AS row_count
          FROM target_tables
          JOIN pg_class
            ON pg_class.relname = target_tables.table_name
          JOIN pg_namespace
            ON pg_namespace.oid = pg_class.relnamespace
           AND pg_namespace.nspname = 'fitness'
        ),
        metric_stream_chunk_estimates AS (
          SELECT
            COALESCE(SUM(GREATEST(chunk_class.reltuples, 0)), 0)::bigint AS row_count
          FROM pg_inherits
          JOIN pg_class AS parent_class
            ON parent_class.oid = pg_inherits.inhparent
          JOIN pg_namespace AS parent_namespace
            ON parent_namespace.oid = parent_class.relnamespace
           AND parent_namespace.nspname = 'fitness'
          JOIN pg_class AS chunk_class
            ON chunk_class.oid = pg_inherits.inhrelid
          WHERE parent_class.relname = 'metric_stream'
        )
        SELECT
          base_estimates.table_name,
          CASE
            WHEN base_estimates.table_name = 'metric_stream'
              THEN GREATEST(
                base_estimates.row_count,
                metric_stream_chunk_estimates.row_count
              )::text
            ELSE base_estimates.row_count::text
          END AS row_count
        FROM base_estimates
        CROSS JOIN metric_stream_chunk_estimates
        ORDER BY CASE
          WHEN base_estimates.table_name = 'metric_stream'
            THEN GREATEST(base_estimates.row_count, metric_stream_chunk_estimates.row_count)
          ELSE base_estimates.row_count
        END DESC`,
      ),
      bodyStore.query(
        overviewCountSchema,
        `
          SELECT 'body_metrics' AS table_name, count() AS row_count
          FROM analytics.v_body_measurement
        `,
      ),
    ]);
    return [...rows, ...bodyRows].sort((left, right) => right.row_count - left.row_count);
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
  userDetail: adminProcedure.input(z.object({ userId: z.guid() })).query(async ({ ctx, input }) => {
    const [profiles, flags, billingRows, accounts, providers, sessions] = await Promise.all([
      executeWithSchema(
        ctx.db,
        userDetailProfileSchema,
        sql`SELECT id, name, email, birth_date::text, is_admin, created_at::text, updated_at::text
              FROM fitness.user_profile
              WHERE id = ${input.userId}
              LIMIT 1`,
      ),
      executeWithSchema(
        ctx.db,
        userDetailSettingsFlagSchema,
        sql`SELECT value
              FROM fitness.user_settings
              WHERE user_id = ${input.userId}
                AND key = ${PROVIDER_GUIDE_SETTINGS_KEY}
              LIMIT 1`,
      ),
      executeWithSchema(
        ctx.db,
        userDetailBillingSchema,
        sql`SELECT user_id,
                     stripe_customer_id,
                     stripe_subscription_id,
                     stripe_subscription_status,
                     stripe_current_period_end::text AS stripe_current_period_end,
                     paid_grant_reason,
                     created_at::text AS created_at,
                     updated_at::text AS updated_at
              FROM fitness.user_billing
              WHERE user_id = ${input.userId}
              LIMIT 1`,
      ),
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
        sql`SELECT p.id, p.name, pc.created_at::text AS created_at
              FROM fitness.provider_connection pc
              JOIN fitness.provider p ON p.id = pc.provider_id
              WHERE pc.user_id = ${input.userId}
              ORDER BY pc.created_at`,
      ),
      executeWithSchema(
        ctx.db,
        userDetailSessionSchema,
        sql`SELECT id, created_at::text, expires_at::text
              FROM fitness.session WHERE user_id = ${input.userId}
              ORDER BY created_at DESC LIMIT 20`,
      ),
    ]);
    const profile = profiles[0];
    if (!profile) {
      throw new TRPCError({ code: "NOT_FOUND", message: "User not found" });
    }
    const billing = billingRows[0] ?? null;
    const access = resolveAccessWindow({
      userCreatedAt: profile.created_at,
      timezone: ctx.timezone,
      paidGrantReason: billing?.paid_grant_reason ?? null,
      stripeSubscriptionStatus: billing?.stripe_subscription_status ?? null,
    });
    return {
      profile,
      flags: {
        providerGuideDismissed: flags[0]?.value === true,
      },
      billing,
      access,
      stripeLinks: {
        customer: billing?.stripe_customer_id
          ? `https://dashboard.stripe.com/customers/${billing.stripe_customer_id}`
          : null,
        subscription: billing?.stripe_subscription_id
          ? `https://dashboard.stripe.com/subscriptions/${billing.stripe_subscription_id}`
          : null,
      },
      accounts,
      providers,
      sessions,
    };
  }),

  /** Toggle admin status for a user */
  setAdmin: adminProcedure
    .input(z.object({ userId: z.guid(), isAdmin: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.execute(
        sql`UPDATE fitness.user_profile SET is_admin = ${input.isAdmin}, updated_at = NOW()
            WHERE id = ${input.userId}`,
      );
      return { ok: true };
    }),

  /** Toggle the provider guide dismissal flag for a user */
  setProviderGuideDismissed: adminProcedure
    .input(z.object({ userId: z.guid(), dismissed: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      await ctx.db.execute(
        sql`INSERT INTO fitness.user_settings (user_id, key, value, updated_at)
            VALUES (${input.userId}, ${PROVIDER_GUIDE_SETTINGS_KEY}, ${JSON.stringify(input.dismissed)}::jsonb, NOW())
            ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      );
      await queryCache.invalidateByPrefix(`${input.userId}:providerGuide.`);
      return { ok: true };
    }),

  /** Toggle local free-access grant without mutating Stripe */
  setPaidGrant: adminProcedure
    .input(z.object({ userId: z.guid(), enabled: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      if (input.enabled) {
        await ctx.db.execute(
          sql`INSERT INTO fitness.user_billing (user_id, paid_grant_reason)
              VALUES (${input.userId}, 'admin_grant')
              ON CONFLICT (user_id) DO UPDATE SET
                paid_grant_reason = EXCLUDED.paid_grant_reason,
                updated_at = NOW()`,
        );
        await invalidateAllUserQueries(input.userId);
        return { ok: true };
      }

      await ctx.db.execute(
        sql`UPDATE fitness.user_billing
            SET paid_grant_reason = null,
                updated_at = NOW()
            WHERE user_id = ${input.userId}`,
      );
      await invalidateAllUserQueries(input.userId);
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
                   a.canonical_type, a.provider_type, a.modality::text AS modality,
                   a.name, a.started_at::text,
                   EXTRACT(EPOCH FROM (a.ended_at - a.started_at))::text AS duration_seconds,
                   a.source_name
            FROM fitness.activity a
            LEFT JOIN fitness.user_profile up ON up.id = a.user_id
            WHERE a.provider_absent_at IS NULL
              AND a.deleted_at IS NULL
            ORDER BY a.started_at DESC
            LIMIT ${input.limit} OFFSET ${input.offset}`,
      ),
      executeWithSchema(
        ctx.db,
        countSchema,
        sql`SELECT COUNT(*)::text AS count FROM fitness.activity WHERE provider_absent_at IS NULL AND deleted_at IS NULL`,
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
                   fe.food_name, fe.calories::text, fe.protein_g::text, fe.meal,
                   fe.logged_at::text, fe.provider_id
            FROM fitness.v_food_entry_with_nutrition fe
            LEFT JOIN fitness.user_profile up ON up.id = fe.user_id
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
    const bodyStore = requireBodyMeasurementStore(ctx.sensorStore);
    const [rows, countRows] = await Promise.all([
      bodyStore.query(
        bodyMeasurementRowSchema,
        `
          SELECT
            toString(bm.id) AS id,
            toString(bm.user_id) AS user_id,
            up.name AS user_name,
            toString(bm.recorded_at) AS recorded_at,
            bm.source_name AS source_name,
            bm.provider_id AS provider_id
          FROM analytics.v_body_measurement AS bm
          LEFT JOIN postgres_fitness.user_profile_current AS up
            ON up.id = bm.user_id
          ORDER BY bm.recorded_at DESC
          LIMIT {limit:UInt32}
          OFFSET {offset:UInt32}
        `,
        { limit: input.limit, offset: input.offset },
      ),
      bodyStore.query(
        countSchema,
        `
          SELECT count() AS count
          FROM analytics.v_body_measurement
        `,
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

  /** Live provider rate-limit estimations from Redis adaptive state and cooldowns */
  rateLimits: adminProcedure.query(async () => {
    return getProviderRateLimitStatusFromRedis();
  }),
});
