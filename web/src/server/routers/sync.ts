import type { Database } from "dofek/db";
import { logSync } from "dofek/db/sync-log";
import { ensureProvider } from "dofek/db/tokens";
import { getAllProviders, registerProvider } from "dofek/providers/registry";
import type { Provider } from "dofek/providers/types";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { publicProcedure, router } from "../../shared/trpc.ts";

/** Count total records across main tables for a provider (excludes metric_stream for speed). */
async function countProviderRecords(db: Database, providerId: string): Promise<number> {
  const result = await db.execute<{ total: string }>(sql`
    SELECT
      (SELECT count(*) FROM fitness.activity WHERE provider_id = ${providerId}) +
      (SELECT count(*) FROM fitness.daily_metrics WHERE provider_id = ${providerId}) +
      (SELECT count(*) FROM fitness.sleep_session WHERE provider_id = ${providerId}) +
      (SELECT count(*) FROM fitness.body_measurement WHERE provider_id = ${providerId}) +
      (SELECT count(*) FROM fitness.food_entry WHERE provider_id = ${providerId}) +
      (SELECT count(*) FROM fitness.health_event WHERE provider_id = ${providerId})
    AS total
  `);
  return Number(result[0]?.total ?? 0);
}

// Register providers on first import
let providersRegistered = false;

export async function ensureProvidersRegistered() {
  if (providersRegistered) return;
  providersRegistered = true;

  // Dynamically import providers — they self-validate via env vars
  try {
    const { WahooProvider } = await import("dofek/providers/wahoo");
    registerProvider(new WahooProvider());
  } catch {}
  try {
    const { WithingsProvider } = await import("dofek/providers/withings");
    registerProvider(new WithingsProvider());
  } catch {}
  try {
    const { PelotonProvider } = await import("dofek/providers/peloton");
    registerProvider(new PelotonProvider());
  } catch {}
  try {
    const { FatSecretProvider } = await import("dofek/providers/fatsecret");
    registerProvider(new FatSecretProvider());
  } catch {}
  try {
    const { WhoopProvider } = await import("dofek/providers/whoop");
    registerProvider(new WhoopProvider());
  } catch {}
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
  providers: publicProcedure.query(async ({ ctx }) => {
    await ensureProvidersRegistered();
    const all = getAllProviders();
    const { loadTokens } = await import("dofek/db/tokens");
    const { syncLog } = await import("dofek/db/schema");
    const { desc, eq } = await import("drizzle-orm");

    return Promise.all(
      all.map(async (p) => {
        const setup = p.authSetup?.();
        // Providers with oauthConfig need auth (browser redirect or automatedLogin).
        // Credential-only providers (e.g. WHOOP) have no authSetup and auth inline.
        const needsOAuth = !!setup?.oauthConfig;
        let authorized = !needsOAuth;
        if (needsOAuth) {
          const tokens = await loadTokens(ctx.db, p.id);
          authorized = tokens !== null;
        }

        // Get last sync time
        const lastSyncRows = await ctx.db
          .select({ syncedAt: syncLog.syncedAt })
          .from(syncLog)
          .where(eq(syncLog.providerId, p.id))
          .orderBy(desc(syncLog.syncedAt))
          .limit(1);
        const lastSyncedAt = lastSyncRows[0]?.syncedAt?.toISOString() ?? null;

        return {
          id: p.id,
          name: p.name,
          enabled: p.validate() === null,
          error: p.validate(),
          needsOAuth,
          authorized,
          lastSyncedAt,
        };
      }),
    );
  }),

  /** Trigger sync — returns immediately with a jobId, processes in the background */
  triggerSync: publicProcedure
    .input(
      z.object({
        providerId: z.string().optional(),
        sinceDays: z.number().default(7),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await ensureProvidersRegistered();
      const since = new Date(Date.now() - input.sinceDays * 24 * 60 * 60 * 1000);

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

      // Fire and forget
      (async () => {
        try {
          // Sync providers sequentially so we can update per-provider status
          for (const provider of providers) {
            const job = syncJobs.get(jobId)!;
            job.providers[provider.id] = { status: "running" };

            // Ensure provider row exists before syncing (needed for sync_log FK)
            await ensureProvider(ctx.db, provider.id, provider.name);

            const syncStart = Date.now();
            const countBefore = await countProviderRecords(ctx.db, provider.id);
            try {
              console.log(`[sync] Starting ${provider.name}...`);
              const result = await provider.sync(ctx.db, since);
              const countAfter = await countProviderRecords(ctx.db, provider.id);
              const newRecords = countAfter - countBefore;
              const hasErrors = result.errors.length > 0;
              const parts = [];
              if (newRecords > 0) parts.push(`${newRecords} new`);
              parts.push(`${result.recordsSynced} synced`);
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
            } catch (err: any) {
              job.providers[provider.id] = {
                status: "error",
                message: err.message ?? "Sync failed",
              };
              await logSync(ctx.db, {
                providerId: provider.id,
                dataType: "sync",
                status: "error",
                errorMessage: err.message ?? "Sync failed",
                durationMs: Date.now() - syncStart,
              });
            }
          }

          // Refresh dedup views
          try {
            const { refreshDedupViews } = await import("dofek/db/dedup");
            await refreshDedupViews(ctx.db);
          } catch (err) {
            console.error("[sync] Failed to refresh dedup views:", err);
          }

          const job = syncJobs.get(jobId)!;
          job.status = "done";
          job.message = "Sync complete";
          cleanupJob(jobId);
        } catch (err: any) {
          const job = syncJobs.get(jobId);
          if (job) {
            job.status = "error";
            job.message = err.message ?? "Sync failed";
            cleanupJob(jobId);
          }
        }
      })();

      return { jobId };
    }),

  /** Poll sync job status */
  syncStatus: publicProcedure.input(z.object({ jobId: z.string() })).query(({ input }) => {
    const job = syncJobs.get(input.jobId);
    if (!job) return null;
    return job;
  }),

  /** Get sync log history */
  logs: publicProcedure
    .input(z.object({ limit: z.number().default(100) }))
    .query(async ({ ctx, input }) => {
      const { syncLog } = await import("dofek/db/schema");
      const { desc } = await import("drizzle-orm");

      return ctx.db.select().from(syncLog).orderBy(desc(syncLog.syncedAt)).limit(input.limit);
    }),
});
