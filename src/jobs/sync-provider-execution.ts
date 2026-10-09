import { withAccountErasureUserWriteFence } from "../db/account-erasure.ts";
import { loadUserHomeTimezone } from "../db/home-timezone.ts";
import { runWithProviderUserIngestContext } from "../db/provider-ingest-context.ts";
import { logSync } from "../db/sync-log.ts";
import { ensureProvider, loadTokens } from "../db/tokens.ts";
import { invalidateAllUserQueries } from "../lib/cache.ts";
import { providerRequiresStoredTokens } from "../lib/custom-auth-providers.ts";
import { captureException } from "../lib/error-reporting.ts";
import { logger } from "../logger.ts";
import { isWebhookProvider, type SyncProvider } from "../providers/types.ts";
import {
  syncDuration,
  syncErrorsTotal,
  syncOperationsTotal,
  syncRecordsTotal,
} from "../sync-metrics.ts";
import { accountErasureAllowsQueuedUserWork } from "./account-erasure-work-guard.ts";
import { scheduleDelayedSyncJob } from "./enqueue-sync-job.ts";
import { providerRateLimitCooldownStore } from "./provider-rate-limit-cooldown.ts";
import type { SyncJobContext } from "./sync-job-context.ts";
import {
  requireTransactionalSyncDatabase,
  SyncProcessingOperation,
} from "./sync-processing-operation.ts";
import {
  firstAuthFailureReason,
  handleSyncProviderFailure,
  providerSyncFailureEvent,
  shouldReportProviderError,
  throwRetryableSyncResultError,
} from "./sync-provider-failure.ts";

/** Executes a provider attempt; false stops the shared job after its write guard closes. */
export async function executeSyncProvider(
  context: SyncJobContext,
  provider: SyncProvider,
): Promise<boolean> {
  const { job, db, signal } = context;
  const { since, until } = context.syncWindow;
  signal?.throwIfAborted();
  context.providerStatus[provider.id] = { status: "running" };
  await job.updateProgress({
    providers: context.providerStatus,
    percentage: context.percentage(0),
  });

  const requiresTokens = providerRequiresStoredTokens(provider);
  if (requiresTokens) {
    const tokens = await loadTokens(db, provider.id, job.data.userId);
    if (!tokens) {
      logger.info(`[worker] Skipping ${provider.name}: not connected`);
      context.completedCount++;
      context.providerStatus[provider.id] = { status: "done", message: "Skipped — not connected" };
      await job.updateProgress({
        providers: context.providerStatus,
        percentage: context.percentage(0),
      });
      return true;
    }
  }

  await ensureProvider(db, provider.id, provider.name, undefined, job.data.userId);

  const activeCooldown = await providerRateLimitCooldownStore.getActive(
    provider.id,
    job.data.userId,
  );
  if (activeCooldown) {
    const retryAt = await withAccountErasureUserWriteFence(
      requireTransactionalSyncDatabase(db),
      job.data.userId,
      async () => {
        signal?.throwIfAborted();
        const scheduledRetryAt = await scheduleDelayedSyncJob(
          {
            ...job.data,
            providerId: provider.id,
            sinceIso: since.toISOString(),
            untilIso: until.toISOString(),
          },
          activeCooldown,
        );
        signal?.throwIfAborted();
        return scheduledRetryAt;
      },
    );
    signal?.throwIfAborted();
    context.completedCount++;
    context.providerStatus[provider.id] = {
      status: "running",
      message: `Rate limited; retry scheduled for ${retryAt}`,
    };
    await job.updateProgress({
      providers: context.providerStatus,
      percentage: context.percentage(0),
    });
    logger.info(
      `[worker] ${provider.name} sync deferred until rate-limit cooldown expires at ${retryAt}`,
    );
    return true;
  }

  const processingOperation = await SyncProcessingOperation.start(job, db, provider);
  const syncStart = Date.now();

  try {
    if (!(await accountErasureAllowsQueuedUserWork(db, job.data.userId, `${provider.name} sync`))) {
      return false;
    }
    logger.info(`[worker] Starting ${provider.name}...`);
    const homeTimezone = await loadUserHomeTimezone(db, job.data.userId);
    const result = await runWithProviderUserIngestContext(
      job.data.userId,
      { homeTimezone },
      async () => {
        const event = job.data.webhookEvent;
        if (event && isWebhookProvider(provider) && provider.syncWebhookEvent) {
          try {
            return await provider.syncWebhookEvent(db, event, {
              userId: job.data.userId,
              metricStreamPublisher: processingOperation.metricStreamPublisher,
            });
          } catch (error) {
            captureException(error, {
              tags: { provider: provider.id, webhookPhase: "targeted-sync" },
            });
            logger.warn(
              `[worker] ${provider.name} targeted webhook sync failed; running full sync: ${error}`,
            );
          }
        }
        return provider.sync(
          context.createRun(provider, processingOperation.metricStreamPublisher),
        );
      },
    );
    if (result.recordsSynced > 0) {
      if (
        !(await accountErasureAllowsQueuedUserWork(db, job.data.userId, "sync cache invalidation"))
      ) {
        return false;
      }
      await invalidateAllUserQueries(job.data.userId);
    }
    if (result.continued) {
      context.syncRunContinued = true;
      context.providerStatus[provider.id] = {
        status: "running",
        message: `${result.recordsSynced} synced so far`,
      };
      await job.updateProgress({
        providers: context.providerStatus,
        percentage: context.percentage(50),
      });
      return true;
    }
    throwRetryableSyncResultError(result.errors);
    const authFailureReason = firstAuthFailureReason(result.errors);
    const failureEvent = providerSyncFailureEvent(provider.name, authFailureReason);
    context.completedCount++;
    const hasErrors = result.errors.length > 0;
    await processingOperation.recordOutputs(result.recordsSynced);
    const parts = [`${result.recordsSynced} synced`];
    if (hasErrors) parts.push(`${result.errors.length} errors`);

    context.providerStatus[provider.id] = {
      status: hasErrors ? "error" : "done",
      message: parts.join(", "),
    };
    await job.updateProgress({
      providers: context.providerStatus,
      percentage: context.percentage(0),
    });

    if (hasErrors) {
      for (const err of result.errors) {
        logger.error(`[worker] ${provider.name} sync error: ${err.message}`);
        const reportableError = err.cause ?? new Error(err.message);
        if (shouldReportProviderError(reportableError)) {
          captureException(reportableError, {
            tags: { provider: provider.id },
            ...(err.context ? { extra: err.context } : {}),
          });
        }
      }
    }

    await processingOperation.finish(hasErrors ? failureEvent : undefined);

    const durationMs = Date.now() - syncStart;
    await logSync(db, {
      providerId: provider.id,
      dataType: "sync",
      status: hasErrors ? "error" : "success",
      recordCount: result.recordsSynced,
      errorMessage: hasErrors ? result.errors.map((e) => e.message).join("; ") : undefined,
      authFailureReason,
      durationMs,
      userId: job.data.userId,
      origin: job.data.origin ?? "unknown",
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
    await handleSyncProviderFailure(context, provider, processingOperation, syncStart, err);
  }
  return true;
}
