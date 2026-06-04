import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import * as Sentry from "@sentry/node";
import type { SyncDatabase } from "../db/index.ts";
import { logSync } from "../db/sync-log.ts";
import { runWithTokenUser } from "../db/token-user-context.ts";
import { ensureProvider, loadTokens } from "../db/tokens.ts";
import { isRetryableInfraError } from "../lib/retryable-infra-error.ts";
import { logger } from "../logger.ts";
import {
  authFailureReasonFromError,
  type ProviderAuthFailureReason,
} from "../providers/auth-errors.ts";
import type { SyncCheckpointStore, SyncError } from "../providers/types.ts";
import {
  syncDuration,
  syncErrorsTotal,
  syncOperationsTotal,
  syncRecordsTotal,
} from "../sync-metrics.ts";
import {
  providerRateLimitCooldownJobId,
  providerRateLimitCooldownStore,
  providerRateLimitDelayMs,
} from "./provider-rate-limit-cooldown.ts";
import type { SyncJobData } from "./queues.ts";
import { getProviderSyncQueue, SYNC_JOB_RETRY_OPTIONS } from "./queues.ts";

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
  updateData: (data: SyncJobData) => Promise<void>;
}

function resolveSince(data: SyncJobData): Date {
  if (data.sinceIso) {
    const since = new Date(data.sinceIso);
    if (Number.isNaN(since.getTime())) {
      throw new Error(`Invalid sync job sinceIso: ${data.sinceIso}`);
    }
    return since;
  }
  return data.sinceDays ? new Date(Date.now() - data.sinceDays * 24 * 60 * 60 * 1000) : new Date(0);
}

function createCheckpointStore(job: SyncJob): SyncCheckpointStore {
  return {
    load: async () => job.data.checkpoint ?? null,
    save: async (checkpoint: unknown) => {
      const nextData = { ...job.data, checkpoint };
      await job.updateData(nextData);
      job.data = nextData;
    },
    clear: async () => {
      const { checkpoint: _checkpoint, ...nextData } = job.data;
      await job.updateData(nextData);
      job.data = nextData;
    },
  };
}

function firstRetryableInfraSyncError(errors: SyncError[]): SyncError | null {
  return (
    errors.find((syncError) => isRetryableInfraError(syncError.cause ?? syncError.message)) ?? null
  );
}

function firstProviderRateLimitError(errors: SyncError[]): ProviderRateLimitError | null {
  const rateLimitSyncError = errors.find(
    (syncError) => syncError.cause instanceof ProviderRateLimitError,
  );
  return rateLimitSyncError?.cause instanceof ProviderRateLimitError
    ? rateLimitSyncError.cause
    : null;
}

function firstAuthFailureReason(errors: SyncError[]): ProviderAuthFailureReason | undefined {
  return errors
    .map((syncError) => authFailureReasonFromError(syncError.cause))
    .find((authFailureReason) => authFailureReason !== undefined);
}

async function scheduleRateLimitRetry(
  job: SyncJob,
  error: ProviderRateLimitError,
  since: Date,
): Promise<string> {
  const cooldown = await providerRateLimitCooldownStore.record(error, job.data.userId);
  const delay = providerRateLimitDelayMs(cooldown);
  const nextData: SyncJobData = {
    ...job.data,
    providerId: error.providerId,
    // Persist the concrete window resolved for this run so the delayed retry
    // syncs from the same point rather than recomputing a now-shifted sinceDays.
    sinceIso: since.toISOString(),
  };
  await getProviderSyncQueue(error.providerId).add("sync", nextData, {
    ...SYNC_JOB_RETRY_OPTIONS,
    delay,
    jobId: providerRateLimitCooldownJobId(cooldown, job.data.userId),
  });
  return cooldown.expiresAt.toISOString();
}

export async function processSyncJob(job: SyncJob, db: SyncDatabase): Promise<void> {
  const { providerId } = job.data;
  const since = resolveSince(job.data);

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

    const requiresTokens = provider.authSetup !== undefined;
    if (requiresTokens) {
      const tokens = await loadTokens(db, provider.id, job.data.userId);
      if (!tokens) {
        logger.info(`[worker] Skipping ${provider.name}: not connected`);
        completedCount++;
        providerStatus[provider.id] = { status: "done", message: "Skipped — not connected" };
        await job.updateProgress({
          providers: providerStatus,
          percentage: computePercentage(completedCount, 0, totalProviders),
        });
        continue;
      }
    }

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
          checkpoint: createCheckpointStore(job),
        }),
      );
      const rateLimitError = firstProviderRateLimitError(result.errors);
      if (rateLimitError) {
        throw rateLimitError;
      }
      const retryableInfraError = firstRetryableInfraSyncError(result.errors);
      if (retryableInfraError) {
        throw retryableInfraError.cause instanceof Error
          ? retryableInfraError.cause
          : new Error(retryableInfraError.message);
      }
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
          if (!authFailureReasonFromError(err.cause)) {
            Sentry.captureException(err.cause ?? new Error(err.message), {
              tags: { provider: provider.id },
            });
          }
        }
      }

      const durationMs = Date.now() - syncStart;
      await logSync(db, {
        providerId: provider.id,
        dataType: "sync",
        status: hasErrors ? "error" : "success",
        recordCount: result.recordsSynced,
        errorMessage: hasErrors ? result.errors.map((e) => e.message).join("; ") : undefined,
        authFailureReason: firstAuthFailureReason(result.errors),
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
      if (err instanceof ProviderRateLimitError) {
        const retryAt = await scheduleRateLimitRetry(job, err, since);
        const message = `Rate limited; retry scheduled for ${retryAt}`;
        completedCount++;
        providerStatus[provider.id] = { status: "running", message };
        await job.updateProgress({
          providers: providerStatus,
          percentage: computePercentage(completedCount, 0, totalProviders),
        });
        logger.warn(`[worker] ${provider.name} rate limited; retry scheduled for ${retryAt}`);

        const durationMs = Date.now() - syncStart;
        await logSync(db, {
          providerId: provider.id,
          dataType: "sync",
          status: "error",
          errorMessage: err.message,
          durationMs,
          userId: job.data.userId,
        });

        syncOperationsTotal.add(1, { provider: provider.id, data_type: "sync", status: "error" });
        syncDuration.record(durationMs, { provider: provider.id, data_type: "sync" });
        syncErrorsTotal.add(1, { provider: provider.id, data_type: "sync" });
        continue;
      }

      if (isRetryableInfraError(err)) {
        const message = err instanceof Error ? err.message : String(err);
        Sentry.captureException(err, { tags: { provider: provider.id, retryable: "true" } });
        providerStatus[provider.id] = {
          status: "running",
          message: "Infrastructure unavailable; retrying",
        };
        await job.updateProgress({
          providers: providerStatus,
          percentage: computePercentage(completedCount, 0, totalProviders),
        });
        logger.warn(`[worker] ${provider.name} infrastructure failure, retrying: ${message}`);
        throw err;
      }
      completedCount++;
      const message = err instanceof Error ? err.message : String(err);
      const authFailureReason = authFailureReasonFromError(err);
      if (!authFailureReason) {
        Sentry.captureException(err, { tags: { provider: provider.id } });
      }
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
        authFailureReason,
        durationMs,
        userId: job.data.userId,
      });

      syncOperationsTotal.add(1, { provider: provider.id, data_type: "sync", status: "error" });
      syncDuration.record(durationMs, { provider: provider.id, data_type: "sync" });
      syncErrorsTotal.add(1, { provider: provider.id, data_type: "sync" });
    }
  }

  try {
    const { enqueueDebouncedPostSyncMaintenance } = await import("./queues.ts");
    await enqueueDebouncedPostSyncMaintenance();
  } catch (err) {
    logger.error(`[worker] Failed to enqueue global post-sync maintenance: ${err}`);
    Sentry.captureException(err, { tags: { phase: "post-sync-global-maintenance-enqueue" } });
  }

  try {
    const { enqueueDebouncedUserRefit } = await import("./queues.ts");
    await enqueueDebouncedUserRefit(job.data.userId);
  } catch (err) {
    logger.error(`[worker] Failed to enqueue user refit: ${err}`);
    Sentry.captureException(err, { tags: { phase: "post-sync-user-refit-enqueue" } });
  }
}
