import { userFacingErrorMessage } from "@dofek/format/user-facing-error";
import {
  ProviderRateLimitError,
  type ProviderServiceUnavailableError,
} from "@dofek/provider-http/rate-limit";
import { withAccountErasureUserWriteFence } from "../db/account-erasure.ts";
import type { SyncDatabase } from "../db/index.ts";
import type { SyncLogOrigin } from "../db/schema/events.ts";
import { logSync } from "../db/sync-log.ts";
import { captureException } from "../lib/error-reporting.ts";
import {
  providerSyncFailureKind,
  shouldReportProviderError,
} from "../lib/provider-error-reporting.ts";
import {
  findProviderTransportError,
  isRetryingOpenBetaTransportFailure,
  isRetryingZeppHttp500ServiceUnavailableError,
  isZeppHttp500ServiceUnavailableError,
} from "../lib/provider-transport-error.ts";
import { isRetryableInfraError } from "../lib/retryable-infra-error.ts";
import { sanitizeErrorMessage } from "../lib/sanitize-error.ts";
import { logger } from "../logger.ts";
import { appendProcessingStageEvent } from "../processing/processing-event-store.ts";
import {
  authFailureReasonFromError,
  ProviderAccessDeniedError,
  type ProviderAuthFailureReason,
} from "../providers/auth-errors.ts";
import type { SyncError, SyncProvider } from "../providers/types.ts";
import { syncDuration, syncErrorsTotal, syncOperationsTotal } from "../sync-metrics.ts";
import { scheduleDelayedSyncJob } from "./enqueue-sync-job.ts";
import {
  type ProviderRateLimitCooldown,
  providerCooldownLabel,
  providerRateLimitCooldownStore,
} from "./provider-rate-limit-cooldown.ts";
import type { SyncJob } from "./queues.ts";
import type { SyncJobContext } from "./sync-job-context.ts";
import type { SyncProcessingOperation } from "./sync-processing-operation.ts";

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

type ProviderDeferralError = ProviderRateLimitError | ProviderServiceUnavailableError;

class DeferredSyncResultError extends AggregateError {
  readonly otherFailures: SyncError[];

  constructor(deferrals: ProviderDeferralError[], otherFailures: SyncError[]) {
    super(deferrals, "Provider requested a sync delay");
    this.otherFailures = otherFailures;
  }
}

function providerSyncDeferralError(error: unknown): ProviderDeferralError | null {
  if (error instanceof ProviderRateLimitError) return error;
  const transportError = findProviderTransportError(error);
  return transportError &&
    "statusCode" in transportError &&
    transportError.statusCode === 503 &&
    (transportError.retryAfterSeconds ?? 0) > 0
    ? transportError
    : null;
}

export function providerSyncDeferralErrors(error: unknown): ProviderDeferralError[] {
  const failures: readonly unknown[] = error instanceof AggregateError ? error.errors : [error];
  return failures.map(providerSyncDeferralError).filter((failure) => failure !== null);
}

export function recordProviderSyncFailures(
  providerId: string,
  origin: SyncLogOrigin,
  failures: readonly unknown[],
) {
  const counts = new Map<ReturnType<typeof providerSyncFailureKind>, number>();
  for (const failure of failures) {
    const kind = providerSyncFailureKind(failure);
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }
  for (const [failureKind, count] of counts) {
    syncErrorsTotal.add(count, {
      provider: providerId,
      data_type: "sync",
      failure_kind: failureKind,
      origin,
    });
  }
}

export function reportSyncResultErrors(provider: SyncProvider, errors: readonly SyncError[]) {
  for (const error of errors) {
    logger.error(`[worker] ${provider.name} sync error: ${error.message}`);
    const cause = error.cause ?? new Error(error.message);
    if (shouldReportProviderError(cause)) {
      captureException(cause, {
        tags: { provider: provider.id },
        ...(error.context ? { extra: error.context } : {}),
      });
    }
  }
}

export function firstAuthFailureReason(errors: SyncError[]): ProviderAuthFailureReason | undefined {
  return errors
    .map((syncError) => authFailureReasonFromError(syncError.cause))
    .find((authFailureReason) => authFailureReason !== undefined);
}

export function providerSyncFailureEvent(
  providerName: string,
  authFailureReason: ProviderAuthFailureReason | undefined,
  pushOnly = false,
  failure?: unknown,
): { errorCode: "provider_auth_failed" | "provider_sync_failed"; errorMessage: string } {
  if (authFailureReason) {
    return {
      errorCode: "provider_auth_failed",
      errorMessage: pushOnly
        ? `${providerName} authorization needs attention. Reconnect ${providerName} to receive future updates.`
        : `${providerName} authorization needs attention. Reconnect ${providerName}, then try again.`,
    };
  }
  if (failure instanceof ProviderAccessDeniedError) {
    return { errorCode: "provider_sync_failed", errorMessage: failure.message };
  }
  return {
    errorCode: "provider_sync_failed",
    errorMessage: pushOnly
      ? userFacingErrorMessage(
          sanitizeErrorMessage(
            failure instanceof Error
              ? failure.message
              : typeof failure === "string"
                ? failure
                : null,
          ),
          `${providerName} data could not be processed.`,
        ).slice(0, 500)
      : `${providerName} could not be synced. Try the sync again later.`,
  };
}

function isProviderTransportError(error: unknown): boolean {
  return findProviderTransportError(error) !== null;
}

async function scheduleProviderRetry(
  db: SyncDatabase,
  job: SyncJob,
  providerId: string,
  firstError: ProviderDeferralError,
  otherErrors: readonly ProviderDeferralError[],
  since: Date,
  until: Date,
  signal?: AbortSignal,
): Promise<{ cooldown: ProviderRateLimitCooldown; retryAt: string }> {
  let longest = await providerRateLimitCooldownStore.record(firstError, job.data.userId);
  for (const error of otherErrors) {
    const recorded = await providerRateLimitCooldownStore.record(error, job.data.userId);
    if (recorded.expiresAt > longest.expiresAt) longest = recorded;
  }
  const active = await providerRateLimitCooldownStore.getActive(providerId, job.data.userId);
  const cooldown = active && active.expiresAt >= longest.expiresAt ? active : longest;
  signal?.throwIfAborted();
  return withAccountErasureUserWriteFence(db, job.data.userId, async () => {
    signal?.throwIfAborted();
    const retryAt = await scheduleDelayedSyncJob(
      {
        ...job.data,
        providerId,
        sinceIso: since.toISOString(),
        untilIso: until.toISOString(),
      },
      cooldown,
    );
    signal?.throwIfAborted();
    return { cooldown, retryAt };
  });
}

export function throwRetryableSyncResultError(errors: SyncError[]): void {
  const deferralErrors: ProviderDeferralError[] = [];
  const otherFailures: SyncError[] = [];
  for (const error of errors) {
    const deferrals = providerSyncDeferralErrors(error.cause);
    if (deferrals.length === 0) otherFailures.push(error);
    else deferralErrors.push(...deferrals);
  }
  if (deferralErrors.length > 0) throw new DeferredSyncResultError(deferralErrors, otherFailures);
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
  const deferralErrors = providerSyncDeferralErrors(err);
  const [deferralError, ...otherDeferralErrors] = deferralErrors;
  const otherFailures = err instanceof DeferredSyncResultError ? err.otherFailures : [];
  const failureCauses = deferralError
    ? [...deferralErrors, ...otherFailures.map((error) => error.cause ?? new Error(error.message))]
    : [err];
  recordProviderSyncFailures(provider.id, job.data.origin ?? "unknown", failureCauses);
  const isOpenBetaTransportFailure = provider.id === "openbeta" && isProviderTransportError(err);
  const isZeppHttp500Failure = isZeppHttp500ServiceUnavailableError(err);
  if (
    !deferralError &&
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
  if (deferralError) {
    const { cooldown, retryAt } = await scheduleProviderRetry(
      db,
      job,
      provider.id,
      deferralError,
      otherDeferralErrors,
      since,
      until,
      signal,
    );
    const message = `${providerCooldownLabel(cooldown)}; retry scheduled for ${retryAt}`;
    context.completedCount++;
    context.providerStatus[provider.id] = { status: "running", message };
    await job.updateProgress({
      providers: context.providerStatus,
      percentage: context.percentage(0),
    });
    logger.warn(`[worker] ${provider.name}: ${message}`);
    reportSyncResultErrors(provider, otherFailures);

    const durationMs = Date.now() - syncStart;
    await logSync(db, {
      providerId: provider.id,
      dataType: "sync",
      status: "error",
      errorMessage: [...deferralErrors, ...otherFailures].map((error) => error.message).join("; "),
      errorCauses: failureCauses,
      authFailureReason: firstAuthFailureReason(otherFailures),
      durationMs,
      userId: job.data.userId,
      origin: job.data.origin ?? "unknown",
    });

    syncOperationsTotal.add(1, { provider: provider.id, data_type: "sync", status: "error" });
    syncDuration.record(durationMs, { provider: provider.id, data_type: "sync" });
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
  const failureEvent = providerSyncFailureEvent(
    provider.name,
    authFailureReason,
    provider.pushOnly,
    err,
  );
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
    errorCauses: [err],
    authFailureReason,
    durationMs,
    userId: job.data.userId,
    origin: job.data.origin ?? "unknown",
  });

  syncOperationsTotal.add(1, { provider: provider.id, data_type: "sync", status: "error" });
  syncDuration.record(durationMs, { provider: provider.id, data_type: "sync" });
  if (isExhaustedTransportFailure) throw err;
}
