import { createSyncQueue } from "dofek/jobs/queues";
import { getAllProviders, registerProvider } from "dofek/providers/registry";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { startWorker } from "../lib/start-worker.ts";
import { getSystemLogs, logger } from "../logger.ts";
import { CacheTTL, cachedProtectedQuery, protectedProcedure, router } from "../trpc.ts";

// ── Input schemas ──
export const triggerSyncInput = z.object({
  providerId: z.string().optional(),
  sinceDays: z.number().optional(),
});

export const syncStatusInput = z.object({ jobId: z.string() });

export const logsInput = z.object({ limit: z.number().default(100) });

export const systemLogsInput = z.object({ limit: z.number().default(200) });

// ── Provider registration (race-safe) ──
let registrationPromise: Promise<void> | null = null;

export function ensureProvidersRegistered(): Promise<void> {
  if (!registrationPromise) {
    registrationPromise = doRegisterProviders();
  }
  return registrationPromise;
}

async function doRegisterProviders() {
  const providers = [
    ["wahoo", () => import("dofek/providers/wahoo").then((m) => new m.WahooProvider())],
    ["withings", () => import("dofek/providers/withings").then((m) => new m.WithingsProvider())],
    ["peloton", () => import("dofek/providers/peloton").then((m) => new m.PelotonProvider())],
    ["fatsecret", () => import("dofek/providers/fatsecret").then((m) => new m.FatSecretProvider())],
    ["whoop", () => import("dofek/providers/whoop").then((m) => new m.WhoopProvider())],
    [
      "ride-with-gps",
      () => import("dofek/providers/ride-with-gps").then((m) => new m.RideWithGpsProvider()),
    ],
    [
      "strong-csv",
      () => import("dofek/providers/strong-csv").then((m) => new m.StrongCsvProvider()),
    ],
    ["polar", () => import("dofek/providers/polar").then((m) => new m.PolarProvider())],
    ["fitbit", () => import("dofek/providers/fitbit").then((m) => new m.FitbitProvider())],
    ["garmin", () => import("dofek/providers/garmin").then((m) => new m.GarminProvider())],
    ["strava", () => import("dofek/providers/strava").then((m) => new m.StravaProvider())],
    [
      "cronometer-csv",
      () => import("dofek/providers/cronometer-csv").then((m) => new m.CronometerCsvProvider()),
    ],
    ["oura", () => import("dofek/providers/oura").then((m) => new m.OuraProvider())],
    [
      "eight-sleep",
      () => import("dofek/providers/eight-sleep").then((m) => new m.EightSleepProvider()),
    ],
    ["zwift", () => import("dofek/providers/zwift").then((m) => new m.ZwiftProvider())],
    [
      "trainerroad",
      () => import("dofek/providers/trainerroad").then((m) => new m.TrainerRoadProvider()),
    ],
    [
      "ultrahuman",
      () => import("dofek/providers/ultrahuman").then((m) => new m.UltrahumanProvider()),
    ],
    [
      "mapmyfitness",
      () => import("dofek/providers/mapmyfitness").then((m) => new m.MapMyFitnessProvider()),
    ],
    ["suunto", () => import("dofek/providers/suunto").then((m) => new m.SuuntoProvider())],
    ["coros", () => import("dofek/providers/coros").then((m) => new m.CorosProvider())],
    ["concept2", () => import("dofek/providers/concept2").then((m) => new m.Concept2Provider())],
    ["komoot", () => import("dofek/providers/komoot").then((m) => new m.KomootProvider())],
    ["xert", () => import("dofek/providers/xert").then((m) => new m.XertProvider())],
    [
      "cycling_analytics",
      () =>
        import("dofek/providers/cycling-analytics").then((m) => new m.CyclingAnalyticsProvider()),
    ],
    ["wger", () => import("dofek/providers/wger").then((m) => new m.WgerProvider())],
    ["decathlon", () => import("dofek/providers/decathlon").then((m) => new m.DecathlonProvider())],
    ["velohero", () => import("dofek/providers/velohero").then((m) => new m.VeloHeroProvider())],
  ] as const;

  for (const [name, loadProvider] of providers) {
    try {
      registerProvider(await loadProvider());
    } catch (err) {
      logger.warn(`[sync] Failed to register ${name} provider: ${err}`);
    }
  }
}

// ── BullMQ sync queue (lazy init) ──
let _syncQueue: ReturnType<typeof createSyncQueue> | null = null;

function getSyncQueue() {
  if (!_syncQueue) _syncQueue = createSyncQueue();
  return _syncQueue;
}

/** Map BullMQ job state to the frontend SyncJobStatus shape */
function mapBullMqStateToSyncStatus(state: string): "running" | "done" | "error" {
  switch (state) {
    case "completed":
      return "done";
    case "failed":
      return "error";
    default:
      return "running";
  }
}

export const syncRouter = router({
  /** List all providers and whether they're enabled (have valid config) */
  providers: cachedProtectedQuery(CacheTTL.SHORT).query(async ({ ctx }) => {
    await ensureProvidersRegistered();
    const all = getAllProviders();

    // Batch: load all tokens + last sync times in 2 queries instead of 2N
    const [allTokens, lastSyncs] = await Promise.all([
      ctx.db.execute<{ provider_id: string }>(
        sql`SELECT DISTINCT ot.provider_id
            FROM fitness.oauth_token ot
            JOIN fitness.provider p ON p.id = ot.provider_id
            WHERE p.user_id = ${ctx.userId}`,
      ),
      ctx.db.execute<{ provider_id: string; last_synced: string }>(sql`
        SELECT provider_id, MAX(synced_at) AS last_synced
        FROM fitness.sync_log
        WHERE user_id = ${ctx.userId}
        GROUP BY provider_id
      `),
    ]);

    const tokenSet = new Set(allTokens.map((r) => r.provider_id));
    const lastSyncMap = new Map(lastSyncs.map((r) => [r.provider_id, r.last_synced]));

    // Import-only providers have no real sync — they only work via file upload
    const importOnlyIds = new Set(["strong-csv", "cronometer-csv"]);

    return all.map((p) => {
      let setup: ReturnType<NonNullable<typeof p.authSetup>> | undefined;
      try {
        setup = p.authSetup?.();
      } catch {
        /* credentials not configured */
      }
      const needsOAuth = !!setup?.oauthConfig;
      const needsCustomAuth = p.id === "whoop";
      const needsAuth = needsOAuth || needsCustomAuth;
      const authorized = needsAuth ? tokenSet.has(p.id) : true;
      const lastSyncedAt = lastSyncMap.get(p.id) ?? null;
      const validation = p.validate();

      return {
        id: p.id,
        name: p.name,
        enabled: validation === null,
        error: validation,
        needsOAuth,
        needsCustomAuth,
        authorized,
        lastSyncedAt,
        importOnly: importOnlyIds.has(p.id),
      };
    });
  }),

  /** Trigger sync — enqueues a BullMQ job, returns immediately with jobId */
  triggerSync: protectedProcedure.input(triggerSyncInput).mutation(async ({ ctx, input }) => {
    await ensureProvidersRegistered();

    // Validate provider exists and is configured before enqueuing
    if (input.providerId) {
      const provider = getAllProviders().find((p) => p.id === input.providerId);
      if (!provider) throw new Error(`Unknown provider: ${input.providerId}`);
      const validation = provider.validate();
      if (validation) throw new Error(`Provider not configured: ${validation}`);
    }

    const job = await getSyncQueue().add("sync", {
      providerId: input.providerId,
      sinceDays: input.sinceDays,
      userId: ctx.userId,
    });

    startWorker();
    return { jobId: job.id ?? `job-${Date.now()}` };
  }),

  /** Poll sync job status — reads from BullMQ */
  syncStatus: protectedProcedure.input(syncStatusInput).query(async ({ ctx, input }) => {
    if (!input.jobId) return null;

    let job: Awaited<ReturnType<ReturnType<typeof getSyncQueue>["getJob"]>> | undefined;
    try {
      job = await getSyncQueue().getJob(input.jobId);
    } catch {
      return null; // Redis unavailable
    }
    if (!job) return null;

    // Only return status for jobs belonging to the requesting user
    if (job.data.userId !== ctx.userId) return null;

    const state = await job.getState();

    const progressSchema = z.object({
      providers: z
        .record(
          z.object({
            status: z.enum(["pending", "running", "done", "error"]),
            message: z.string().optional(),
          }),
        )
        .optional(),
    });
    const parsed = progressSchema.safeParse(job.progress);
    const progress = parsed.success ? parsed.data : undefined;

    return {
      status: mapBullMqStateToSyncStatus(state),
      providers: progress?.providers ?? {},
      message:
        state === "failed" ? job.failedReason : state === "completed" ? "Sync complete" : undefined,
    };
  }),

  /** Get sync log history */
  logs: cachedProtectedQuery(CacheTTL.SHORT)
    .input(logsInput)
    .query(async ({ ctx, input }) => {
      const { syncLog } = await import("dofek/db/schema");
      const { desc, eq } = await import("drizzle-orm");

      return ctx.db
        .select()
        .from(syncLog)
        .where(eq(syncLog.userId, ctx.userId))
        .orderBy(desc(syncLog.syncedAt))
        .limit(input.limit);
    }),

  /** Get recent system logs (console output) */
  systemLogs: protectedProcedure.input(systemLogsInput).query(({ input }) => {
    return getSystemLogs(input.limit);
  }),

  /** Per-provider record counts broken down by table */
  providerStats: cachedProtectedQuery(CacheTTL.SHORT).query(async ({ ctx }) => {
    const rows = await ctx.db.execute<{
      provider_id: string;
      activities: string;
      daily_metrics: string;
      sleep_sessions: string;
      body_measurements: string;
      food_entries: string;
      health_events: string;
      metric_stream: string;
      nutrition_daily: string;
      lab_results: string;
      journal_entries: string;
    }>(sql`
      SELECT
        p.id AS provider_id,
        COALESCE(a.cnt, 0)::text AS activities,
        COALESCE(dm.cnt, 0)::text AS daily_metrics,
        COALESCE(ss.cnt, 0)::text AS sleep_sessions,
        COALESCE(bm.cnt, 0)::text AS body_measurements,
        COALESCE(fe.cnt, 0)::text AS food_entries,
        COALESCE(he.cnt, 0)::text AS health_events,
        COALESCE(ms.cnt, 0)::text AS metric_stream,
        COALESCE(nd.cnt, 0)::text AS nutrition_daily,
        COALESCE(lr.cnt, 0)::text AS lab_results,
        COALESCE(je.cnt, 0)::text AS journal_entries
      FROM fitness.provider p
      LEFT JOIN (SELECT provider_id, count(*) AS cnt FROM fitness.activity WHERE user_id = ${ctx.userId} GROUP BY provider_id) a ON a.provider_id = p.id
      LEFT JOIN (SELECT provider_id, count(*) AS cnt FROM fitness.daily_metrics WHERE user_id = ${ctx.userId} GROUP BY provider_id) dm ON dm.provider_id = p.id
      LEFT JOIN (SELECT provider_id, count(*) AS cnt FROM fitness.sleep_session WHERE user_id = ${ctx.userId} GROUP BY provider_id) ss ON ss.provider_id = p.id
      LEFT JOIN (SELECT provider_id, count(*) AS cnt FROM fitness.body_measurement WHERE user_id = ${ctx.userId} GROUP BY provider_id) bm ON bm.provider_id = p.id
      LEFT JOIN (SELECT provider_id, count(*) AS cnt FROM fitness.food_entry WHERE user_id = ${ctx.userId} AND confirmed = true GROUP BY provider_id) fe ON fe.provider_id = p.id
      LEFT JOIN (SELECT provider_id, count(*) AS cnt FROM fitness.health_event WHERE user_id = ${ctx.userId} GROUP BY provider_id) he ON he.provider_id = p.id
      LEFT JOIN (SELECT provider_id, count(*) AS cnt FROM fitness.metric_stream WHERE user_id = ${ctx.userId} GROUP BY provider_id) ms ON ms.provider_id = p.id
      LEFT JOIN (SELECT provider_id, count(*) AS cnt FROM fitness.nutrition_daily WHERE user_id = ${ctx.userId} GROUP BY provider_id) nd ON nd.provider_id = p.id
      LEFT JOIN (SELECT provider_id, count(*) AS cnt FROM fitness.lab_result WHERE user_id = ${ctx.userId} GROUP BY provider_id) lr ON lr.provider_id = p.id
      LEFT JOIN (SELECT provider_id, count(*) AS cnt FROM fitness.journal_entry WHERE user_id = ${ctx.userId} GROUP BY provider_id) je ON je.provider_id = p.id
      ORDER BY p.id
    `);
    return mapProviderStats(rows);
  }),
});

function mapProviderStats(
  rows: Array<{
    provider_id: string;
    activities: string;
    daily_metrics: string;
    sleep_sessions: string;
    body_measurements: string;
    food_entries: string;
    health_events: string;
    metric_stream: string;
    nutrition_daily: string;
    lab_results: string;
    journal_entries: string;
  }>,
) {
  return rows.map((r) => ({
    providerId: r.provider_id,
    activities: Number(r.activities),
    dailyMetrics: Number(r.daily_metrics),
    sleepSessions: Number(r.sleep_sessions),
    bodyMeasurements: Number(r.body_measurements),
    foodEntries: Number(r.food_entries),
    healthEvents: Number(r.health_events),
    metricStream: Number(r.metric_stream),
    nutritionDaily: Number(r.nutrition_daily),
    labResults: Number(r.lab_results),
    journalEntries: Number(r.journal_entries),
  }));
}
