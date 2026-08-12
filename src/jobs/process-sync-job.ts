import {
  ProviderRateLimitError,
  ProviderRequestTimeoutError,
  ProviderServiceUnavailableError,
} from "@dofek/provider-http/rate-limit";
import { withAccountErasureUserWriteFence } from "../db/account-erasure.ts";
import type { Database, SyncDatabase } from "../db/index.ts";
import { logSync } from "../db/sync-log.ts";
import { runWithTokenUser } from "../db/token-user-context.ts";
import { ensureProvider, loadTokens } from "../db/tokens.ts";
import { invalidateAllUserQueries } from "../lib/cache.ts";
import { providerRequiresStoredTokens } from "../lib/custom-auth-providers.ts";
import { captureException } from "../lib/error-reporting.ts";
import { isRetryableInfraError } from "../lib/retryable-infra-error.ts";
import { logger } from "../logger.ts";
import { currentMetricStreamWriteDatabase } from "../metric-stream/write-fence-context.ts";
import {
  type ProcessingDatasetKey,
  processingDatasetKeysForOutputPath,
  processingDatasetKeysForProvider,
} from "../processing/dataset-contracts.ts";
import {
  createLazyDefaultMetricStreamEventPublisher,
  MetricStreamProcessingPublisher,
} from "../processing/metric-stream-processing-publisher.ts";
import {
  appendProcessingStageEvent,
  createProcessingOperation,
  getProcessingOutputManifest,
  recordMetricStreamBatchPublished,
  recordMetricStreamBatchPublishedInTransaction,
  recordRelationalCanonicalCommits,
} from "../processing/processing-event-store.ts";
import {
  authFailureReasonFromError,
  type ProviderAuthFailureReason,
} from "../providers/auth-errors.ts";
import { SyncRun } from "../providers/sync-run.ts";
import type { SyncCheckpointStore, SyncError } from "../providers/types.ts";
import {
  syncDuration,
  syncErrorsTotal,
  syncOperationsTotal,
  syncRecordsTotal,
} from "../sync-metrics.ts";
import { accountErasureAllowsQueuedUserWork } from "./account-erasure-work-guard.ts";
import { enqueueSyncJob, scheduleDelayedSyncJob } from "./enqueue-sync-job.ts";
import { providerRateLimitCooldownStore } from "./provider-rate-limit-cooldown.ts";
import type { SyncJobData } from "./queues.ts";
import { syncWindowFromJobData } from "./sync-job-window.ts";

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
  id?: string;
  data: SyncJobData;
  updateProgress: (data: object) => Promise<void>;
  updateData: (data: SyncJobData) => Promise<void>;
}

async function ensureProcessingOperation(
  job: SyncJob,
  db: SyncDatabase,
  provider: { id: string; processingDatasetKeys?: readonly ProcessingDatasetKey[] },
) {
  const datasetKeys = processingDatasetKeysForProvider(provider.id, provider.processingDatasetKeys);
  const existingOperationId = job.data.processingOperationIds?.[provider.id];
  if (existingOperationId) {
    return { id: existingOperationId, datasetKeys };
  }

  const fallbackCorrelationKey = [
    job.data.userId,
    provider.id,
    job.data.sinceIso ?? `days:${job.data.sinceDays ?? "all"}`,
    job.data.untilIso ?? "open",
  ].join(":");
  const operation = await createProcessingOperation(db, {
    userId: job.data.userId,
    providerId: provider.id,
    kind: "provider_sync",
    externalCorrelationKey: `${job.id ?? fallbackCorrelationKey}:${provider.id}`,
    datasetKeys: [...datasetKeys],
  });
  const nextData = {
    ...job.data,
    processingOperationIds: {
      ...job.data.processingOperationIds,
      [provider.id]: operation.id,
    },
  };
  await job.updateData(nextData);
  job.data = nextData;
  return { id: operation.id, datasetKeys };
}

function hasTransaction(
  database: SyncDatabase,
): database is SyncDatabase & Pick<Database, "transaction"> {
  return "transaction" in database && typeof database.transaction === "function";
}

function requireTransactionalSyncDatabase(
  database: SyncDatabase,
): SyncDatabase & Pick<Database, "transaction"> {
  if (!hasTransaction(database)) {
    throw new Error("Processing metric-stream publication requires a transactional database");
  }
  return database;
}

async function recordNoOutputStageSkips(
  database: SyncDatabase,
  operationId: string,
  datasetKeys: readonly ProcessingDatasetKey[],
): Promise<void> {
  for (const datasetKey of datasetKeys) {
    for (const stage of ["analytics", "cache_refresh"] as const) {
      await appendProcessingStageEvent(database, {
        operationId,
        stage,
        status: "skipped",
        datasetKey,
        message: "No new data was emitted for this dataset",
        idempotencyKey: `no-output:${datasetKey}:${stage}`,
      });
    }
  }
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
    errors.find((syncError) => {
      const reportableError = syncError.cause ?? syncError.message;
      if (isProviderTransportError(reportableError)) {
        return false;
      }
      return isRetryableInfraError(reportableError);
    }) ?? null
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

function providerSyncFailureEvent(
  providerName: string,
  authFailureReason: ProviderAuthFailureReason | undefined,
): { errorCode: "provider_auth_failed" | "provider_sync_failed"; errorMessage: string } {
  if (authFailureReason) {
    return {
      errorCode: "provider_auth_failed",
      errorMessage: `${providerName} authorization needs attention. Reconnect ${providerName}, then try again.`,
    };
  }
  return {
    errorCode: "provider_sync_failed",
    errorMessage: `${providerName} could not be synced. Try the sync again later.`,
  };
}

function isProviderServiceUnavailableError(error: unknown): boolean {
  const visitedErrors = new Set<Error>();
  let currentError = error;

  while (currentError instanceof Error && !visitedErrors.has(currentError)) {
    if (currentError instanceof ProviderServiceUnavailableError) {
      return true;
    }

    visitedErrors.add(currentError);
    currentError = "cause" in currentError ? currentError.cause : undefined;
  }

  return false;
}

function isProviderRequestTimeoutError(error: unknown): boolean {
  const visitedErrors = new Set<Error>();
  let currentError = error;

  while (currentError instanceof Error && !visitedErrors.has(currentError)) {
    if (currentError instanceof ProviderRequestTimeoutError) {
      return true;
    }

    visitedErrors.add(currentError);
    currentError = "cause" in currentError ? currentError.cause : undefined;
  }

  return false;
}

function isProviderTransportError(error: unknown): boolean {
  return isProviderServiceUnavailableError(error) || isProviderRequestTimeoutError(error);
}

function shouldReportProviderError(error: unknown): boolean {
  return !isProviderTransportError(error) && !authFailureReasonFromError(error);
}

async function scheduleRateLimitRetry(
  db: SyncDatabase,
  job: SyncJob,
  error: ProviderRateLimitError,
  since: Date,
  until: Date,
): Promise<string> {
  const cooldown = await providerRateLimitCooldownStore.record(error, job.data.userId);
  return withAccountErasureUserWriteFence(
    requireTransactionalSyncDatabase(db),
    job.data.userId,
    async () =>
      scheduleDelayedSyncJob(
        {
          ...job.data,
          providerId: error.providerId,
          sinceIso: since.toISOString(),
          untilIso: until.toISOString(),
        },
        cooldown,
      ),
  );
}

export async function processSyncJob(job: SyncJob, db: SyncDatabase): Promise<void> {
  const { providerId } = job.data;
  const syncWindow = syncWindowFromJobData(job.data);
  const since = syncWindow.since;
  const until = syncWindow.until;

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
  let syncRunContinued = false;

  for (const provider of providers) {
    providerStatus[provider.id] = { status: "running" };
    await job.updateProgress({
      providers: providerStatus,
      percentage: computePercentage(completedCount, 0, totalProviders),
    });

    const requiresTokens = providerRequiresStoredTokens(provider);
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

    await ensureProvider(db, provider.id, provider.name, undefined, job.data.userId);

    const activeCooldown = await providerRateLimitCooldownStore.getActive(
      provider.id,
      job.data.userId,
    );
    if (activeCooldown) {
      const retryAt = await withAccountErasureUserWriteFence(
        requireTransactionalSyncDatabase(db),
        job.data.userId,
        async () =>
          scheduleDelayedSyncJob(
            {
              ...job.data,
              providerId: provider.id,
              sinceIso: since.toISOString(),
              untilIso: until.toISOString(),
            },
            activeCooldown,
          ),
      );
      completedCount++;
      providerStatus[provider.id] = {
        status: "running",
        message: `Rate limited; retry scheduled for ${retryAt}`,
      };
      await job.updateProgress({
        providers: providerStatus,
        percentage: computePercentage(completedCount, 0, totalProviders),
      });
      logger.info(
        `[worker] ${provider.name} sync deferred until rate-limit cooldown expires at ${retryAt}`,
      );
      continue;
    }

    const processingOperation = await ensureProcessingOperation(job, db, provider);
    await appendProcessingStageEvent(db, {
      operationId: processingOperation.id,
      stage: "ingest",
      status: "queued",
      progressPercentage: 0,
      idempotencyKey: "worker-queued",
    });
    await appendProcessingStageEvent(db, {
      operationId: processingOperation.id,
      stage: "ingest",
      status: "running",
      progressPercentage: 0,
      idempotencyKey: "worker-running",
    });
    const emittedMetricStreamDatasetKeys = processingDatasetKeysForOutputPath(
      processingOperation.datasetKeys,
      "metric_stream",
    );
    const metricStreamPublisher =
      emittedMetricStreamDatasetKeys.length > 0
        ? new MetricStreamProcessingPublisher(createLazyDefaultMetricStreamEventPublisher(), {
            operationId: processingOperation.id,
            datasetKeys: emittedMetricStreamDatasetKeys,
            recordPublishedBatch: (batch) => {
              const transaction = currentMetricStreamWriteDatabase();
              return transaction
                ? recordMetricStreamBatchPublishedInTransaction(transaction, batch)
                : recordMetricStreamBatchPublished(requireTransactionalSyncDatabase(db), batch);
            },
          })
        : undefined;

    const syncStart = Date.now();

    try {
      if (
        !(await accountErasureAllowsQueuedUserWork(db, job.data.userId, `${provider.name} sync`))
      ) {
        return;
      }
      logger.info(`[worker] Starting ${provider.name}...`);
      const result = await runWithTokenUser(job.data.userId, () =>
        provider.sync(
          new SyncRun({
            db,
            window: syncWindow,
            onProgress: (percentage, message) => {
              providerStatus[provider.id] = { status: "running", message };
              job.updateProgress({
                providers: providerStatus,
                percentage: computePercentage(completedCount, percentage, totalProviders),
              });
            },
            userId: job.data.userId,
            metricStreamPublisher,
            checkpoint: createCheckpointStore(job),
            enqueueSyncContinuation: async (checkpoint) => {
              await withAccountErasureUserWriteFence(
                requireTransactionalSyncDatabase(db),
                job.data.userId,
                async () => {
                  await enqueueSyncJob(provider.id, {
                    ...job.data,
                    providerId: provider.id,
                    sinceIso: since.toISOString(),
                    untilIso: until.toISOString(),
                    checkpoint,
                  });
                },
              );
            },
          }),
        ),
      );
      if (result.recordsSynced > 0) {
        if (
          !(await accountErasureAllowsQueuedUserWork(
            db,
            job.data.userId,
            "sync cache invalidation",
          ))
        ) {
          return;
        }
        await invalidateAllUserQueries(job.data.userId);
      }
      if (result.continued) {
        syncRunContinued = true;
        providerStatus[provider.id] = {
          status: "running",
          message: `${result.recordsSynced} synced so far`,
        };
        await job.updateProgress({
          providers: providerStatus,
          percentage: computePercentage(completedCount, 50, totalProviders),
        });
        continue;
      }
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
      const authFailureReason = firstAuthFailureReason(result.errors);
      const failureEvent = providerSyncFailureEvent(provider.name, authFailureReason);
      completedCount++;
      const hasErrors = result.errors.length > 0;
      const emittedRelationalDatasetKeys = processingDatasetKeysForOutputPath(
        processingOperation.datasetKeys,
        "relational",
      );
      if (result.recordsSynced > 0 && emittedRelationalDatasetKeys.length > 0) {
        await recordRelationalCanonicalCommits(requireTransactionalSyncDatabase(db), {
          operationId: processingOperation.id,
          datasetKeys: emittedRelationalDatasetKeys,
          idempotencyKey: `worker-relational-commit:${job.id ?? "unidentified-job"}`,
        });
      }
      const outputManifest = await getProcessingOutputManifest(db, processingOperation.id);
      const noOutputDatasetKeys = processingOperation.datasetKeys.filter(
        (datasetKey) => (outputManifest[datasetKey]?.length ?? 0) === 0,
      );
      if (noOutputDatasetKeys.length > 0) {
        await recordNoOutputStageSkips(db, processingOperation.id, noOutputDatasetKeys);
      }
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
          const reportableError = err.cause ?? new Error(err.message);
          if (shouldReportProviderError(reportableError)) {
            captureException(reportableError, {
              tags: { provider: provider.id },
              ...(err.context ? { extra: err.context } : {}),
            });
          }
        }
      }

      await appendProcessingStageEvent(db, {
        operationId: processingOperation.id,
        stage: "ingest",
        status: hasErrors ? "failed" : "succeeded",
        progressPercentage: 100,
        errorCode: hasErrors ? failureEvent.errorCode : undefined,
        errorMessage: hasErrors ? failureEvent.errorMessage : undefined,
        idempotencyKey: hasErrors ? "worker-failed" : "worker-succeeded",
      });

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
        const retryAt = await scheduleRateLimitRetry(db, job, err, since, until);
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

      if (isRetryableInfraError(err) && !isProviderTransportError(err)) {
        const message = err instanceof Error ? err.message : String(err);
        captureException(err, {
          tags: { provider: provider.id, retryable: "true" },
          level: "warning",
        });
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
      const failureEvent = providerSyncFailureEvent(provider.name, authFailureReason);
      if (shouldReportProviderError(err)) {
        captureException(err, { tags: { provider: provider.id } });
      }
      providerStatus[provider.id] = { status: "error", message };
      await appendProcessingStageEvent(db, {
        operationId: processingOperation.id,
        stage: "ingest",
        status: "failed",
        ...failureEvent,
        idempotencyKey: "worker-failed",
      });
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

  if (syncRunContinued) {
    return;
  }

  try {
    const { enqueueDebouncedPostSyncMaintenance } = await import("./queues.ts");
    await enqueueDebouncedPostSyncMaintenance();
  } catch (err) {
    logger.error(`[worker] Failed to enqueue global post-sync maintenance: ${err}`);
    captureException(err, { tags: { phase: "post-sync-global-maintenance-enqueue" } });
  }

  try {
    const { enqueueDebouncedUserRefit } = await import("./queues.ts");
    await withAccountErasureUserWriteFence(
      requireTransactionalSyncDatabase(db),
      job.data.userId,
      async () => {
        await enqueueDebouncedUserRefit(job.data.userId);
      },
    );
  } catch (err) {
    logger.error(`[worker] Failed to enqueue user refit: ${err}`);
    captureException(err, { tags: { phase: "post-sync-user-refit-enqueue" } });
  }
}
