import { describe, expect, it, vi } from "vitest";
import type { AccountErasureRemoteSnapshot } from "../account-erasure/remote-snapshot.ts";
import type { ClaimedAccountErasureRequest } from "../db/account-erasure-processing.ts";
import type { AccountErasurePhaseExecution } from "./process-account-erasure-request.ts";

const mocks = vi.hoisted(() => ({
  assertConsumersDrained: vi.fn(async () => undefined),
  assertPeerDbDrained: vi.fn(async () => undefined),
  assertQuarantineExpired: vi.fn(async () => undefined),
  assertReplayExpired: vi.fn(async () => undefined),
  captureHighWatermarks: vi.fn(async () => [{ low: "1", offset: "3", partition: 0 }]),
  captureQuarantineHighWatermarks: vi.fn(async () => [{ low: "4", offset: "12", partition: 0 }]),
  capturePeerDbStagingBoundary: vi.fn(async () => ({
    cutoff: "2026-08-03T12:00:00.000Z",
    eTag: '"boundary-etag"',
    key: "account-erasure-boundaries/10000000-0000-4000-8000-000000001994",
    mirrors: [
      {
        name: "dofek_fitness_raw_analytics",
        status: "STATUS_PAUSED",
      },
    ],
  })),
  captureWalLsn: vi.fn(async () => "0/1A2B"),
  closePeerDbStaging: vi.fn(),
  closeRedpanda: vi.fn(async () => undefined),
  connectRedpanda: vi.fn(async () => undefined),
  decryptSnapshot: vi.fn(),
  ensureProvidersRegistered: vi.fn(async () => undefined),
  eraseArchive: vi.fn(async () => ({
    lastKey: null,
    objectsRewritten: 0,
    recordsRemoved: 0,
  })),
  eraseClickHouse: vi.fn(async () => undefined),
  erasePostgres: vi.fn(async () => undefined),
  eraseProcessors: vi.fn(async () => ({ processor: "queued" })),
  eraseStripe: vi.fn(async () => ({
    customersDeleted: 0,
    subscriptionsCanceled: 0,
  })),
  fenceClickHouse: vi.fn(async () => undefined),
  getAllProviders: vi.fn(() => [{ id: "test-provider" }]),
  peerDbStagingStorage: { name: "peerdb-staging-storage" },
  peerDbMirrorApi: { name: "peerdb-mirror-api" },
  revokeRemote: vi.fn(async () => []),
  r2Client: {
    destroy: vi.fn(),
    send: vi.fn(),
  },
  verifyBackupRetention: vi.fn(async () => ({ deletedObjects: 2 })),
  verifyPeerDbStagingRetention: vi.fn(async () => ({
    lifecycleRetentionDays: 1,
    multipartUploadsInspected: 0,
    objectsInspected: 2,
    verified: true as const,
  })),
  verifyProcessorRetention: vi.fn(async () => ({
    axiomRetentionDays: 30,
    sentryRetentionDays: 30,
  })),
  verifyProcessors: vi.fn(async () => ({ processor: "complete" })),
}));

vi.mock("../r2-storage.ts", () => ({
  createR2Client: vi.fn(() => mocks.r2Client),
  requiredR2EnvironmentVariable: vi.fn((name: string) => `${name.toLowerCase()}-bucket`),
}));

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
}));

vi.mock("../account-erasure/archive-erasure.ts", () => ({
  eraseMetricStreamArchive: mocks.eraseArchive,
  R2MetricStreamArchiveStorage: class {},
}));

vi.mock("../account-erasure/backup-retention.ts", () => ({
  verifyAccountErasureBackupRetention: mocks.verifyBackupRetention,
}));

vi.mock("../account-erasure/database-backup-storage.ts", () => ({
  R2DatabaseBackupStorage: class {},
}));

vi.mock("../account-erasure/clickhouse-erasure.ts", () => ({
  eraseClickHouseAccount: mocks.eraseClickHouse,
  fenceClickHouseAccount: mocks.fenceClickHouse,
}));

vi.mock("../account-erasure/peerdb-erasure.ts", () => ({
  assertPeerDbAccountErasureDrained: mocks.assertPeerDbDrained,
  captureAccountErasurePostgresWalLsn: mocks.captureWalLsn,
}));

vi.mock("../account-erasure/peerdb-staging-writer-barrier.ts", () => ({
  capturePeerDbStagingBoundary: mocks.capturePeerDbStagingBoundary,
}));

vi.mock("../db/clickhouse-cdc.ts", () => ({
  createPeerDbMirrorApiClientFromEnv: vi.fn(() => mocks.peerDbMirrorApi),
}));

vi.mock("../account-erasure/peerdb-staging-retention.ts", () => ({
  createPeerDbStagingStorageFromEnv: vi.fn(() => ({
    close: mocks.closePeerDbStaging,
    storage: mocks.peerDbStagingStorage,
  })),
  verifyPeerDbStagingRetention: mocks.verifyPeerDbStagingRetention,
}));

vi.mock("../account-erasure/processor-erasure.ts", () => ({
  accountErasureProcessorConfigFromEnv: vi.fn(() => ({
    brevoApiKey: "brevo",
    posthogApiHost: "https://posthog.example",
    posthogPersonalApiKey: "posthog",
    posthogProjectId: "1",
  })),
  eraseAccountProcessors: mocks.eraseProcessors,
  verifyAccountProcessors: mocks.verifyProcessors,
}));

vi.mock("../account-erasure/processor-retention.ts", () => ({
  processorRetentionConfigFromEnv: vi.fn(() => ({
    axiomApiToken: "axiom",
    axiomDataset: "logs",
    sentryApiHost: "https://sentry.example",
    sentryAuthToken: "sentry",
    sentryOrg: "org",
  })),
  verifyProcessorRetentionPolicies: mocks.verifyProcessorRetention,
}));

vi.mock("../account-erasure/redpanda-drain.ts", () => ({
  assertAccountErasureConsumersDrained: mocks.assertConsumersDrained,
  assertAccountErasureQuarantineExpired: mocks.assertQuarantineExpired,
  assertAccountErasureReplayExpired: mocks.assertReplayExpired,
  captureAccountErasureHighWatermarks: mocks.captureHighWatermarks,
  captureAccountErasureQuarantineHighWatermarks: mocks.captureQuarantineHighWatermarks,
  createAccountErasureRedpandaAdminFromEnv: vi.fn(() => ({
    admin: { name: "redpanda-admin" },
    close: mocks.closeRedpanda,
    connect: mocks.connectRedpanda,
    topic: "metric-stream-v1",
  })),
}));

vi.mock("../account-erasure/remote-revocation.ts", () => ({
  eraseStripeAccount: mocks.eraseStripe,
  revokeRemoteAccounts: mocks.revokeRemote,
}));

vi.mock("../account-erasure/remote-snapshot.ts", () => ({
  decryptAccountErasureSnapshot: mocks.decryptSnapshot,
}));

vi.mock("../account-erasure/postgres-erasure.ts", () => ({
  erasePostgresAccount: mocks.erasePostgres,
}));

vi.mock("../providers/index.ts", () => ({
  getAllProviders: mocks.getAllProviders,
}));

vi.mock("./provider-registration.ts", () => ({
  ensureProvidersRegistered: mocks.ensureProvidersRegistered,
}));

import { createAccountErasureRuntime } from "./account-erasure-runtime.ts";

const request: ClaimedAccountErasureRequest = {
  completionDeadline: new Date("2026-08-25T12:00:00.000Z"),
  encryptedRemoteSnapshot: "encrypted",
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
    sleepSessionIds: ["50000000-0000-4000-8000-000000001994"],
    userId: request.userId ?? "missing-user",
  },
  posthogDistinctId: "posthog-distinct-1994",
  processorEmails: [],
  providerConnections: [],
  slackInstallations: [],
  stripe: null,
  webhooks: [],
};

function execution(
  loadCheckpointDetails: AccountErasurePhaseExecution["loadCheckpointDetails"] = async () => null,
  claimedRequest: ClaimedAccountErasureRequest = request,
): AccountErasurePhaseExecution {
  return {
    deleteProfile: vi.fn(async () => ({ walLsn: "0/1A2B" })),
    loadCheckpointDetails,
    loadProgress: vi.fn(async () => null),
    request: claimedRequest,
    saveProgress: vi.fn(async () => undefined),
    scrubPii: vi.fn(async () => undefined),
  };
}

describe("createAccountErasureRuntime", () => {
  it("connects concrete production adapters and closes owned resources", async () => {
    mocks.decryptSnapshot.mockResolvedValue(snapshot);
    mocks.closePeerDbStaging.mockClear();
    mocks.r2Client.destroy.mockClear();
    const database = {
      execute: vi.fn(async () => []),
      transaction: vi.fn(),
    };
    const clickHouseClient = {
      command: vi.fn(async () => undefined),
      insert: vi.fn(async () => undefined),
      query: vi.fn(async () => ({ json: async () => [] })),
    };
    const workPurger = {
      close: vi.fn(async () => undefined),
      purge: vi.fn(async () => undefined),
    };
    const runtime = await createAccountErasureRuntime(database, clickHouseClient, workPurger);

    expect(mocks.ensureProvidersRegistered).toHaveBeenCalledOnce();
    expect(mocks.connectRedpanda).toHaveBeenCalledOnce();

    await expect(runtime.phaseRunner.runPhase("ingest_fence", execution())).resolves.toEqual({
      highWatermarks: [{ low: "1", offset: "3", partition: 0 }],
    });
    expect(mocks.fenceClickHouse).toHaveBeenCalledWith(
      clickHouseClient,
      snapshot.localIdentifiers.userId,
      snapshot.localIdentifiers.processingOperationIds,
    );
    await expect(
      runtime.phaseRunner.runPhase(
        "consumer_drain",
        execution(async (phase) =>
          phase === "ingest_fence"
            ? { highWatermarks: [{ low: "1", offset: "3", partition: 0 }] }
            : null,
        ),
      ),
    ).resolves.toEqual({
      quarantineHighWatermarks: [{ low: "4", offset: "12", partition: 0 }],
    });
    expect(mocks.assertConsumersDrained).toHaveBeenCalledWith(
      { name: "redpanda-admin" },
      "metric-stream-v1",
      [{ low: "1", offset: "3", partition: 0 }],
    );
    expect(mocks.captureQuarantineHighWatermarks).toHaveBeenCalledWith(
      { name: "redpanda-admin" },
      "metric-stream-v1",
    );
    await runtime.phaseRunner.runPhase(
      "retention_verification",
      execution(
        async (phase) =>
          phase === "consumer_drain"
            ? {
                quarantineHighWatermarks: [{ low: "4", offset: "12", partition: 0 }],
              }
            : phase === "peerdb_drain_verification"
              ? {
                  stagingBoundary: {
                    cutoff: "2026-08-03T12:00:00.000Z",
                    eTag: '"boundary-etag"',
                    key: `account-erasure-boundaries/${request.id}`,
                    mirrors: [
                      {
                        name: "dofek_fitness_raw_analytics",
                        status: "STATUS_PAUSED",
                      },
                    ],
                  },
                }
              : null,
        {
          ...request,
          encryptedRemoteSnapshot: null,
          piiScrubbedAt: new Date("2026-08-03T12:00:00.000Z"),
          userId: null,
        },
      ),
    );
    expect(mocks.assertQuarantineExpired).toHaveBeenCalledWith(
      { name: "redpanda-admin" },
      "metric-stream-v1",
      [{ low: "4", offset: "12", partition: 0 }],
    );
    expect(mocks.verifyPeerDbStagingRetention).toHaveBeenCalledWith(mocks.peerDbStagingStorage, {
      cutoff: new Date("2026-08-03T12:00:00.000Z"),
      now: expect.any(Date),
    });

    await expect(runtime.phaseRunner.runPhase("clickhouse_initial", execution())).resolves.toEqual({
      verified: false,
    });
    expect(mocks.eraseClickHouse).toHaveBeenCalledWith(clickHouseClient, {
      activityIds: snapshot.localIdentifiers.activityIds,
      operationIds: snapshot.localIdentifiers.processingOperationIds,
      sleepSessionIds: snapshot.localIdentifiers.sleepSessionIds,
      userId: snapshot.localIdentifiers.userId,
    });

    await expect(runtime.phaseRunner.runPhase("archive_initial", execution())).resolves.toEqual({
      objectsRewritten: 0,
      recordsRemoved: 0,
    });
    expect(mocks.eraseArchive).toHaveBeenCalledWith(
      expect.anything(),
      {
        activityIds: new Set(snapshot.localIdentifiers.activityIds),
        operationIds: new Set(snapshot.localIdentifiers.processingOperationIds),
        userId: snapshot.localIdentifiers.userId,
      },
      expect.objectContaining({
        onObjectCompleted: expect.any(Function),
      }),
    );

    await expect(runtime.phaseRunner.runPhase("postgres_erasure", execution())).resolves.toBeNull();
    expect(mocks.erasePostgres).toHaveBeenCalledWith(database, request.id, request.userId);
    expect(mocks.captureWalLsn).not.toHaveBeenCalled();

    await runtime.phaseRunner.runPhase(
      "peerdb_drain_verification",
      execution(async (phase) =>
        phase === "postgres_profile_delete" ? { walLsn: "0/1A2B" } : null,
      ),
    );
    expect(mocks.assertPeerDbDrained).toHaveBeenCalledWith(database, clickHouseClient, "0/1A2B", {
      activityIds: snapshot.localIdentifiers.activityIds,
      operationIds: snapshot.localIdentifiers.processingOperationIds,
      sleepSessionIds: snapshot.localIdentifiers.sleepSessionIds,
      userId: snapshot.localIdentifiers.userId,
    });
    expect(mocks.capturePeerDbStagingBoundary).toHaveBeenCalledWith(
      database,
      mocks.peerDbMirrorApi,
      mocks.peerDbStagingStorage,
      {
        loadProgress: expect.any(Function),
        requestId: request.id,
        saveProgress: expect.any(Function),
      },
    );
    await runtime.close();
    expect(mocks.closePeerDbStaging).toHaveBeenCalledOnce();
    expect(mocks.closeRedpanda).toHaveBeenCalledOnce();
    expect(workPurger.close).toHaveBeenCalledOnce();
    expect(mocks.r2Client.destroy).toHaveBeenCalledOnce();
  });

  it("releases acquired resources when runtime startup fails", async () => {
    const Sentry = await import("@sentry/node");
    const startupError = new Error("Redpanda authentication failed");
    mocks.closePeerDbStaging.mockClear();
    mocks.closeRedpanda.mockClear();
    mocks.r2Client.destroy.mockClear();
    mocks.connectRedpanda.mockRejectedValueOnce(startupError);
    vi.mocked(Sentry.captureException).mockClear();
    const database = {
      execute: vi.fn(async () => []),
      transaction: vi.fn(),
    };
    const clickHouseClient = {
      command: vi.fn(async () => undefined),
      insert: vi.fn(async () => undefined),
      query: vi.fn(async () => ({ json: async () => [] })),
    };
    const workPurger = {
      close: vi.fn(async () => undefined),
      purge: vi.fn(async () => undefined),
    };

    await expect(createAccountErasureRuntime(database, clickHouseClient, workPurger)).rejects.toBe(
      startupError,
    );

    expect(Sentry.captureException).toHaveBeenCalledWith(startupError, {
      tags: { accountErasureStep: "runtimeStartup" },
    });
    expect(mocks.closePeerDbStaging).toHaveBeenCalledOnce();
    expect(mocks.closeRedpanda).toHaveBeenCalledOnce();
    expect(workPurger.close).toHaveBeenCalledOnce();
    expect(mocks.r2Client.destroy).toHaveBeenCalledOnce();
  });

  it("reports startup cleanup failures without hiding the original cause", async () => {
    const Sentry = await import("@sentry/node");
    const startupError = new Error("Redpanda authentication failed");
    const cleanupError = new Error("Redpanda disconnect failed");
    mocks.closePeerDbStaging.mockClear();
    mocks.closeRedpanda.mockClear();
    mocks.r2Client.destroy.mockClear();
    mocks.connectRedpanda.mockRejectedValueOnce(startupError);
    mocks.closeRedpanda.mockRejectedValueOnce(cleanupError);
    vi.mocked(Sentry.captureException).mockClear();
    const database = {
      execute: vi.fn(async () => []),
      transaction: vi.fn(),
    };
    const clickHouseClient = {
      command: vi.fn(async () => undefined),
      insert: vi.fn(async () => undefined),
      query: vi.fn(async () => ({ json: async () => [] })),
    };
    const workPurger = {
      close: vi.fn(async () => undefined),
      purge: vi.fn(async () => undefined),
    };

    await expect(
      createAccountErasureRuntime(database, clickHouseClient, workPurger),
    ).rejects.toMatchObject({
      cause: startupError,
      errors: [startupError, cleanupError],
      message: "Account erasure runtime startup and cleanup failed",
    });

    expect(Sentry.captureException).toHaveBeenCalledWith(cleanupError, {
      tags: { accountErasureStep: "runtimeStartupCleanup" },
    });
    expect(mocks.closePeerDbStaging).toHaveBeenCalledOnce();
    expect(mocks.r2Client.destroy).toHaveBeenCalledOnce();
  });
});
