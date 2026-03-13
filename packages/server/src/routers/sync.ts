import { logSync } from "dofek/db/sync-log";
import { ensureProvider } from "dofek/db/tokens";
import { getAllProviders, registerProvider } from "dofek/providers/registry";
import type { Provider } from "dofek/providers/types";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { queryCache } from "../lib/cache.ts";
import { getSystemLogs, logger } from "../logger.ts";
import { CacheTTL, cachedProtectedQuery, protectedProcedure, router } from "../trpc.ts";

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
    ["hevy", () => import("dofek/providers/hevy").then((m) => new m.HevyProvider())],
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
    [
      "cronometer-csv",
      () => import("dofek/providers/cronometer-csv").then((m) => new m.CronometerCsvProvider()),
    ],
  ] as const;

  for (const [name, loadProvider] of providers) {
    try {
      registerProvider(await loadProvider());
    } catch (err) {
      logger.warn(`[sync] Failed to register ${name} provider: ${err}`);
    }
  }
}

// ── Background sync job tracking ──
export interface SyncJob {
  status: "running" | "done" | "error";
  providers: Record<string, { status: "pending" | "running" | "done" | "error"; message?: string }>;
  message?: string;
  result?: unknown;
}

const syncJobs = new Map<string, SyncJob>();

function cleanupJob(jobId: string) {
  setTimeout(() => syncJobs.delete(jobId), 10 * 60 * 1000);
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
      const needsCustomAuth = p.id === "whoop" || p.id === "ride-with-gps";
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

  /** Trigger sync — returns immediately with a jobId, processes in the background */
  triggerSync: protectedProcedure
    .input(
      z.object({
        providerId: z.string().optional(),
        sinceDays: z.number().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await ensureProvidersRegistered();
      const since = input.sinceDays
        ? new Date(Date.now() - input.sinceDays * 24 * 60 * 60 * 1000)
        : new Date(0); // full sync

      let providers: Provider[];
      if (input.providerId) {
        const provider = getAllProviders().find((p) => p.id === input.providerId);
        if (!provider) throw new Error(`Unknown provider: ${input.providerId}`);
        const validation = provider.validate();
        if (validation) throw new Error(`Provider not configured: ${validation}`);
        providers = [provider];
      } else {
        providers = getAllProviders().filter((p) => p.validate() === null);
      }

      const jobId = `sync-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      const providerStatuses: SyncJob["providers"] = {};
      for (const p of providers) {
        providerStatuses[p.id] = { status: "pending" };
      }
      syncJobs.set(jobId, { status: "running", providers: providerStatuses });

      // Fire and forget — .catch ensures no unhandled rejections
      (async () => {
        try {
          for (const provider of providers) {
            const job = syncJobs.get(jobId);
            if (!job) break;
            job.providers[provider.id] = { status: "running" };

            await ensureProvider(ctx.db, provider.id, provider.name);

            const syncStart = Date.now();
            try {
              logger.info(`[sync] Starting ${provider.name}...`);
              const result = await provider.sync(ctx.db, since);
              const hasErrors = result.errors.length > 0;
              const parts = [`${result.recordsSynced} synced`];
              if (hasErrors) parts.push(`${result.errors.length} errors`);
              job.providers[provider.id] = {
                status: hasErrors ? "error" : "done",
                message: parts.join(", "),
              };
              await logSync(ctx.db, {
                providerId: provider.id,
                dataType: "sync",
                status: hasErrors ? "error" : "success",
                recordCount: result.recordsSynced,
                errorMessage: hasErrors
                  ? result.errors.map((e) => e.message).join("; ")
                  : undefined,
                durationMs: Date.now() - syncStart,
              });
            } catch (err: unknown) {
              const message = err instanceof Error ? err.message : String(err);
              job.providers[provider.id] = {
                status: "error",
                message,
              };
              await logSync(ctx.db, {
                providerId: provider.id,
                dataType: "sync",
                status: "error",
                errorMessage: message,
                durationMs: Date.now() - syncStart,
              });
            }
          }

          // Update user max HR from newly synced data
          try {
            const { updateUserMaxHr } = await import("dofek/db/dedup");
            await updateUserMaxHr(ctx.db);
          } catch (err) {
            logger.error(`[sync] Failed to update max HR: ${err}`);
          }

          // Refresh dedup + rollup views
          try {
            const { refreshDedupViews } = await import("dofek/db/dedup");
            await refreshDedupViews(ctx.db);
          } catch (err) {
            logger.error(`[sync] Failed to refresh views: ${err}`);
          }

          // Invalidate all server-side caches
          await queryCache.invalidateAll();

          // Run anomaly detection and send Slack alerts if needed
          try {
            const { checkAnomalies, sendAnomalyAlertToSlack } = await import(
              "./anomaly-detection.ts"
            );
            const anomalyResult = await checkAnomalies(ctx.db, ctx.userId);
            if (anomalyResult.anomalies.length > 0) {
              logger.info(
                `[sync] Detected ${anomalyResult.anomalies.length} anomaly(ies), sending alert`,
              );
              await sendAnomalyAlertToSlack(ctx.db, ctx.userId, anomalyResult.anomalies);
            }
          } catch (err) {
            logger.error(`[sync] Anomaly detection failed: ${err}`);
          }

          const job = syncJobs.get(jobId);
          if (!job) return;
          job.status = "done";
          job.message = "Sync complete";
          cleanupJob(jobId);
        } catch (err: unknown) {
          const job = syncJobs.get(jobId);
          if (job) {
            job.status = "error";
            job.message = err instanceof Error ? err.message : String(err);
            cleanupJob(jobId);
          }
        }
      })().catch((err) => logger.error(`[sync] Unhandled sync error: ${err}`));

      return { jobId };
    }),

  /** Poll sync job status */
  syncStatus: protectedProcedure.input(z.object({ jobId: z.string() })).query(({ input }) => {
    const job = syncJobs.get(input.jobId);
    if (!job) return null;
    return job;
  }),

  /** Get sync log history */
  logs: cachedProtectedQuery(CacheTTL.SHORT)
    .input(z.object({ limit: z.number().default(100) }))
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
  systemLogs: protectedProcedure
    .input(z.object({ limit: z.number().default(200) }))
    .query(({ input }) => {
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
      LEFT JOIN (SELECT provider_id, count(*) AS cnt FROM fitness.food_entry WHERE user_id = ${ctx.userId} GROUP BY provider_id) fe ON fe.provider_id = p.id
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
