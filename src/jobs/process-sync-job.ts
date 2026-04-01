import * as Sentry from "@sentry/node";
import type { SyncDatabase } from "../db/index.ts";
import { logSync } from "../db/sync-log.ts";
import { runWithTokenUser } from "../db/token-user-context.ts";
import { ensureProvider } from "../db/tokens.ts";
import { logger } from "../logger.ts";
import {
  syncDuration,
  syncErrorsTotal,
  syncOperationsTotal,
  syncRecordsTotal,
} from "../sync-metrics.ts";
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

  const { getEnabledSyncProviders, getProvider, isSyncEligibleProvider } = await import(
    "../providers/index.ts"
  );

  let providers = getEnabledSyncProviders();
  if (providerId) {
    const registeredProvider = getProvider(providerId);
    if (registeredProvider && !isSyncEligibleProvider(registeredProvider)) {
      logger.info(`[worker] Skipping non-sync provider in sync queue: ${providerId}`);
      await job.updateProgress({
        providers: { [providerId]: { status: "done", message: "Skipped file-import provider" } },
        percentage: 100,
      });
      return;
    }
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

    await ensureProvider(db, provider.id, provider.name, undefined, job.data.userId);
    const syncStart = Date.now();

    try {
      logger.info(`[worker] Starting ${provider.name}...`);
      const result = await runWithTokenUser(job.data.userId, () =>
        provider.sync(db, since, {
          onProgress: (percentage, message) => {
            providerStatus[provider.id] = { status: "running", message };
            job.updateProgress({
              providers: providerStatus,
              percentage: computePercentage(completedCount, percentage, totalProviders),
            });
          },
          userId: job.data.userId,
        }),
      );
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
          Sentry.captureException(err.cause ?? new Error(err.message), {
            tags: { provider: provider.id },
          });
        }
      }

      const durationMs = Date.now() - syncStart;
      await logSync(db, {
        providerId: provider.id,
        dataType: "sync",
        status: hasErrors ? "error" : "success",
        recordCount: result.recordsSynced,
        errorMessage: hasErrors ? result.errors.map((e) => e.message).join("; ") : undefined,
        durationMs,
        userId: job.data.userId,
      });

      const status = hasErrors ? "error" : "success";
      syncRecordsTotal.add(result.recordsSynced, {
        provider: provider.id,
        data_type: "sync",
        status,
      });
      syncOperationsTotal.add(1, { provider: provider.id, data_type: "sync", status });
      syncDuration.record(durationMs, { provider: provider.id, data_type: "sync" });
      if (hasErrors) {
        syncErrorsTotal.add(result.errors.length, { provider: provider.id, data_type: "sync" });
      }
    } catch (err: unknown) {
      completedCount++;
      const message = err instanceof Error ? err.message : String(err);
      Sentry.captureException(err, { tags: { provider: provider.id } });
      providerStatus[provider.id] = { status: "error", message };
      await job.updateProgress({
        providers: providerStatus,
        percentage: computePercentage(completedCount, 0, totalProviders),
      });

      const durationMs = Date.now() - syncStart;
      await logSync(db, {
        providerId: provider.id,
        dataType: "sync",
        status: "error",
        errorMessage: message,
        durationMs,
        userId: job.data.userId,
      });

      syncOperationsTotal.add(1, { provider: provider.id, data_type: "sync", status: "error" });
      syncDuration.record(durationMs, { provider: provider.id, data_type: "sync" });
      syncErrorsTotal.add(1, { provider: provider.id, data_type: "sync" });
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
