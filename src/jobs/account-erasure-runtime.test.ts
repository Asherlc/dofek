import { beforeEach, describe, expect, it, vi } from "vitest";
import { KafkaRemoteStorage } from "../account-erasure/kafka-remote-storage.ts";
import type { AccountErasureRemoteSnapshot } from "../account-erasure/remote-snapshot.ts";
import type { ClaimedAccountErasureRequest } from "../db/account-erasure-processing.ts";
import type { AccountErasurePhaseExecution } from "./process-account-erasure-request.ts";

const mocks = vi.hoisted(() => ({
  configureBrokerStorage: vi.fn(),
  configureRemoteHistory: vi.fn(),
  assertNativeDeleted: vi.fn(async (_boundaries: readonly unknown[]) => new Map()),
  metadataConsumer: { name: "native metadata consumer" },
  assertBrokerStorageExpired: vi.fn(async () => undefined),
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
  brokerR2Client: { destroy: vi.fn(), send: vi.fn() },
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

vi.mock("../account-erasure/kafka-log-storage.ts", () => ({
  KafkaLogStorage: class {
    constructor(admin: unknown, paths: unknown, remote: unknown) {
      mocks.configureBrokerStorage(admin, paths, remote);
    }
    assertExpired = mocks.assertBrokerStorageExpired;
    capture(_topic: string, captureOffsets: () => Promise<unknown[]>) {
      return captureOffsets();
    }
  },
}));

vi.mock("../account-erasure/kafka-remote-history.ts", () => ({
  KafkaRemoteHistory: class {
    constructor(admin: unknown, consumer: unknown) {
      mocks.configureRemoteHistory(admin, consumer);
    }
    assertDeleted = mocks.assertNativeDeleted;
  },
}));

vi.mock("../r2-storage.ts", () => ({
  createR2Client: vi.fn((config?: unknown) => (config ? mocks.brokerR2Client : mocks.r2Client)),
  requiredR2EnvironmentVariable: vi.fn((name: string) =>
    name === "KAFKA_TIERED_STORAGE_REGION"
      ? "auto"
      : name === "KAFKA_CLUSTER_ID"
        ? "0000000000000000000000"
        : `${name.toLowerCase()}-bucket`,
  ),
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

vi.mock("../account-erasure/redpanda-drain.ts", async () => ({
  ...(await vi.importActual<typeof import("../account-erasure/redpanda-drain.ts")>(
    "../account-erasure/redpanda-drain.ts",
  )),
  assertAccountErasureConsumersDrained: mocks.assertConsumersDrained,
  assertAccountErasureQuarantineExpired: mocks.assertQuarantineExpired,
  assertAccountErasureReplayExpired: mocks.assertReplayExpired,
  captureAccountErasureHighWatermarks: mocks.captureHighWatermarks,
  captureAccountErasureQuarantineHighWatermarks: mocks.captureQuarantineHighWatermarks,
  createAccountErasureRedpandaAdminFromEnv: vi.fn(() => ({
    admin: { name: "redpanda-admin" },
    close: mocks.closeRedpanda,
    connect: mocks.connectRedpanda,
    createMetadataConsumer: () => mocks.metadataConsumer,
    routes: [
      {
        topic: "metric-stream-v1",
        consumerGroups: ["metric-stream-clickhouse-sink", "metric-stream-r2-archive"],
      },
      {
        topic: "metric-stream-live-v1",
        consumerGroups: ["metric-stream-live-clickhouse-sink", "metric-stream-live-r2-archive"],
      },
      {
        topic: "metric-stream-history-v1",
        consumerGroups: [
          "metric-stream-history-clickhouse-sink",
          "metric-stream-history-r2-archive",
        ],
      },
    ],
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
    persistProviderCredentials: vi.fn(async () => undefined),
    saveProgress: vi.fn(async () => undefined),
    scrubPii: vi.fn(async () => undefined),
  };
}

function runtimeInputs() {
  return {
    database: { execute: vi.fn(async () => []), transaction: vi.fn() },
    clickHouseClient: {
      command: vi.fn(async () => undefined),
      insert: vi.fn(async () => undefined),
      query: vi.fn(async () => ({ json: async () => [] })),
    },
    workPurger: { close: vi.fn(async () => undefined), purge: vi.fn(async () => undefined) },
  };
}

describe("createAccountErasureRuntime", () => {
  beforeEach(() => vi.clearAllMocks());
  it("connects the remote verifier to the dedicated client, native history and consumer factory", async () => {
    const { createR2Client } = await import("../r2-storage.ts");
    vi.mocked(createR2Client).mockClear();
    mocks.assertNativeDeleted.mockClear();
    const inputs = runtimeInputs();
    const runtime = await createAccountErasureRuntime(
      inputs.database,
      inputs.clickHouseClient,
      inputs.workPurger,
    );
    try {
      expect(createR2Client).toHaveBeenCalledWith({
        accessKeyId: "kafka_tiered_storage_access_key_id-bucket",
        secretAccessKey: "kafka_tiered_storage_secret_access_key-bucket",
        endpoint: "kafka_tiered_storage_endpoint-bucket",
      });
      const factory = mocks.configureRemoteHistory.mock.lastCall?.[1];
      expect(factory).toBeTypeOf("function");
      if (typeof factory !== "function") throw new Error("missing metadata consumer factory");
      expect(factory()).toBe(mocks.metadataConsumer);
      const remote = mocks.configureBrokerStorage.mock.lastCall?.[2];
      if (!(remote instanceof KafkaRemoteStorage))
        throw new Error("missing remote storage dependency");
      mocks.brokerR2Client.send.mockResolvedValue({ IsTruncated: false });
      const boundaries = ["metric-stream-v1", "metric-stream-live-v1", "metric-stream-history-v1"]
        .flatMap((topic) => [topic, `${topic}.quarantine.v1`])
        .map((topic) => ({
          topic,
          clusterId: "0000000000000000000000",
          topicId: "dI2O6HVWQkuC7XgSy7cJ3w",
          partition: 0,
          low: "0",
          offset: "0",
        }));
      await expect(remote.assertExpired(boundaries)).resolves.toEqual(new Map());
      expect(mocks.assertNativeDeleted).toHaveBeenCalledWith(boundaries);
    } finally {
      await runtime.close();
    }
  });

  it("rejects an unsupported R2 region and closes acquired resources", async () => {
    const { requiredR2EnvironmentVariable } = await import("../r2-storage.ts");
    const inputs = runtimeInputs();
    await vi.mocked(requiredR2EnvironmentVariable).withImplementation(
      (name) =>
        name === "KAFKA_TIERED_STORAGE_REGION" ? "us-east-1" : `${name.toLowerCase()}-bucket`,
      async () => {
        await expect(
          createAccountErasureRuntime(inputs.database, inputs.clickHouseClient, inputs.workPurger),
        ).rejects.toThrow("REGION must be auto");
      },
    );
    expect(inputs.workPurger.close).toHaveBeenCalledOnce();
  });

  it("closes the dedicated broker client when later native adapter startup fails", async () => {
    const inputs = runtimeInputs();
    mocks.brokerR2Client.destroy.mockClear();
    const error = new Error("native storage mount unavailable");
    mocks.configureBrokerStorage.mockImplementationOnce(() => {
      throw error;
    });
    await expect(
      createAccountErasureRuntime(inputs.database, inputs.clickHouseClient, inputs.workPurger),
    ).rejects.toBe(error);
    expect(mocks.brokerR2Client.destroy).toHaveBeenCalledOnce();
  });
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

    const topics = ["metric-stream-v1", "metric-stream-live-v1", "metric-stream-history-v1"];
    expect(mocks.configureBrokerStorage).toHaveBeenCalledWith(
      { name: "redpanda-admin" },
      {
        directory: "/var/lib/dofek/kafka-data",
        brokerDirectory: "/var/lib/kafka/data",
        retiredDirectories: [
          "/var/lib/dofek/retired-broker-data",
          "/var/lib/dofek/aborted-kafka-data",
        ],
        topics: topics.flatMap((topic) => [topic, `${topic}.quarantine.v1`]),
      },
      expect.any(KafkaRemoteStorage),
    );
    const highWatermarks = topics.map((topic) => ({ topic, low: "1", offset: "3", partition: 0 }));
    const quarantineHighWatermarks = topics.map((topic) => ({
      topic,
      low: "4",
      offset: "12",
      partition: 0,
    }));

    expect(mocks.ensureProvidersRegistered).toHaveBeenCalledOnce();
    expect(mocks.connectRedpanda).toHaveBeenCalledOnce();

    const revocation = execution();
    await expect(runtime.phaseRunner.runPhase("remote_revocation", revocation)).resolves.toEqual({
      dispositions: [],
      verified: false,
    });
    expect(mocks.revokeRemote).toHaveBeenCalledWith(
      snapshot,
      mocks.getAllProviders(),
      revocation.persistProviderCredentials,
    );

    await expect(runtime.phaseRunner.runPhase("ingest_fence", execution())).resolves.toEqual({
      highWatermarks,
    });
    expect(mocks.fenceClickHouse).toHaveBeenCalledWith(
      clickHouseClient,
      snapshot.localIdentifiers.userId,
      snapshot.localIdentifiers.processingOperationIds,
    );
    await expect(
      runtime.phaseRunner.runPhase(
        "consumer_drain",
        execution(async (phase) => (phase === "ingest_fence" ? { highWatermarks } : null)),
      ),
    ).resolves.toEqual({
      quarantineHighWatermarks,
    });
    expect(mocks.assertConsumersDrained).toHaveBeenCalledWith(
      { name: "redpanda-admin" },
      "metric-stream-v1",
      [{ topic: "metric-stream-v1", low: "1", offset: "3", partition: 0 }],
      ["metric-stream-clickhouse-sink", "metric-stream-r2-archive"],
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
                quarantineHighWatermarks,
              }
            : phase === "ingest_fence"
              ? { highWatermarks }
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
      [{ topic: "metric-stream-v1", low: "4", offset: "12", partition: 0 }],
    );
    expect(mocks.assertBrokerStorageExpired).toHaveBeenCalledWith([
      ...highWatermarks,
      ...quarantineHighWatermarks.map((entry) => ({
        ...entry,
        topic: `${entry.topic}.quarantine.v1`,
      })),
    ]);
    expect(mocks.verifyPeerDbStagingRetention).toHaveBeenCalledWith(mocks.peerDbStagingStorage, {
      cutoff: new Date("2026-08-03T12:00:00.000Z"),
      now: expect.any(Date),
    });

    await runtime.phaseRunner.runPhase(
      "consumer_drain_verification",
      execution(async (phase) => (phase === "ingest_fence" ? { highWatermarks } : null)),
    );
    await expect(
      runtime.phaseRunner.runPhase(
        "consumer_drain",
        execution(async (phase) =>
          phase === "ingest_fence" ? { highWatermarks: highWatermarks.slice(0, 2) } : null,
        ),
      ),
    ).rejects.toThrow("Account erasure checkpoint is missing topic metric-stream-history-v1");
    for (const [index, topic] of topics.entries()) {
      const prefix = ["metric-stream", "metric-stream-live", "metric-stream-history"][index];
      expect(mocks.captureHighWatermarks).toHaveBeenCalledWith({ name: "redpanda-admin" }, topic);
      expect(mocks.captureQuarantineHighWatermarks).toHaveBeenCalledWith(
        { name: "redpanda-admin" },
        topic,
      );
      expect(mocks.assertConsumersDrained).toHaveBeenCalledWith(
        { name: "redpanda-admin" },
        topic,
        [highWatermarks[index]],
        [`${prefix}-clickhouse-sink`, `${prefix}-r2-archive`],
      );
      expect(mocks.assertReplayExpired).toHaveBeenCalledWith({ name: "redpanda-admin" }, topic, [
        highWatermarks[index],
      ]);
      expect(mocks.assertQuarantineExpired).toHaveBeenCalledWith(
        { name: "redpanda-admin" },
        topic,
        [quarantineHighWatermarks[index]],
      );
    }

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
    expect(mocks.brokerR2Client.destroy).toHaveBeenCalledOnce();
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
