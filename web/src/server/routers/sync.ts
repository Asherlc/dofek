import { logSync } from "dofek/db/sync-log";
import { getAllProviders, registerProvider } from "dofek/providers/registry";
import type { Provider } from "dofek/providers/types";
import { z } from "zod";
import { publicProcedure, router } from "../../shared/trpc.js";

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
        // Only OAuth-redirect providers need browser auth — automatedLogin and
        // credential-only providers handle auth internally during sync
        const needsOAuth = !!setup?.oauthConfig && !setup.automatedLogin;
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

            const syncStart = Date.now();
            try {
              console.log(`[sync] Starting ${provider.name}...`);
              const result = await provider.sync(ctx.db, since);
              const hasErrors = result.errors.length > 0;
              job.providers[provider.id] = {
                status: hasErrors ? "error" : "done",
                message: `${result.recordsSynced} records, ${result.errors.length} errors`,
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
});
