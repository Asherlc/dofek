import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountErasureRemoteSnapshot } from "../account-erasure/remote-snapshot.ts";
import type { ClaimedAccountErasureRequest } from "../db/account-erasure-processing.ts";
import {
  type AccountErasurePhaseRunnerDependencies,
  createAccountErasurePhaseRunner,
} from "./account-erasure-phase-runner.ts";
import type { AccountErasurePhaseExecution } from "./process-account-erasure-request.ts";

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

const snapshot: AccountErasureRemoteSnapshot = {
  appleCredentials: [],
  authIdentities: [],
  externalEffects: [],
  localIdentifiers: {
    activityIds: ["30000000-0000-4000-8000-000000001994"],
    exportObjects: [],
    fileUploads: [],
    processingOperationIds: ["40000000-0000-4000-8000-000000001994"],
    sessionIds: [],
    sleepSessionIds: [],
    userId: request.userId ?? "missing-user",
  },
  posthogDistinctId: request.userId ?? "missing-user",
  processorEmails: ["person@example.test"],
  providerConnections: [],
  stripe: null,
  webhooks: [],
};
const peerDbStagingBoundary = {
  cutoff: "2026-08-03T12:00:00.000Z",
  eTag: '"peerdb-boundary-etag"',
  key: `account-erasure-boundaries/${request.id}`,
  mirrors: [
    {
      name: "dofek_fitness_raw_analytics",
      status: "STATUS_PAUSED" as const,
    },
  ],
};

function dependencies(): AccountErasurePhaseRunnerDependencies {
  return {
    assertConsumersDrained: vi.fn().mockResolvedValue(undefined),
    assertPeerDbDrained: vi.fn().mockResolvedValue(undefined),
    assertQuarantineExpired: vi.fn().mockResolvedValue(undefined),
    assertReplayExpired: vi.fn().mockResolvedValue(undefined),
    captureHighWatermarks: vi.fn().mockResolvedValue([{ low: "10", offset: "20", partition: 0 }]),
    captureQuarantineHighWatermarks: vi
      .fn()
      .mockResolvedValue([{ low: "4", offset: "12", partition: 0 }]),
    capturePeerDbStagingBoundary: vi.fn().mockResolvedValue(peerDbStagingBoundary),
    decryptSnapshot: vi.fn().mockResolvedValue(snapshot),
    eraseArchive: vi
      .fn()
      .mockResolvedValue({ lastKey: null, objectsRewritten: 0, recordsRemoved: 0 }),
    eraseClickHouse: vi.fn().mockResolvedValue(undefined),
    erasePostgres: vi.fn().mockResolvedValue(undefined),
    eraseProcessors: vi.fn().mockResolvedValue({ processors: 2 }),
    eraseStripe: vi.fn().mockResolvedValue({
      customersDeleted: 0,
      subscriptionsCanceled: 0,
    }),
    fenceIngest: vi.fn().mockResolvedValue(undefined),
    now: vi.fn(() => new Date("2026-08-26T12:00:00.000Z")),
    purgeWork: vi.fn().mockResolvedValue(undefined),
    revokeRemote: vi.fn().mockResolvedValue([
      {
        disposition: "remote_revoked",
        providerId: "strava",
      },
    ]),
    verifyBackupRetention: vi.fn().mockResolvedValue({ deletedObjects: 3 }),
    verifyProcessorRetention: vi.fn().mockResolvedValue({
      axiomRetentionDays: 30,
      sentryRetentionVerified: true,
    }),
    verifyPeerDbStagingRetention: vi.fn().mockResolvedValue({
      lifecycleRetentionDays: 1,
      multipartUploadsInspected: 0,
      objectsInspected: 2,
      verified: true,
    }),
    verifyProcessors: vi.fn().mockResolvedValue({ processors: 2 }),
  };
}

function execution(
  overrides: Partial<AccountErasurePhaseExecution> = {},
): AccountErasurePhaseExecution {
  return {
    deleteProfile: vi.fn().mockResolvedValue({ walLsn: "0/1A2B" }),
    loadCheckpointDetails: vi.fn().mockResolvedValue(null),
    loadProgress: vi.fn().mockResolvedValue(null),
    request,
    saveProgress: vi.fn().mockResolvedValue(undefined),
    scrubPii: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createAccountErasurePhaseRunner", () => {
  it("captures the ingest boundary before draining consumers", async () => {
    const deps = dependencies();
    const runner = createAccountErasurePhaseRunner(deps);
    const run = execution({
      loadCheckpointDetails: vi.fn().mockResolvedValue({
        highWatermarks: [{ low: "10", offset: "20", partition: 0 }],
      }),
    });

    await expect(runner.runPhase("ingest_fence", run)).resolves.toEqual({
      highWatermarks: [{ low: "10", offset: "20", partition: 0 }],
    });
    await expect(runner.runPhase("consumer_drain", run)).resolves.toEqual({
      quarantineHighWatermarks: [{ low: "4", offset: "12", partition: 0 }],
    });

    expect(deps.fenceIngest).toHaveBeenCalledWith(snapshot);
    expect(deps.fenceIngest).toHaveBeenCalledBefore(vi.mocked(deps.captureHighWatermarks));
    expect(run.loadCheckpointDetails).toHaveBeenCalledWith("ingest_fence");
    expect(deps.assertConsumersDrained).toHaveBeenCalledWith([
      { low: "10", offset: "20", partition: 0 },
    ]);
    expect(deps.assertConsumersDrained).toHaveBeenCalledBefore(
      vi.mocked(deps.captureQuarantineHighWatermarks),
    );
  });

  it("resumes an initial archive sweep but restarts final verification from the beginning", async () => {
    const deps = dependencies();
    vi.mocked(deps.eraseArchive)
      .mockImplementationOnce(async (_snapshot, options) => {
        await options.onObjectCompleted?.("metric-stream/v1/2026/07/part-2.jsonl.gz");
        return {
          lastKey: "metric-stream/v1/2026/07/part-2.jsonl.gz",
          objectsRewritten: 1,
          recordsRemoved: 4,
        };
      })
      .mockResolvedValueOnce({
        lastKey: "metric-stream/v1/2026/07/part-3.jsonl.gz",
        objectsRewritten: 1,
        recordsRemoved: 1,
      })
      .mockResolvedValueOnce({
        lastKey: "metric-stream/v1/2026/07/part-3.jsonl.gz",
        objectsRewritten: 0,
        recordsRemoved: 0,
      });
    const run = execution({
      loadProgress: vi.fn().mockResolvedValue({
        lastKey: "metric-stream/v1/2026/07/part-1.jsonl.gz",
      }),
    });
    const runner = createAccountErasurePhaseRunner(deps);

    await expect(runner.runPhase("archive_initial", run)).resolves.toMatchObject({
      recordsRemoved: 4,
    });
    expect(deps.eraseArchive).toHaveBeenNthCalledWith(
      1,
      snapshot,
      expect.objectContaining({
        startAfter: "metric-stream/v1/2026/07/part-1.jsonl.gz",
      }),
    );
    expect(run.saveProgress).toHaveBeenCalledWith({
      lastKey: "metric-stream/v1/2026/07/part-2.jsonl.gz",
    });

    await expect(runner.runPhase("archive_verification", run)).resolves.toEqual({
      objectsRewritten: 1,
      recordsRemoved: 1,
      verified: true,
    });
    expect(deps.eraseArchive).toHaveBeenNthCalledWith(
      2,
      snapshot,
      expect.objectContaining({ startAfter: undefined }),
    );
    expect(deps.eraseArchive).toHaveBeenNthCalledWith(
      3,
      snapshot,
      expect.objectContaining({ startAfter: undefined }),
    );
  });

  it("persists PostHog deletion targets through lease-owned phase progress", async () => {
    const deps = dependencies();
    const posthogPersonUuid = "50000000-0000-4000-8000-000000001994";
    const run = execution({
      loadProgress: vi.fn().mockResolvedValue({
        posthogPersonUuids: [posthogPersonUuid],
      }),
    });
    vi.mocked(deps.eraseProcessors).mockImplementation(async (_snapshot, progress) => {
      expect(progress.knownPosthogPersonUuids).toEqual([posthogPersonUuid]);
      await progress.savePosthogPersonUuids([posthogPersonUuid]);
      return { processors: 2 };
    });
    const runner = createAccountErasurePhaseRunner(deps);

    await expect(runner.runPhase("processor_erasure", run)).resolves.toEqual({
      processors: 2,
    });

    expect(run.loadProgress).toHaveBeenCalledOnce();
    expect(run.saveProgress).toHaveBeenCalledWith({
      posthogPersonUuids: [posthogPersonUuid],
    });
  });

  it("executes the PII scrub through the lease-owned request operation", async () => {
    const deps = dependencies();
    const run = execution();
    const runner = createAccountErasurePhaseRunner(deps);

    await expect(runner.runPhase("request_pii_scrub", run)).resolves.toBeNull();

    expect(run.scrubPii).toHaveBeenCalledOnce();
    expect(deps.decryptSnapshot).not.toHaveBeenCalled();
  });

  it("checkpoints a post-profile-delete WAL boundary and requires PeerDB to reach it", async () => {
    const deps = dependencies();
    const run = execution({
      loadCheckpointDetails: vi.fn(async (phase) =>
        phase === "postgres_profile_delete" ? { walLsn: "0/1A2B" } : null,
      ),
    });
    const runner = createAccountErasurePhaseRunner(deps);

    await expect(runner.runPhase("postgres_erasure", run)).resolves.toBeNull();
    await expect(runner.runPhase("postgres_profile_delete", run)).resolves.toEqual({
      walLsn: "0/1A2B",
    });
    await expect(runner.runPhase("peerdb_drain_verification", run)).resolves.toEqual({
      stagingBoundary: peerDbStagingBoundary,
      verified: true,
    });

    expect(run.deleteProfile).toHaveBeenCalledOnce();
    expect(run.loadCheckpointDetails).toHaveBeenCalledWith("postgres_profile_delete");
    expect(deps.assertPeerDbDrained).toHaveBeenCalledWith(snapshot, "0/1A2B");
    expect(deps.assertPeerDbDrained).toHaveBeenCalledBefore(
      vi.mocked(deps.capturePeerDbStagingBoundary),
    );
    expect(deps.capturePeerDbStagingBoundary).toHaveBeenCalledWith({
      loadProgress: run.loadProgress,
      requestId: request.id,
      saveProgress: run.saveProgress,
    });
    expect(deps.verifyPeerDbStagingRetention).not.toHaveBeenCalled();
  });

  it("fails closed instead of falling back to the pre-profile WAL checkpoint", async () => {
    const deps = dependencies();
    const run = execution({
      loadCheckpointDetails: vi.fn(async (phase) =>
        phase === "postgres_erasure" ? { walLsn: "0/1A2B" } : null,
      ),
    });
    const runner = createAccountErasurePhaseRunner(deps);

    await expect(runner.runPhase("peerdb_drain_verification", run)).rejects.toThrow();

    expect(run.loadCheckpointDetails).toHaveBeenCalledWith("postgres_profile_delete");
    expect(deps.assertPeerDbDrained).not.toHaveBeenCalled();
    expect(deps.capturePeerDbStagingBoundary).not.toHaveBeenCalled();
  });

  it("does not retain a decrypted snapshot between phase invocations", async () => {
    const deps = dependencies();
    const runner = createAccountErasurePhaseRunner(deps);
    const run = execution();

    await runner.runPhase("stripe_erasure", run);
    await runner.runPhase("remote_revocation", run);

    expect(deps.decryptSnapshot).toHaveBeenCalledTimes(2);
  });

  it("checkpoints one explicit disposition per provider connection", async () => {
    const deps = dependencies();
    vi.mocked(deps.revokeRemote).mockResolvedValue([
      {
        disposition: "no_remote_authorization",
        providerId: "strong-csv",
      },
      {
        disposition: "remote_revoked",
        providerId: "strava",
      },
    ]);
    const runner = createAccountErasurePhaseRunner(deps);

    await expect(runner.runPhase("remote_revocation", execution())).resolves.toEqual({
      dispositions: [
        {
          disposition: "no_remote_authorization",
          providerId: "strong-csv",
        },
        {
          disposition: "remote_revoked",
          providerId: "strava",
        },
      ],
      verified: false,
    });
  });

  it("rechecks Stripe after replay retention and records verification", async () => {
    const deps = dependencies();
    vi.mocked(deps.eraseStripe)
      .mockResolvedValueOnce({
        customersDeleted: 1,
        subscriptionsCanceled: 0,
      })
      .mockResolvedValueOnce({
        customersDeleted: 0,
        subscriptionsCanceled: 0,
      });
    const runner = createAccountErasurePhaseRunner(deps);
    const run = execution();

    await expect(runner.runPhase("stripe_erasure_verification", run)).resolves.toEqual({
      customersDeleted: 1,
      subscriptionsCanceled: 0,
      verified: true,
    });

    expect(deps.decryptSnapshot).toHaveBeenCalledOnce();
    expect(deps.eraseStripe).toHaveBeenCalledTimes(2);
    expect(deps.eraseStripe).toHaveBeenNthCalledWith(1, snapshot);
    expect(deps.eraseStripe).toHaveBeenNthCalledWith(2, snapshot);
  });

  it("fails Stripe verification when the exhaustive proof pass still finds remote state", async () => {
    const deps = dependencies();
    vi.mocked(deps.eraseStripe)
      .mockResolvedValueOnce({
        customersDeleted: 1,
        subscriptionsCanceled: 0,
      })
      .mockResolvedValueOnce({
        customersDeleted: 1,
        subscriptionsCanceled: 0,
      });
    const runner = createAccountErasurePhaseRunner(deps);

    await expect(runner.runPhase("stripe_erasure_verification", execution())).rejects.toThrow(
      "Stripe account erasure verification found new remote state",
    );
  });

  it("runs retention-only work without decrypting or passing a raw user identifier", async () => {
    const deps = dependencies();
    const retainedRequest: ClaimedAccountErasureRequest = {
      ...request,
      encryptedRemoteSnapshot: null,
      piiScrubbedAt: new Date("2026-08-03T12:00:00.000Z"),
      userId: null,
    };
    const runner = createAccountErasurePhaseRunner(deps);

    const retainedExecution = execution({
      loadCheckpointDetails: vi.fn(async (phase) =>
        phase === "consumer_drain"
          ? {
              quarantineHighWatermarks: [{ low: "4", offset: "12", partition: 0 }],
            }
          : phase === "peerdb_drain_verification"
            ? { stagingBoundary: peerDbStagingBoundary, verified: true }
            : null,
      ),
      request: retainedRequest,
    });

    await expect(runner.runPhase("retention_verification", retainedExecution)).resolves.toEqual({
      backupRetention: { deletedObjects: 3 },
      processorRetention: {
        axiomRetentionDays: 30,
        sentryRetentionVerified: true,
      },
      peerDbStagingRetention: {
        lifecycleRetentionDays: 1,
        multipartUploadsInspected: 0,
        objectsInspected: 2,
        verified: true,
      },
      quarantineRetentionVerified: true,
      verified: true,
    });

    expect(deps.decryptSnapshot).not.toHaveBeenCalled();
    expect(retainedExecution.loadCheckpointDetails).toHaveBeenCalledWith("consumer_drain");
    expect(retainedExecution.loadCheckpointDetails).toHaveBeenCalledWith(
      "peerdb_drain_verification",
    );
    expect(deps.assertQuarantineExpired).toHaveBeenCalledWith([
      { low: "4", offset: "12", partition: 0 },
    ]);
    expect(deps.verifyBackupRetention).toHaveBeenCalledWith({
      now: new Date("2026-08-26T12:00:00.000Z"),
      piiScrubbedAt: retainedRequest.piiScrubbedAt,
      requestId: retainedRequest.id,
      requestedAt: retainedRequest.requestedAt,
    });
    expect(deps.verifyProcessorRetention).toHaveBeenCalledWith({
      now: new Date("2026-08-26T12:00:00.000Z"),
      piiScrubbedAt: retainedRequest.piiScrubbedAt,
      requestId: retainedRequest.id,
      requestedAt: retainedRequest.requestedAt,
    });
    expect(deps.verifyPeerDbStagingRetention).toHaveBeenCalledWith({
      cutoff: new Date(peerDbStagingBoundary.cutoff),
      now: new Date("2026-08-26T12:00:00.000Z"),
    });
    expect(JSON.stringify(vi.mocked(deps.verifyBackupRetention).mock.calls)).not.toContain(
      request.userId,
    );
  });

  it("blocks final completion while a pre-boundary quarantine payload remains", async () => {
    const deps = dependencies();
    const retainedRequest: ClaimedAccountErasureRequest = {
      ...request,
      encryptedRemoteSnapshot: null,
      piiScrubbedAt: new Date("2026-08-03T12:00:00.000Z"),
      userId: null,
    };
    const quarantineError = new Error("Account erasure quarantine data remains in partition(s): 0");
    vi.mocked(deps.assertQuarantineExpired).mockRejectedValue(quarantineError);
    const runner = createAccountErasurePhaseRunner(deps);

    await expect(
      runner.runPhase(
        "retention_verification",
        execution({
          loadCheckpointDetails: vi.fn(async (phase) =>
            phase === "consumer_drain"
              ? {
                  quarantineHighWatermarks: [{ low: "4", offset: "12", partition: 0 }],
                }
              : null,
          ),
          request: retainedRequest,
        }),
      ),
    ).rejects.toBe(quarantineError);

    expect(deps.verifyProcessorRetention).not.toHaveBeenCalled();
    expect(deps.verifyBackupRetention).not.toHaveBeenCalled();
  });

  it("fails closed when an identifying phase receives a scrubbed request", async () => {
    const deps = dependencies();
    const runner = createAccountErasurePhaseRunner(deps);

    await expect(
      runner.runPhase(
        "postgres_erasure",
        execution({
          request: {
            ...request,
            encryptedRemoteSnapshot: null,
            piiScrubbedAt: new Date("2026-08-03T12:00:00.000Z"),
            userId: null,
          },
        }),
      ),
    ).rejects.toThrow(
      "Identifying account-erasure phase postgres_erasure requires live request PII",
    );
  });

  it("executes every verification-only phase and records its proof", async () => {
    const deps = dependencies();
    const runner = createAccountErasurePhaseRunner(deps);
    const ingestCheckpoint = {
      highWatermarks: [{ low: "10", offset: "20", partition: 0 }],
    };

    await expect(runner.runPhase("work_purge", execution())).resolves.toEqual({ verified: false });
    await expect(runner.runPhase("work_verification", execution())).resolves.toEqual({
      verified: true,
    });
    await expect(
      runner.runPhase(
        "consumer_drain_verification",
        execution({ loadCheckpointDetails: vi.fn(async () => ingestCheckpoint) }),
      ),
    ).resolves.toEqual({ drained: true, replayExpired: true });
    await expect(runner.runPhase("remote_revocation_verification", execution())).resolves.toEqual({
      dispositions: [{ disposition: "remote_revoked", providerId: "strava" }],
      verified: true,
    });
    await expect(runner.runPhase("clickhouse_verification", execution())).resolves.toEqual({
      verified: true,
    });
    await expect(
      runner.runPhase(
        "processor_erasure_verification",
        execution({
          loadCheckpointDetails: vi.fn(async (phase) =>
            phase === "processor_erasure" ? { posthogPersonUuids: [] } : null,
          ),
        }),
      ),
    ).resolves.toEqual({ processors: 2, verified: true });

    expect(deps.assertReplayExpired).toHaveBeenCalledWith(ingestCheckpoint.highWatermarks);
    expect(deps.verifyProcessors).toHaveBeenCalledWith(
      snapshot,
      { posthogPersonUuids: [] },
      expect.anything(),
    );
  });

  it.each([
    ["missing user id", { ...request, userId: null }],
    ["missing encrypted snapshot", { ...request, encryptedRemoteSnapshot: null }],
    ["already scrubbed", { ...request, piiScrubbedAt: new Date() }],
  ])("rejects an identifying phase with %s", async (_label, invalidRequest) => {
    const runner = createAccountErasurePhaseRunner(dependencies());

    await expect(
      runner.runPhase("stripe_erasure", execution({ request: invalidRequest })),
    ).rejects.toThrow("Identifying account-erasure phase stripe_erasure requires live request PII");
  });

  it("requires a pseudonymous request for retention verification", async () => {
    const runner = createAccountErasurePhaseRunner(dependencies());

    await expect(
      runner.runPhase(
        "retention_verification",
        execution({ request: { ...request, encryptedRemoteSnapshot: null, piiScrubbedAt: null } }),
      ),
    ).rejects.toThrow("Account-erasure retention verification requires a pseudonymous request");
  });
});
