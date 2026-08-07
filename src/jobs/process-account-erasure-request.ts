import * as Sentry from "@sentry/node";
import {
  type ClaimedAccountErasureRequest,
  claimAccountErasureRequest,
  completeAccountErasure,
  deleteAccountErasureUserProfile,
  loadAccountErasureCheckpointDetails,
  loadAccountErasureCheckpoints,
  loadAccountErasurePhaseProgress,
  markAccountErasureFailed,
  markAccountErasurePhaseCompleted,
  markAccountErasureWaiting,
  renewAccountErasureLease,
  saveAccountErasurePhaseProgress,
  scrubAccountErasureRequestPii,
} from "../db/account-erasure-processing.ts";
import type { Database } from "../db/index.ts";
import {
  type AccountErasureJobResult,
  type AccountErasurePhase,
  accountErasureRetentionVerificationAt,
  processAccountErasureJob,
} from "./process-account-erasure-job.ts";

const LEASE_DURATION_MS = 5 * 60 * 1_000;
const LEASE_HEARTBEAT_MS = 60 * 1_000;
const SAFE_RETRY_FAILURE_MESSAGE = "Account erasure processing failed; retry scheduled";

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

function reportAccountErasureFailure(
  phase: AccountErasurePhase | "coordination" | "lease_heartbeat" | "retry_state",
  error: unknown,
): void {
  Sentry.captureException(new Error("Account erasure phase failed"), {
    tags: {
      accountErasurePhase: phase,
      errorName: errorName(error),
      source: "account-erasure-request",
    },
  });
}

export interface AccountErasurePhaseExecution {
  deleteProfile(): Promise<{ walLsn: string }>;
  request: ClaimedAccountErasureRequest;
  loadCheckpointDetails(phase: AccountErasurePhase): Promise<Record<string, unknown> | null>;
  loadProgress(): Promise<Record<string, unknown> | null>;
  saveProgress(details: Record<string, unknown>): Promise<void>;
  scrubPii(): Promise<void>;
}

export interface AccountErasurePhaseRunner {
  runPhase(
    phase: AccountErasurePhase,
    execution: AccountErasurePhaseExecution,
  ): Promise<Record<string, unknown> | null>;
}

export type AccountErasureRequestProcessingResult =
  | AccountErasureJobResult
  | { status: "not_claimed" };

interface LeaseHeartbeat {
  assertHealthy(): void;
  stop(): Promise<void>;
}

function startLeaseHeartbeat(
  database: Pick<Database, "execute">,
  requestId: string,
  leaseOwner: string,
): LeaseHeartbeat {
  let failure: unknown;
  let inFlight: Promise<void> | null = null;
  let stopped = false;

  const renew = (): void => {
    if (stopped || inFlight) return;
    inFlight = renewAccountErasureLease(database, requestId, leaseOwner, LEASE_DURATION_MS)
      .catch((error: unknown) => {
        failure = error;
        reportAccountErasureFailure("lease_heartbeat", error);
      })
      .finally(() => {
        inFlight = null;
      });
  };
  const timer = setInterval(renew, LEASE_HEARTBEAT_MS);

  return {
    assertHealthy(): void {
      if (failure) {
        throw new Error("Account erasure lease heartbeat failed", {
          cause: failure,
        });
      }
    },
    async stop(): Promise<void> {
      if (!stopped) {
        stopped = true;
        clearInterval(timer);
      }
      await inFlight;
      this.assertHealthy();
    },
  };
}

export async function processAccountErasureRequest(
  database: Pick<Database, "execute" | "transaction">,
  requestId: string,
  leaseOwner: string,
  phaseRunner: AccountErasurePhaseRunner,
  now = new Date(),
): Promise<AccountErasureRequestProcessingResult> {
  const request = await claimAccountErasureRequest(
    database,
    requestId,
    leaseOwner,
    LEASE_DURATION_MS,
    now,
  );
  if (!request) return { status: "not_claimed" };

  const heartbeat = startLeaseHeartbeat(database, request.id, leaseOwner);
  let phaseFailureReported = false;
  try {
    return await processAccountErasureJob(
      {
        id: request.id,
        requestedAt: request.requestedAt,
        replayRetainedUntil: request.replayRetainedUntil,
        retentionVerificationAt: accountErasureRetentionVerificationAt(request.requestedAt),
        userId: request.userId,
      },
      {
        finalize: async (_request, completedAt) => {
          await heartbeat.stop();
          await completeAccountErasure(database, request.id, leaseOwner, completedAt);
        },
        loadCompletedPhases: () => loadAccountErasureCheckpoints(database, request.id),
        markCompleted: async (completedRequestId, phase, details) => {
          try {
            await markAccountErasurePhaseCompleted(
              database,
              completedRequestId,
              leaseOwner,
              phase,
              details,
            );
          } catch (error: unknown) {
            phaseFailureReported = true;
            reportAccountErasureFailure(phase, error);
            throw error;
          }
        },
        markWaiting: async (waitingRequestId, retryAt, reason) => {
          await heartbeat.stop();
          await markAccountErasureWaiting(database, waitingRequestId, leaseOwner, retryAt, reason);
        },
        runPhase: async (phase) => {
          try {
            heartbeat.assertHealthy();
            const details = await phaseRunner.runPhase(phase, {
              deleteProfile: async () => {
                if (!request.userId) {
                  throw new Error("Account erasure user profile was already deleted");
                }
                return deleteAccountErasureUserProfile(
                  database,
                  request.id,
                  request.userId,
                  leaseOwner,
                );
              },
              request,
              loadCheckpointDetails: (checkpointPhase) =>
                loadAccountErasureCheckpointDetails(database, request.id, checkpointPhase),
              loadProgress: () => loadAccountErasurePhaseProgress(database, request.id, phase),
              saveProgress: (progress) =>
                saveAccountErasurePhaseProgress(database, request.id, leaseOwner, phase, progress),
              scrubPii: async () => {
                if (!request.userId) {
                  throw new Error("Account erasure request PII was already scrubbed");
                }
                await scrubAccountErasureRequestPii(
                  database,
                  request.id,
                  request.userId,
                  leaseOwner,
                );
              },
            });
            heartbeat.assertHealthy();
            return details;
          } catch (error: unknown) {
            phaseFailureReported = true;
            reportAccountErasureFailure(phase, error);
            throw error;
          }
        },
      },
      now,
    );
  } catch (error: unknown) {
    if (!phaseFailureReported) {
      reportAccountErasureFailure("coordination", error);
    }
    const failures: unknown[] = [error];
    try {
      await heartbeat.stop();
    } catch (heartbeatError: unknown) {
      failures.push(heartbeatError);
    }
    try {
      await markAccountErasureFailed(database, request.id, leaseOwner, SAFE_RETRY_FAILURE_MESSAGE);
    } catch (persistenceError: unknown) {
      reportAccountErasureFailure("retry_state", persistenceError);
      failures.push(persistenceError);
    }
    if (failures.length > 1) {
      throw new AggregateError(
        failures,
        "Account erasure failed and its retry state could not be fully persisted",
        { cause: error },
      );
    }
    throw error;
  }
}
