import { EventEmitter, once } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountErasureRouteHighWatermark } from "../account-erasure/redpanda-drain.ts";
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

function dependencies(): AccountErasurePhaseRunnerDependencies {
  return {
    assertBrokerStorageExpired: vi.fn().mockResolvedValue(undefined),
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

  it("captures quarantine only after the serving consumers finish draining", async () => {
    const deps = dependencies();
    const barrier = new EventEmitter();
    const started = once(barrier, "started");
    const drained = once(barrier, "drained");
    vi.mocked(deps.assertConsumersDrained).mockImplementationOnce(async () => {
      barrier.emit("started");
      await drained;
    });
    const runner = createAccountErasurePhaseRunner(deps);
    const pending = runner.runPhase(
      "consumer_drain",
      execution({ loadCheckpointDetails: vi.fn().mockResolvedValue({ highWatermarks }) }),
    );
    await started;
    expect(deps.captureQuarantineHighWatermarks).not.toHaveBeenCalled();
    barrier.emit("drained");
    await expect(pending).resolves.toMatchObject({ quarantineHighWatermarks: highWatermarks });
    expect(deps.captureQuarantineHighWatermarks).toHaveBeenCalledOnce();
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
      expect.objectContaining({ stage: "initial" }),
      expect.objectContaining({ startAfter: "metric-stream/v1/2026/07/part-1.jsonl.gz" }),
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

  it("verifies broker storage before completing retention checks", async () => {
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
      quarantineRetentionVerified: true,
      verified: true,
    });

    expect(deps.verifyBackupRetention).toHaveBeenCalled();
    expect(deps.assertBrokerStorageExpired).toHaveBeenCalledWith([
      ...highWatermarks,
      ...highWatermarks.map((entry) => ({ ...entry, topic: `${entry.topic}.quarantine.v1` })),
    ]);
    expect(deps.assertBrokerStorageExpired).toHaveBeenCalledBefore(
      vi.mocked(deps.verifyBackupRetention),
    );
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
  it("blocks final completion when logically expired broker bytes still exist", async () => {
    const deps = dependencies();
    const failure = new Error("Kafka retains segment before erasure boundary");
    vi.mocked(deps.assertBrokerStorageExpired).mockRejectedValue(failure);
    const runner = createAccountErasurePhaseRunner(deps);
    const run = execution({
      request: {
        ...request,
        encryptedRemoteSnapshot: null,
        userId: null,
        piiScrubbedAt: new Date(),
      },
      loadCheckpointDetails: vi.fn(async (phase) =>
        phase === "ingest_fence"
          ? {
              highWatermarks: [
                {
                  topic: "metric-stream-v1",
                  partition: 0,
                  low: "0",
                  offset: "10",
                  clusterId: "0000000000000000000000",
                  topicId: "dI2O6HVWQkuC7XgSy7cJ3w",
                },
              ],
            }
          : {
              quarantineHighWatermarks: [
                {
                  topic: "metric-stream-v1",
                  partition: 0,
                  low: "0",
                  offset: "5",
                  clusterId: "0000000000000000000000",
                  topicId: "aaaaaaaaaaaaaaaaaaaaaa",
                },
              ],
            },
      ),
    });
    await expect(runner.runPhase("retention_verification", run)).rejects.toThrow(failure);
    expect(deps.assertBrokerStorageExpired).toHaveBeenCalledWith([
      expect.objectContaining({
        topic: "metric-stream-v1",
        offset: "10",
        topicId: "dI2O6HVWQkuC7XgSy7cJ3w",
      }),
      expect.objectContaining({
        topic: "metric-stream-v1.quarantine.v1",
        offset: "5",
        topicId: "aaaaaaaaaaaaaaaaaaaaaa",
      }),
    ]);
    expect(deps.verifyBackupRetention).not.toHaveBeenCalled();
  });
});
