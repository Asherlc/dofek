import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { withAccountErasureUserWriteFence } from "../db/account-erasure.ts";
import type { SyncDatabase } from "../db/index.ts";
import { logSync } from "../db/sync-log.ts";
import { captureException } from "../lib/error-reporting.ts";
import {
  findProviderTransportError,
  isRetryingOpenBetaTransportFailure,
  isRetryingZeppHttp500ServiceUnavailableError,
  isZeppHttp500ServiceUnavailableError,
} from "../lib/provider-transport-error.ts";
import { isRetryableInfraError } from "../lib/retryable-infra-error.ts";
import { logger } from "../logger.ts";
import { appendProcessingStageEvent } from "../processing/processing-event-store.ts";
import {
  authFailureReasonFromError,
  type ProviderAuthFailureReason,
} from "../providers/auth-errors.ts";
import type { SyncError, SyncProvider } from "../providers/types.ts";
import { syncDuration, syncErrorsTotal, syncOperationsTotal } from "../sync-metrics.ts";
import { scheduleDelayedSyncJob } from "./enqueue-sync-job.ts";
import { providerRateLimitCooldownStore } from "./provider-rate-limit-cooldown.ts";
import type { SyncJob } from "./queues.ts";
import type { SyncJobContext } from "./sync-job-context.ts";
import {
  requireTransactionalSyncDatabase,
  type SyncProcessingOperation,
} from "./sync-processing-operation.ts";

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

export function firstAuthFailureReason(errors: SyncError[]): ProviderAuthFailureReason | undefined {
  return errors
    .map((syncError) => authFailureReasonFromError(syncError.cause))
    .find((authFailureReason) => authFailureReason !== undefined);
}

export function providerSyncFailureEvent(
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

function isProviderTransportError(error: unknown): boolean {
  return findProviderTransportError(error) !== null;
}

export function shouldReportProviderError(error: unknown): boolean {
  if (error instanceof Error && error.name === "AbortError") return false;
  return !isProviderTransportError(error) && !authFailureReasonFromError(error);
}

async function scheduleRateLimitRetry(
  db: SyncDatabase,
  job: SyncJob,
  error: ProviderRateLimitError,
  since: Date,
  until: Date,
  signal?: AbortSignal,
): Promise<string> {
  const cooldown = await providerRateLimitCooldownStore.record(error, job.data.userId);
  signal?.throwIfAborted();
  return withAccountErasureUserWriteFence(
    requireTransactionalSyncDatabase(db),
    job.data.userId,
    async () => {
      signal?.throwIfAborted();
      const retryAt = await scheduleDelayedSyncJob(
        {
          ...job.data,
          providerId: error.providerId,
          sinceIso: since.toISOString(),
          untilIso: until.toISOString(),
        },
        cooldown,
      );
      signal?.throwIfAborted();
      return retryAt;
    },
  );
}

export function throwRetryableSyncResultError(errors: SyncError[]): void {
  const rateLimitError = firstProviderRateLimitError(errors);
  if (rateLimitError) throw rateLimitError;
  const infraError = firstRetryableInfraSyncError(errors);
  if (infraError)
    throw infraError.cause instanceof Error ? infraError.cause : new Error(infraError.message);
}

/** Preserves retry classification and terminal failure reporting for one attempt. */
export async function handleSyncProviderFailure(
  context: SyncJobContext,
  provider: SyncProvider,
  processingOperation: SyncProcessingOperation,
  syncStart: number,
  err: unknown,
): Promise<void> {
  const { job, db, signal } = context;
  const { since, until } = context.syncWindow;
  if (processingOperation.recordingCanonicalCommit) {
    captureException(err, { tags: { provider: provider.id, phase: "canonical-commit" } });
    throw err;
  }
  signal?.throwIfAborted();
  const isOpenBetaTransportFailure = provider.id === "openbeta" && isProviderTransportError(err);
  const isZeppHttp500Failure = isZeppHttp500ServiceUnavailableError(err);
  if (
    isOpenBetaTransportFailure &&
    isRetryingOpenBetaTransportFailure(err, job.attemptsMade + 1, job.opts.attempts)
  ) {
    context.providerStatus[provider.id] = {
      status: "running",
      message: "Service unavailable; retrying",
    };
    await job.updateProgress({
      providers: context.providerStatus,
      percentage: context.percentage(0),
    });
    logger.warn(`[worker] ${provider.name} temporarily unavailable; retrying: ${String(err)}`);
    throw err;
  }
  if (err instanceof ProviderRateLimitError) {
    const retryAt = await scheduleRateLimitRetry(db, job, err, since, until, signal);
    const message = `Rate limited; retry scheduled for ${retryAt}`;
    context.completedCount++;
    context.providerStatus[provider.id] = { status: "running", message };
    await job.updateProgress({
      providers: context.providerStatus,
      percentage: context.percentage(0),
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
      origin: job.data.origin ?? "unknown",
    });

    syncOperationsTotal.add(1, { provider: provider.id, data_type: "sync", status: "error" });
    syncDuration.record(durationMs, { provider: provider.id, data_type: "sync" });
    syncErrorsTotal.add(1, { provider: provider.id, data_type: "sync" });
    return;
  }

  if (
    isZeppHttp500Failure &&
    isRetryingZeppHttp500ServiceUnavailableError(err, job.attemptsMade + 1, job.opts.attempts)
  ) {
    context.providerStatus[provider.id] = {
      status: "running",
      message: "Service unavailable; retrying",
    };
    await job.updateProgress({
      providers: context.providerStatus,
      percentage: context.percentage(0),
    });
    logger.warn(`[worker] ${provider.name} service unavailable, retrying: ${err.message}`);
    throw err;
  }

  if (isRetryableInfraError(err) && !isProviderTransportError(err)) {
    const message = err instanceof Error ? err.message : String(err);
    captureException(err, {
      tags: { provider: provider.id, retryable: "true" },
      level: "warning",
    });
    context.providerStatus[provider.id] = {
      status: "running",
      message: "Infrastructure unavailable; retrying",
    };
    await job.updateProgress({
      providers: context.providerStatus,
      percentage: context.percentage(0),
    });
    logger.warn(`[worker] ${provider.name} infrastructure failure, retrying: ${message}`);
    throw err;
  }
  context.completedCount++;
  const isExhaustedTransportFailure = isOpenBetaTransportFailure || isZeppHttp500Failure;
  const message = isExhaustedTransportFailure
    ? `${provider.name} is unavailable and automatic retries were exhausted. Try syncing again later.`
    : err instanceof Error
      ? err.message
      : String(err);
  const authFailureReason = authFailureReasonFromError(err);
  const failureEvent = providerSyncFailureEvent(provider.name, authFailureReason);
  if (shouldReportProviderError(err)) {
    captureException(err, { tags: { provider: provider.id } });
  }
  context.providerStatus[provider.id] = { status: "error", message };
  await appendProcessingStageEvent(db, {
    operationId: processingOperation.id,
    stage: "ingest",
    status: "failed",
    ...failureEvent,
    ...(isExhaustedTransportFailure ? { errorMessage: message } : {}),
    idempotencyKey: "worker-failed",
  });
  await job.updateProgress({
    providers: context.providerStatus,
    percentage: context.percentage(0),
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
    origin: job.data.origin ?? "unknown",
  });

  syncOperationsTotal.add(1, { provider: provider.id, data_type: "sync", status: "error" });
  syncDuration.record(durationMs, { provider: provider.id, data_type: "sync" });
  syncErrorsTotal.add(1, { provider: provider.id, data_type: "sync" });
  if (isExhaustedTransportFailure) throw err;
}
