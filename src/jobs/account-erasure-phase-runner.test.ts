import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountErasureRouteHighWatermark } from "../account-erasure/kafka-drain.ts";
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
    exportObjects: [],
    fileUploads: [],
    sessionIds: [],
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

const highWatermarks: AccountErasureRouteHighWatermark[] = [
  {
    topic: "metric-stream-live-v2",
    partition: 0,
    low: "0",
    offset: "42",
  },
];

const stockAck = {
  kind: "stock_physical_maintenance_ack" as const,
  runId: "maintenance-2026-11-05",
  operator: "oncall@example.com",
  verifiedAt: "2026-08-26T11:00:00.000Z",
  verifiedCutoffAt: "2026-08-26T10:00:00.000Z",
  runbookRevision: "docs/account-erasure.md#physical",
};

function dependencies(): AccountErasurePhaseRunnerDependencies {
  return {
    prepareIdentifiers: vi.fn().mockResolvedValue(undefined),
    assertIdentifiersReady: vi.fn().mockResolvedValue(undefined),
    assertConsumersDrained: vi.fn().mockResolvedValue(undefined),
    assertQuarantineExpired: vi.fn().mockResolvedValue(undefined),
    assertReplayExpired: vi.fn().mockResolvedValue(undefined),
    captureQuarantineHighWatermarks: vi.fn().mockResolvedValue(highWatermarks),
    assertPeerDbDrained: vi.fn().mockResolvedValue(undefined),
    captureHighWatermarks: vi.fn().mockResolvedValue(highWatermarks),
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
    loadIngestFenceCompletedAt: vi.fn().mockResolvedValue(new Date("2026-08-26T09:00:00.000Z")),
    loadStockPhysicalMaintenanceAck: vi.fn().mockResolvedValue(stockAck),
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
    leaseOwner: "phase-fixture-worker",
    deleteProfile: vi.fn().mockResolvedValue({ walLsn: "0/1A2B" }),
    loadCheckpointDetails: vi.fn().mockResolvedValue(null),
    loadProgress: vi.fn().mockResolvedValue(null),
    request,
    persistProviderCredentials: vi.fn().mockResolvedValue(undefined),
    saveProgress: vi.fn().mockResolvedValue(undefined),
    scrubPii: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("createAccountErasurePhaseRunner", () => {
  it("prepares complete initial identity closure after drain and before completing its checkpoint", async () => {
    const deps = dependencies();
    const run = execution({
      loadCheckpointDetails: vi.fn().mockResolvedValue({ highWatermarks }),
    });
    vi.mocked(deps.prepareIdentifiers).mockRejectedValueOnce(
      new Error("identity closure incomplete"),
    );
    await expect(
      createAccountErasurePhaseRunner(deps).runPhase("consumer_drain", run),
    ).rejects.toThrow("identity closure incomplete");
    expect(deps.assertConsumersDrained).toHaveBeenCalledWith(highWatermarks);
    expect(deps.prepareIdentifiers).toHaveBeenCalledWith({
      requestId: request.id,
      userId: request.userId,
      leaseOwner: "phase-fixture-worker",
      stage: "initial",
    });
  });

  it.each([
    "remote_revocation",
    "processor_erasure",
    "postgres_erasure",
    "clickhouse_initial",
    "archive_initial",
    "postgres_profile_delete",
    "archive_verification",
  ] as const)("refuses %s effects without its durable identity closure proof", async (phase) => {
    const deps = dependencies();
    vi.mocked(deps.assertIdentifiersReady).mockRejectedValueOnce(
      new Error("identity closure incomplete"),
    );
    const run = execution();
    await expect(createAccountErasurePhaseRunner(deps).runPhase(phase, run)).rejects.toThrow(
      "identity closure incomplete",
    );
    expect(deps.erasePostgres).not.toHaveBeenCalled();
    expect(deps.eraseClickHouse).not.toHaveBeenCalled();
    expect(deps.eraseArchive).not.toHaveBeenCalled();
    expect(deps.eraseProcessors).not.toHaveBeenCalled();
    expect(deps.revokeRemote).not.toHaveBeenCalled();
    expect(run.deleteProfile).not.toHaveBeenCalled();
  });

  it("saves refreshed remote credentials before propagating a deletion failure", async () => {
    const deps = dependencies();
    const run = execution();
    const tokens = {
      accessToken: "rotated",
      refreshToken: "rotated-refresh",
      expiresAt: new Date(),
      scopes: null,
    };
    vi.mocked(deps.revokeRemote).mockImplementation(async (_snapshot, persist) => {
      await persist("garmin", tokens);
      throw new Error("registration deletion failed");
    });
    await expect(
      createAccountErasurePhaseRunner(deps).runPhase("remote_revocation", run),
    ).rejects.toThrow("registration deletion failed");
    expect(run.persistProviderCredentials).toHaveBeenCalledWith("garmin", tokens);
  });

  it("captures the native ingest boundary before draining consumers", async () => {
    const deps = dependencies();
    const runner = createAccountErasurePhaseRunner(deps);
    const run = execution({
      loadCheckpointDetails: vi.fn().mockResolvedValue({ highWatermarks }),
    });

    await expect(runner.runPhase("ingest_fence", run)).resolves.toEqual({ highWatermarks });
    await expect(runner.runPhase("consumer_drain", run)).resolves.toEqual({
      drained: true,
      quarantineHighWatermarks: highWatermarks,
    });

    expect(deps.fenceIngest).toHaveBeenCalledWith({
      requestId: request.id,
      userId: request.userId,
      leaseOwner: "phase-fixture-worker",
    });
    expect(deps.fenceIngest).toHaveBeenCalledBefore(vi.mocked(deps.captureHighWatermarks));
    expect(run.loadCheckpointDetails).toHaveBeenCalledWith("ingest_fence");
    expect(deps.assertConsumersDrained).toHaveBeenCalledWith(highWatermarks);
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
      expect.objectContaining({ stage: "final" }),
      expect.objectContaining({ startAfter: undefined }),
    );
  });

  it("re-asserts native drain during consumer_drain_verification", async () => {
    const deps = dependencies();
    const runner = createAccountErasurePhaseRunner(deps);
    await expect(
      runner.runPhase(
        "consumer_drain_verification",
        execution({ loadCheckpointDetails: vi.fn(async () => ({ highWatermarks })) }),
      ),
    ).resolves.toEqual({ drained: true, replayExpired: true, verified: true });
    expect(deps.assertConsumersDrained).toHaveBeenCalledWith(highWatermarks);
  });

  it("requires stock physical maintenance ack before existing retention checks", async () => {
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
        phase === "ingest_fence"
          ? { highWatermarks }
          : phase === "consumer_drain"
            ? { quarantineHighWatermarks: highWatermarks }
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
      physicalMaintenanceAcknowledged: {
        runId: "maintenance-2026-11-05",
        operator: "oncall@example.com",
        runbookRevision: "docs/account-erasure.md#physical",
      },
      quarantineRetentionVerified: true,
      verified: true,
    });

    expect(deps.loadIngestFenceCompletedAt).toHaveBeenCalledWith({ requestId: request.id });
    expect(deps.loadStockPhysicalMaintenanceAck).toHaveBeenCalledWith({ requestId: request.id });
    expect(deps.verifyBackupRetention).toHaveBeenCalled();
    expect(deps.verifyProcessorRetention).toHaveBeenCalled();
    expect(deps.verifyPeerDbStagingRetention).toHaveBeenCalled();
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

  it("stays pending when stock physical maintenance ack is missing", async () => {
    const deps = dependencies();
    vi.mocked(deps.loadStockPhysicalMaintenanceAck).mockRejectedValue(
      new Error(
        "Stock physical maintenance acknowledgement is missing from retention_verification phase_progress",
      ),
    );
    const retainedRequest: ClaimedAccountErasureRequest = {
      ...request,
      encryptedRemoteSnapshot: null,
      piiScrubbedAt: new Date("2026-08-03T12:00:00.000Z"),
      userId: null,
    };
    await expect(
      createAccountErasurePhaseRunner(deps).runPhase(
        "retention_verification",
        execution({
          loadCheckpointDetails: vi.fn(async (phase) =>
            phase === "consumer_drain"
              ? { quarantineHighWatermarks: highWatermarks }
              : phase === "peerdb_drain_verification"
                ? { stagingBoundary: peerDbStagingBoundary, verified: true }
                : null,
          ),
          request: retainedRequest,
        }),
      ),
    ).rejects.toThrow(/missing from retention_verification/);
    expect(deps.verifyBackupRetention).not.toHaveBeenCalled();
  });

  it("rejects ack whose verifiedCutoffAt precedes durable ingest_fence.completed_at", async () => {
    const deps = dependencies();
    vi.mocked(deps.loadIngestFenceCompletedAt).mockResolvedValue(
      new Date("2026-08-26T11:30:00.000Z"),
    );
    const retainedRequest: ClaimedAccountErasureRequest = {
      ...request,
      encryptedRemoteSnapshot: null,
      piiScrubbedAt: new Date("2026-08-03T12:00:00.000Z"),
      userId: null,
    };
    await expect(
      createAccountErasurePhaseRunner(deps).runPhase(
        "retention_verification",
        execution({
          loadCheckpointDetails: vi.fn(async (phase) =>
            phase === "consumer_drain"
              ? { quarantineHighWatermarks: highWatermarks }
              : phase === "peerdb_drain_verification"
                ? { stagingBoundary: peerDbStagingBoundary, verified: true }
                : null,
          ),
          request: retainedRequest,
        }),
      ),
    ).rejects.toThrow(/cover durable ingest_fence/);
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

    await expect(runner.runPhase("work_purge", execution())).resolves.toEqual({ verified: false });
    await expect(runner.runPhase("work_verification", execution())).resolves.toEqual({
      verified: true,
    });
    await expect(
      runner.runPhase(
        "consumer_drain_verification",
        execution({ loadCheckpointDetails: vi.fn(async () => ({ highWatermarks })) }),
      ),
    ).resolves.toEqual({ drained: true, replayExpired: true, verified: true });
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

    expect(deps.assertConsumersDrained).toHaveBeenCalledWith(highWatermarks);
    expect(deps.verifyProcessors).toHaveBeenCalledWith(
      snapshot,
      { posthogPersonUuids: [] },
      expect.anything(),
    );
  });

  it("re-prepares identifiers only for clickhouse_verification final stage", async () => {
    const deps = dependencies();
    const runner = createAccountErasurePhaseRunner(deps);

    await expect(runner.runPhase("clickhouse_initial", execution())).resolves.toEqual({
      verified: false,
    });
    expect(deps.prepareIdentifiers).not.toHaveBeenCalled();
    expect(deps.eraseClickHouse).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "initial", requestId: request.id }),
    );

    await expect(runner.runPhase("clickhouse_verification", execution())).resolves.toEqual({
      verified: true,
    });
    expect(deps.prepareIdentifiers).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "final", requestId: request.id }),
    );
    expect(deps.eraseClickHouse).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "final", requestId: request.id }),
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
