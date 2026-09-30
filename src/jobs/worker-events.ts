import { Job, UnrecoverableError, type Worker } from "bullmq";
import type { createDatabaseFromEnv } from "../db/index.ts";
import { markProviderDataDeletionFailed } from "../db/provider-data-deletion.ts";
import { captureException } from "../lib/error-reporting.ts";
import {
  isRetryingOpenBetaTransportFailure,
  isZeppHttp500ServiceUnavailableError,
} from "../lib/provider-transport-error.ts";
import { logger } from "../logger.ts";
import { isImportValidationError } from "./import-validation-error.ts";
import {
  ACCOUNT_ERASURE_QUEUE,
  FIT_FILE_IMPORT_QUEUE,
  IMPORT_QUEUE,
  type ProviderDataDeletionJobData,
} from "./queues.ts";
import type { createWorkerLifecycle } from "./worker-lifecycle.ts";

export function attachWorkerEvents(
  allWorkers: Worker[],
  lifecycle: ReturnType<typeof createWorkerLifecycle>,
  db: ReturnType<typeof createDatabaseFromEnv>,
  providerDataDeletionWorker: Worker<ProviderDataDeletionJobData>,
) {
  const { trackActiveJob, finishActiveJob, resetIdleTimer, startIdleTimer, activeJobCount } =
    lifecycle;
  async function persistProviderDataDeletionFailure(
    job: Job<ProviderDataDeletionJobData>,
    failure: Error,
  ): Promise<void> {
    try {
      await markProviderDataDeletionFailed(
        db,
        job.data.eventId,
        failure.message || "Provider data deletion failed",
      );
    } catch (error: unknown) {
      captureException(error, {
        tags: { providerDataDeletionStep: "persistFailure" },
        extra: { eventId: job.data.eventId },
      });
      logger.error(
        `[provider-data-deletion] Failed to persist terminal failure for ${job.data.eventId}: ${String(error)}`,
      );
    }
  }

  providerDataDeletionWorker.on("failed", (job, error) => {
    if (!job) return;
    if (error instanceof UnrecoverableError) {
      void persistProviderDataDeletionFailure(job, error);
      return;
    }
    const configuredAttempts = job.opts.attempts ?? 1;
    if (job.attemptsMade < configuredAttempts) return;

    void job
      .retry("failed", { resetAttemptsMade: true, resetAttemptsStarted: true })
      .catch(async (redriveError: unknown) => {
        captureException(redriveError, {
          tags: { providerDataDeletionStep: "redrive" },
          extra: { eventId: job.data.eventId },
        });
        logger.error(
          `[provider-data-deletion] Failed to redrive terminal job ${job.data.eventId}: ${String(redriveError)}`,
        );
        await persistProviderDataDeletionFailure(job, error);
      });
  });
  function reportAccountErasureWorkerEvent(
    event: "error" | "failed" | "lockRenewalFailed" | "stalled",
    message: string,
  ): void {
    captureException(new Error(message), {
      tags: {
        bullmqEvent: event,
        queue: ACCOUNT_ERASURE_QUEUE,
      },
    });
    logger.error(`[worker] ${message}`);
  }

  for (const worker of allWorkers) {
    worker.on("active", (job) => {
      trackActiveJob(worker, job);
      resetIdleTimer();
    });

    worker.on("completed", (job) => {
      finishActiveJob(worker, job);
      if (activeJobCount() === 0) startIdleTimer();
    });

    worker.on("failed", (job, err) => {
      finishActiveJob(worker, job);
      if (worker.name === ACCOUNT_ERASURE_QUEUE) {
        reportAccountErasureWorkerEvent("failed", "Account erasure job failed");
        if (activeJobCount() === 0) startIdleTimer();
        return;
      }
      // FIT file import batch children fail as UnrecoverableError — that's expected
      // for invalid files. Suppress per-file capture to avoid flooding Sentry and
      // rely on the batch/parent job to report grouped error causes once.
      const isFitBatchChildFailure =
        worker.name === FIT_FILE_IMPORT_QUEUE &&
        job?.parentKey &&
        err instanceof UnrecoverableError;
      const isImportValidationFailure =
        worker.name === IMPORT_QUEUE && isImportValidationError(err);
      const isZeppHttp500ServiceUnavailable = isZeppHttp500ServiceUnavailableError(err);
      const isOpenBetaRetry =
        job !== undefined &&
        isRetryingOpenBetaTransportFailure(err, job.attemptsMade, job.opts.attempts);
      if (
        !isFitBatchChildFailure &&
        !isImportValidationFailure &&
        !isZeppHttp500ServiceUnavailable &&
        !isOpenBetaRetry
      ) {
        captureException(err);
      }
      if (isZeppHttp500ServiceUnavailable || isOpenBetaRetry) {
        logger.warn(`[worker] Job retrying after provider service unavailable: ${err.message}`);
      } else {
        logger.error(`[worker] Job failed: ${err.message}`);
      }
      if (job?.id) {
        const message = `BullMQ job failed: queue=${worker.name} jobId=${job.id} cause=${err.message}`;
        void Job.addJobLog(worker, job.id, `[error] ${message}`, 100).catch((logError: unknown) => {
          captureException(logError, {
            tags: { bullmqEvent: "failed", queue: worker.name },
            extra: { jobId: job.id, operation: "addJobLog" },
          });
          logger.error(
            `[worker] Failed to append failed job log: queue=${worker.name} jobId=${job.id}: ${String(logError)}`,
          );
        });
      }
      if (activeJobCount() === 0) startIdleTimer();
    });

    worker.on("stalled", (jobId, previousState) => {
      if (worker.name === ACCOUNT_ERASURE_QUEUE) {
        reportAccountErasureWorkerEvent("stalled", "Account erasure BullMQ job stalled");
        return;
      }
      const message = `BullMQ job stalled: queue=${worker.name} jobId=${jobId} previousState=${previousState}`;
      const error = new Error(message);
      captureException(error, {
        tags: { bullmqEvent: "stalled", queue: worker.name },
      });
      logger.error(`[worker] ${message}`);
      void Job.addJobLog(worker, jobId, `[error] ${message}`, 100).catch((logError: unknown) => {
        captureException(logError);
        logger.error(`[worker] Failed to append stalled job log: ${String(logError)}`);
      });
    });

    worker.on("lockRenewalFailed", (jobIds) => {
      if (worker.name === ACCOUNT_ERASURE_QUEUE) {
        reportAccountErasureWorkerEvent(
          "lockRenewalFailed",
          "Account erasure BullMQ lock renewal failed",
        );
        return;
      }
      const message = `BullMQ lock renewal failed: queue=${worker.name} jobIds=${jobIds.join(",")}`;
      const error = new Error(message);
      captureException(error, {
        tags: { bullmqEvent: "lockRenewalFailed", queue: worker.name },
        extra: { jobIds },
      });
      logger.error(`[worker] ${message}`);
      for (const jobId of jobIds) {
        void Job.addJobLog(worker, jobId, `[error] ${message}`, 100).catch((logError: unknown) => {
          captureException(logError, {
            tags: { bullmqEvent: "lockRenewalFailed", queue: worker.name },
            extra: { jobId, operation: "addJobLog" },
          });
          logger.error(
            `[worker] Failed to append lock renewal failure job log: queue=${worker.name} jobId=${jobId}: ${String(logError)}`,
          );
        });
      }
    });

    worker.on("error", (err) => {
      if (worker.name === ACCOUNT_ERASURE_QUEUE) {
        reportAccountErasureWorkerEvent("error", "Account erasure worker error");
        return;
      }
      captureException(err);
      logger.error(`[worker] Worker error: ${err.message}`);
    });
  }
}
