import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClaimedAccountErasureRequest } from "../db/account-erasure-processing.ts";
import type { Database } from "../db/index.ts";
import {
  type AccountErasurePhaseRunner,
  processAccountErasureRequest,
} from "./process-account-erasure-request.ts";

const accountErasureDatabaseMocks = vi.hoisted(() => ({
  claimAccountErasureRequest: vi.fn(),
  completeAccountErasure: vi.fn(),
  deleteAccountErasureUserProfile: vi.fn(),
  loadAccountErasureCheckpoints: vi.fn(),
  loadAccountErasureCheckpointDetails: vi.fn(),
  loadAccountErasurePhaseProgress: vi.fn(),
  markAccountErasureFailed: vi.fn(),
  markAccountErasurePhaseCompleted: vi.fn(),
  markAccountErasureWaiting: vi.fn(),
  renewAccountErasureLease: vi.fn(),
  saveAccountErasurePhaseProgress: vi.fn(),
  scrubAccountErasureRequestPii: vi.fn(),
}));
const sentryMocks = vi.hoisted(() => ({
  captureException: vi.fn(),
}));

vi.mock("../db/account-erasure-processing.ts", () => accountErasureDatabaseMocks);
vi.mock("@sentry/node", () => sentryMocks);

const request: ClaimedAccountErasureRequest = {
  completionDeadline: new Date("2026-08-25T12:00:00.000Z"),
  encryptedRemoteSnapshot: "encrypted-snapshot",
  id: "10000000-0000-4000-8000-000000001994",
  piiScrubbedAt: null,
  replayRetainedUntil: new Date("2026-08-02T12:00:00.000Z"),
  requestedAt: new Date("2026-07-26T12:00:00.000Z"),
  userHash: "a".repeat(64),
  userHashKeyId: "test-v1",
  userId: "20000000-0000-4000-8000-000000001994",
};

const execute: Database["execute"] = async () => {
  throw new Error("unexpected direct database execute");
};
const transaction: Database["transaction"] = async () => {
  throw new Error("unexpected direct database transaction");
};
const database: Pick<Database, "execute" | "transaction"> = {
  execute,
  transaction,
};

function phaseRunner(
  implementation: AccountErasurePhaseRunner["runPhase"] = async () => null,
): AccountErasurePhaseRunner {
  return { runPhase: vi.fn(implementation) };
}

beforeEach(() => {
  accountErasureDatabaseMocks.claimAccountErasureRequest.mockResolvedValue(request);
  accountErasureDatabaseMocks.completeAccountErasure.mockResolvedValue(undefined);
  accountErasureDatabaseMocks.deleteAccountErasureUserProfile.mockResolvedValue({
    walLsn: "0/1A2B",
  });
  accountErasureDatabaseMocks.loadAccountErasureCheckpoints.mockResolvedValue(new Set());
  accountErasureDatabaseMocks.loadAccountErasureCheckpointDetails.mockResolvedValue(null);
  accountErasureDatabaseMocks.loadAccountErasurePhaseProgress.mockResolvedValue(null);
  accountErasureDatabaseMocks.markAccountErasureFailed.mockResolvedValue(undefined);
  accountErasureDatabaseMocks.markAccountErasurePhaseCompleted.mockResolvedValue(undefined);
  accountErasureDatabaseMocks.markAccountErasureWaiting.mockResolvedValue(undefined);
  accountErasureDatabaseMocks.renewAccountErasureLease.mockResolvedValue(undefined);
  accountErasureDatabaseMocks.saveAccountErasurePhaseProgress.mockResolvedValue(undefined);
  accountErasureDatabaseMocks.scrubAccountErasureRequestPii.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe("processAccountErasureRequest", () => {
  it("does not execute effects when another worker owns the request", async () => {
    accountErasureDatabaseMocks.claimAccountErasureRequest.mockResolvedValue(null);
    const runner = phaseRunner();

    await expect(
      processAccountErasureRequest(database, request.id, "worker-1", runner),
    ).resolves.toEqual({ status: "not_claimed" });

    expect(runner.runPhase).not.toHaveBeenCalled();
    expect(accountErasureDatabaseMocks.markAccountErasureFailed).not.toHaveBeenCalled();
  });

  it("exposes durable phase progress and atomically finalizes a retained request", async () => {
    const runner = phaseRunner(async (phase, execution) => {
      if (phase !== "processor_erasure") return null;
      await execution.loadCheckpointDetails("ingest_fence");
      await execution.loadProgress();
      await execution.saveProgress({ deletionHandle: "processor-job-1" });
      return { verified: true };
    });
    accountErasureDatabaseMocks.loadAccountErasurePhaseProgress.mockResolvedValue({
      deletionHandle: "processor-job-1",
    });

    await expect(
      processAccountErasureRequest(
        database,
        request.id,
        "worker-1",
        runner,
        new Date("2026-08-25T12:00:00.001Z"),
      ),
    ).resolves.toEqual({ status: "completed" });

    expect(accountErasureDatabaseMocks.loadAccountErasureCheckpointDetails).toHaveBeenCalledWith(
      database,
      request.id,
      "ingest_fence",
    );
    expect(accountErasureDatabaseMocks.loadAccountErasurePhaseProgress).toHaveBeenCalledWith(
      database,
      request.id,
      "processor_erasure",
    );
    expect(accountErasureDatabaseMocks.saveAccountErasurePhaseProgress).toHaveBeenCalledWith(
      database,
      request.id,
      "worker-1",
      "processor_erasure",
      { deletionHandle: "processor-job-1" },
    );
    expect(accountErasureDatabaseMocks.completeAccountErasure).toHaveBeenCalledWith(
      database,
      request.id,
      "worker-1",
      new Date("2026-08-25T12:00:00.001Z"),
    );
  });

  it("scrubs identifying request fields through the lease-owned transaction", async () => {
    const runner = phaseRunner(async (phase, execution) => {
      if (phase === "request_pii_scrub") {
        await execution.scrubPii();
      }
      return null;
    });

    await expect(
      processAccountErasureRequest(
        database,
        request.id,
        "worker-1",
        runner,
        new Date("2026-08-03T12:00:00.000Z"),
      ),
    ).resolves.toMatchObject({
      status: "waiting",
      waitReason: "retention",
    });

    expect(accountErasureDatabaseMocks.scrubAccountErasureRequestPii).toHaveBeenCalledWith(
      database,
      request.id,
      request.userId,
      "worker-1",
    );
  });

  it("returns the post-profile-delete WAL boundary for durable phase checkpointing", async () => {
    let profileCheckpoint: Record<string, unknown> | null = null;
    const runner = phaseRunner(async (phase, execution) => {
      if (phase !== "postgres_profile_delete") return null;
      profileCheckpoint = await execution.deleteProfile();
      return profileCheckpoint;
    });

    await expect(
      processAccountErasureRequest(
        database,
        request.id,
        "worker-1",
        runner,
        new Date("2026-08-03T12:00:00.000Z"),
      ),
    ).resolves.toMatchObject({
      status: "waiting",
      waitReason: "retention",
    });

    expect(profileCheckpoint).toEqual({ walLsn: "0/1A2B" });
    expect(accountErasureDatabaseMocks.deleteAccountErasureUserProfile).toHaveBeenCalledWith(
      database,
      request.id,
      request.userId,
      "worker-1",
    );
    expect(accountErasureDatabaseMocks.markAccountErasurePhaseCompleted).toHaveBeenCalledWith(
      database,
      request.id,
      "worker-1",
      "postgres_profile_delete",
      { walLsn: "0/1A2B" },
    );
  });

  it("runs retention verification from a pseudonymous request without raw account identifiers", async () => {
    const retainedRequest: ClaimedAccountErasureRequest = {
      ...request,
      encryptedRemoteSnapshot: null,
      piiScrubbedAt: new Date("2026-08-03T12:00:00.000Z"),
      userId: null,
    };
    accountErasureDatabaseMocks.claimAccountErasureRequest.mockResolvedValue(retainedRequest);
    accountErasureDatabaseMocks.loadAccountErasureCheckpoints.mockResolvedValue(
      new Set([
        "ingest_fence",
        "stripe_erasure",
        "work_purge",
        "consumer_drain",
        "remote_revocation",
        "processor_erasure",
        "postgres_erasure",
        "clickhouse_initial",
        "archive_initial",
        "work_verification",
        "consumer_drain_verification",
        "stripe_erasure_verification",
        "remote_revocation_verification",
        "processor_erasure_verification",
        "postgres_profile_delete",
        "peerdb_drain_verification",
        "clickhouse_verification",
        "archive_verification",
        "request_pii_scrub",
      ]),
    );
    const runner = phaseRunner(async (phase, execution) => {
      expect(phase).toBe("retention_verification");
      expect(execution.request).toEqual(retainedRequest);
      expect(execution.request.userId).toBeNull();
      expect(execution.request.encryptedRemoteSnapshot).toBeNull();
      return { verified: true };
    });

    await expect(
      processAccountErasureRequest(
        database,
        request.id,
        "worker-1",
        runner,
        new Date("2026-08-26T12:00:00.000Z"),
      ),
    ).resolves.toEqual({ status: "completed" });

    expect(runner.runPhase).toHaveBeenCalledOnce();
    expect(accountErasureDatabaseMocks.scrubAccountErasureRequestPii).not.toHaveBeenCalled();
  });

  it("persists a distinct retention wait after active-store deletion", async () => {
    const runner = phaseRunner();

    await expect(
      processAccountErasureRequest(
        database,
        request.id,
        "worker-1",
        runner,
        new Date("2026-08-03T12:00:00.000Z"),
      ),
    ).resolves.toEqual({
      retryAt: new Date("2026-08-24T12:00:00.000Z"),
      status: "waiting",
      waitReason: "retention",
    });

    expect(accountErasureDatabaseMocks.markAccountErasureWaiting).toHaveBeenCalledWith(
      database,
      request.id,
      "worker-1",
      new Date("2026-08-24T12:00:00.000Z"),
      "retention",
    );
    expect(accountErasureDatabaseMocks.completeAccountErasure).not.toHaveBeenCalled();
  });

  it("renews the durable lease while a destructive phase is running", async () => {
    vi.useFakeTimers();
    let finishPhase: () => void = () => {
      throw new Error("phase release was not initialized");
    };
    const phaseBlocked = new Promise<void>((resolve) => {
      finishPhase = resolve;
    });
    const runner = phaseRunner(async () => {
      await phaseBlocked;
      return null;
    });
    const processing = processAccountErasureRequest(
      database,
      request.id,
      "worker-1",
      runner,
      new Date("2026-07-26T12:00:00.000Z"),
    );
    await vi.advanceTimersByTimeAsync(60_000);

    expect(accountErasureDatabaseMocks.renewAccountErasureLease).toHaveBeenCalledWith(
      database,
      request.id,
      "worker-1",
      5 * 60 * 1_000,
    );

    finishPhase();
    await expect(processing).resolves.toEqual({
      retryAt: request.replayRetainedUntil,
      status: "waiting",
      waitReason: "replay",
    });
  });

  it("reports lease renewal failures without sending account details to telemetry", async () => {
    vi.useFakeTimers();
    const privateFailureDetail = `${request.userId}:private-lease-state`;
    accountErasureDatabaseMocks.renewAccountErasureLease.mockRejectedValue(
      new Error(privateFailureDetail),
    );
    let finishPhase: () => void = () => {
      throw new Error("phase release was not initialized");
    };
    const phaseBlocked = new Promise<void>((resolve) => {
      finishPhase = resolve;
    });
    const processing = processAccountErasureRequest(
      database,
      request.id,
      "worker-1",
      phaseRunner(async () => {
        await phaseBlocked;
        return null;
      }),
      new Date("2026-07-26T12:00:00.000Z"),
    );

    await vi.advanceTimersByTimeAsync(60_000);
    finishPhase();

    await expect(processing).rejects.toThrow(
      "Account erasure failed and its retry state could not be fully persisted",
    );
    expect(sentryMocks.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Account erasure phase failed",
      }),
      {
        tags: {
          accountErasurePhase: "lease_heartbeat",
          errorName: "Error",
          source: "account-erasure-request",
        },
      },
    );
    expect(JSON.stringify(sentryMocks.captureException.mock.calls)).not.toContain(
      privateFailureDetail,
    );
  });

  it("persists retry state when an effect fails", async () => {
    const privateFailureDetail = `${request.userId}:private-provider-token`;
    const failure = new Error(`processor deletion failed for ${privateFailureDetail}`);
    const runner = phaseRunner(async (phase) => {
      if (phase === "processor_erasure") throw failure;
      return null;
    });

    await expect(
      processAccountErasureRequest(
        database,
        request.id,
        "worker-1",
        runner,
        new Date("2026-07-26T12:00:00.000Z"),
      ),
    ).rejects.toThrow("initial account erasure");

    expect(accountErasureDatabaseMocks.markAccountErasureFailed).toHaveBeenCalledWith(
      database,
      request.id,
      "worker-1",
      "Account erasure processing failed; retry scheduled",
    );
    expect(accountErasureDatabaseMocks.markAccountErasureFailed).toHaveBeenCalledOnce();
    expect(accountErasureDatabaseMocks.completeAccountErasure).not.toHaveBeenCalled();
    expect(sentryMocks.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Account erasure phase failed",
      }),
      {
        tags: {
          accountErasurePhase: "processor_erasure",
          errorName: "Error",
          source: "account-erasure-request",
        },
      },
    );
    expect(JSON.stringify(sentryMocks.captureException.mock.calls)).not.toContain(
      privateFailureDetail,
    );
  });

  it("does not persist a processor or provider error message that may contain account PII", async () => {
    const privateEmail = "private-account@example.test";
    accountErasureDatabaseMocks.loadAccountErasureCheckpoints.mockResolvedValue(
      new Set([
        "ingest_fence",
        "stripe_erasure",
        "work_purge",
        "consumer_drain",
        "remote_revocation",
        "processor_erasure",
        "postgres_erasure",
        "clickhouse_initial",
        "archive_initial",
      ]),
    );
    const runner = phaseRunner(async (phase) => {
      if (phase === "work_verification") {
        throw new Error(`Remote processor rejected ${privateEmail}`);
      }
      return null;
    });

    await expect(
      processAccountErasureRequest(
        database,
        request.id,
        "worker-1",
        runner,
        request.replayRetainedUntil,
      ),
    ).rejects.toThrow(privateEmail);

    expect(accountErasureDatabaseMocks.markAccountErasureFailed).toHaveBeenCalledWith(
      database,
      request.id,
      "worker-1",
      "Account erasure processing failed; retry scheduled",
    );
    expect(
      JSON.stringify(accountErasureDatabaseMocks.markAccountErasureFailed.mock.calls),
    ).not.toContain(privateEmail);
  });

  it("reports coordinator failures without sending account details to telemetry", async () => {
    const privateFailureDetail = `${request.userId}:private-coordinator-state`;
    accountErasureDatabaseMocks.loadAccountErasureCheckpoints.mockRejectedValue(
      new Error(privateFailureDetail),
    );

    await expect(
      processAccountErasureRequest(database, request.id, "worker-1", phaseRunner()),
    ).rejects.toThrow(privateFailureDetail);

    expect(sentryMocks.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Account erasure phase failed",
      }),
      {
        tags: {
          accountErasurePhase: "coordination",
          errorName: "Error",
          source: "account-erasure-request",
        },
      },
    );
    expect(JSON.stringify(sentryMocks.captureException.mock.calls)).not.toContain(
      privateFailureDetail,
    );
  });

  it("reports retry-state persistence failures without sending account details to telemetry", async () => {
    const privateFailureDetail = `${request.userId}:private-retry-state`;
    accountErasureDatabaseMocks.loadAccountErasureCheckpoints.mockRejectedValue(
      new Error("coordinator failure"),
    );
    accountErasureDatabaseMocks.markAccountErasureFailed.mockRejectedValue(
      new Error(privateFailureDetail),
    );

    await expect(
      processAccountErasureRequest(database, request.id, "worker-1", phaseRunner()),
    ).rejects.toThrow("retry state could not be fully persisted");

    expect(sentryMocks.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Account erasure phase failed",
      }),
      {
        tags: {
          accountErasurePhase: "retry_state",
          errorName: "Error",
          source: "account-erasure-request",
        },
      },
    );
    expect(JSON.stringify(sentryMocks.captureException.mock.calls)).not.toContain(
      privateFailureDetail,
    );
  });
});
