import type { SyncDatabase } from "../db/index.ts";
import { logSync } from "../db/sync-log.ts";
import { ensureProvider } from "../db/tokens.ts";
import { logger } from "../logger.ts";
import type { SyncJobData } from "./queues.ts";

/**
 * Compute overall job percentage from completed providers + within-provider progress.
 * Each provider gets an equal slice of the total (e.g., 3 providers = 33% each).
 * Within-provider progress subdivides that slice.
 */
function computePercentage(
  completedProviders: number,
  withinProviderPct: number,
  totalProviders: number,
): number {
  if (totalProviders === 0) return 100;
  const perProvider = 100 / totalProviders;
  return Math.round(completedProviders * perProvider + (withinProviderPct / 100) * perProvider);
}

/** Minimal Job interface — only the subset processSyncJob actually uses. */
interface SyncJob {
  data: SyncJobData;
  updateProgress: (data: object) => Promise<void>;
}

export async function processSyncJob(job: SyncJob, db: SyncDatabase): Promise<void> {
  const { providerId, sinceDays } = job.data;
  const since = sinceDays ? new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000) : new Date(0);

  // Lazy-import provider registration
  const { ensureProvidersRegistered } = await import("./provider-registration.ts");
  await ensureProvidersRegistered();

  const { getAllProviders } = await import("../providers/index.ts");

  let providers = getAllProviders().filter((p) => p.validate() === null);
  if (providerId) {
    const specific = providers.find((p) => p.id === providerId);
    if (!specific) throw new Error(`Unknown provider: ${providerId}`);
    providers = [specific];
  }

  const providerStatus: Record<string, { status: string; message?: string }> = {};
  for (const p of providers) {
    providerStatus[p.id] = { status: "pending" };
  }
  await job.updateProgress({ providers: providerStatus, percentage: 0 });

  let completedCount = 0;
  const totalProviders = providers.length;

  for (const provider of providers) {
    providerStatus[provider.id] = { status: "running" };
    await job.updateProgress({
      providers: providerStatus,
      percentage: computePercentage(completedCount, 0, totalProviders),
    });

    await ensureProvider(db, provider.id, provider.name);
    const syncStart = Date.now();

    try {
      logger.info(`[worker] Starting ${provider.name}...`);
      const result = await provider.sync(db, since, (percentage, message) => {
        providerStatus[provider.id] = { status: "running", message };
        job.updateProgress({
          providers: providerStatus,
          percentage: computePercentage(completedCount, percentage, totalProviders),
        });
      });
      completedCount++;
      const hasErrors = result.errors.length > 0;
      const parts = [`${result.recordsSynced} synced`];
      if (hasErrors) parts.push(`${result.errors.length} errors`);

      providerStatus[provider.id] = {
        status: hasErrors ? "error" : "done",
        message: parts.join(", "),
      };
      await job.updateProgress({
        providers: providerStatus,
        percentage: computePercentage(completedCount, 0, totalProviders),
      });

      if (hasErrors) {
        for (const err of result.errors) {
          logger.error(`[worker] ${provider.name} sync error: ${err.message}`);
        }
      }

      await logSync(db, {
        providerId: provider.id,
        dataType: "sync",
        status: hasErrors ? "error" : "success",
        recordCount: result.recordsSynced,
        errorMessage: hasErrors ? result.errors.map((e) => e.message).join("; ") : undefined,
        durationMs: Date.now() - syncStart,
      });
    } catch (err: unknown) {
      completedCount++;
      const message = err instanceof Error ? err.message : String(err);
      providerStatus[provider.id] = { status: "error", message };
      await job.updateProgress({
        providers: providerStatus,
        percentage: computePercentage(completedCount, 0, totalProviders),
      });

      await logSync(db, {
        providerId: provider.id,
        dataType: "sync",
        status: "error",
        errorMessage: message,
        durationMs: Date.now() - syncStart,
      });
    }
  }

  // Post-sync: update max HR + refresh views
  try {
    const { updateUserMaxHr } = await import("../db/dedup.ts");
    await updateUserMaxHr(db);
  } catch (err) {
    logger.error(`[worker] Failed to update max HR: ${err}`);
  }

  try {
    const { loadProviderPriorityConfig, syncProviderPriorities } = await import(
      "../db/provider-priority.ts"
    );
    const config = loadProviderPriorityConfig();
    if (config) {
      await syncProviderPriorities(db, config);
    }
  } catch (err) {
    logger.error(`[worker] Failed to sync provider priorities: ${err}`);
  }

  try {
    const { refreshDedupViews } = await import("../db/dedup.ts");
    await refreshDedupViews(db);
  } catch (err) {
    logger.error(`[worker] Failed to refresh views: ${err}`);
  }

  // Refit personalized algorithm parameters from updated data
  try {
    const { refitAllParams } = await import("../personalization/refit.ts");
    logger.info("[worker] Refitting personalized parameters...");
    await refitAllParams(db, job.data.userId);
    logger.info("[worker] Personalized parameters updated.");
  } catch (err) {
    logger.error(`[worker] Failed to refit parameters: ${err}`);
  }
}
