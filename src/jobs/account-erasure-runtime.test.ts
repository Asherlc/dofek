import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountErasureRemoteSnapshot } from "../account-erasure/remote-snapshot.ts";
import type { ClaimedAccountErasureRequest } from "../db/account-erasure-processing.ts";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import { createDatabase } from "../db/index.ts";
import type { AccountErasurePhaseExecution } from "./process-account-erasure-request.ts";

const mocks = vi.hoisted(() => ({
  configureBrokerStorage: vi.fn(),
  assertBrokerStorageExpired: vi.fn(async () => undefined),
  withOwner: vi.fn(
    async (
      _database: unknown,
      client: ClickHouseClient,
      _input: unknown,
      operation: (owner: { client: ClickHouseClient }) => Promise<unknown>,
    ) => operation({ client }),
  ),
  assertPeerDbDrained: vi.fn(async () => undefined),
  assertConsumersDrained: vi.fn(async () => undefined),
  captureHighWatermarks: vi.fn(async (_admin: unknown, _topic: string) => [
    { low: "0", offset: "42", partition: 0 },
  ]),
  captureQuarantineHighWatermarks: vi.fn(async (_admin: unknown, _topic: string) => [
    { low: "0", offset: "7", partition: 0 },
  ]),
  assertQuarantineExpired: vi.fn(async () => undefined),
  assertReplayExpired: vi.fn(async () => undefined),
  closeKafka: vi.fn(async () => undefined),
  connectKafka: vi.fn(async () => undefined),

  captureBrokerStorage: vi.fn(
    async (
      topic: string,
      captureOffsets: () => Promise<Array<{ low: string; offset: string; partition: number }>>,
    ) => {
      const generations: Record<string, string> = {
        "metric-stream-v1": "AAAAAAAAAAAAAAAAAAAAAA",
        "metric-stream-live-v2": "BBBBBBBBBBBBBBBBBBBBBB",
        "metric-stream-history-v2": "CCCCCCCCCCCCCCCCCCCCCC",
        "metric-stream-v1.quarantine.v1": "aaaaaaaaaaaaaaaaaaaaaa",
        "metric-stream-live-v2.quarantine.v1": "bbbbbbbbbbbbbbbbbbbbbb",
        "metric-stream-history-v2.quarantine.v1": "cccccccccccccccccccccc",
      };
      const topicId = generations[topic];
      if (!topicId) throw new Error(`Unexpected capture topic: ${topic}`);
      return (await captureOffsets()).map((entry) => ({
        ...entry,
        clusterId: "0000000000000000000000",
        topicId,
      }));
    },
  ),
  capturePeerDbStagingBoundary: vi.fn(async () => ({
    cutoff: "2026-08-03T12:00:00.000Z",
    eTag: '"boundary-etag"',
    key: "account-erasure-boundaries/10000000-0000-4000-8000-000000001994",
    mirrors: [{ name: "dofek_fitness_raw_analytics", status: "STATUS_PAUSED" }],
  })),
  captureWalLsn: vi.fn(async () => "0/1A2B"),
  closePeerDbStaging: vi.fn(),
  decryptSnapshot: vi.fn(),
  ensureProvidersRegistered: vi.fn(async () => undefined),
  eraseArchive: vi.fn(async () => ({
    lastKey: null,
    objectsRewritten: 0,
    recordsRemoved: 0,
  })),
  eraseClickHouse: vi.fn(async () => undefined),
  prepareIdentifiers: vi.fn(async () => undefined),
  readIdentifierPage: vi.fn(
    async (
      _family?: unknown,
      _after?: string,
    ): Promise<{
      entries: Array<{ key: string; value: string }>;
      nextCursor: string | null;
    }> => ({
      entries: [{ key: "a".repeat(64), value: "40000000-0000-4000-8000-000000001994" }],
      nextCursor: null,
    }),
  ),
  assertIdentifierClosure: vi.fn(async (_stage?: "initial" | "final") => undefined),
  identifierStoreCreated: vi.fn((_database?: unknown, _input?: unknown) => undefined),
  loadPhysicalProgress: vi.fn(
    async (
      _stage?: "initial" | "final",
    ): Promise<{
      step: "apply";
      afterIntentKey: null;
      pending: null;
    } | null> => ({
      step: "apply",
      afterIntentKey: null,
      pending: null,
    }),
  ),
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
  phaseRunnerShouldFail: false,
}));

vi.mock("../account-erasure/kafka-log-storage.ts", () => ({
  KafkaLogStorage: class {
    constructor(admin: unknown, paths: unknown) {
      mocks.configureBrokerStorage(admin, paths);
    }
    assertExpired = mocks.assertBrokerStorageExpired;
    capture = mocks.captureBrokerStorage;
  },
}));

vi.mock("../analytics/analytics-query-owner.ts", () => ({
  ANALYTICS_PUBLICATION_RESOURCE: "metric-stream-source",
  withAnalyticsQueryOwner: mocks.withOwner,
}));
const ownerDatabase = createDatabase("postgres://unit:unit@localhost/unit");
afterAll(async () => ownerDatabase.$client.end());

vi.mock("./account-erasure-phase-runner.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./account-erasure-phase-runner.ts")>();
  return {
    ...actual,
    createAccountErasurePhaseRunner: (
      dependencies: Parameters<typeof actual.createAccountErasurePhaseRunner>[0],
    ) => {
      if (mocks.phaseRunnerShouldFail) {
        throw new Error("phase runner unavailable");
      }
      return actual.createAccountErasurePhaseRunner(dependencies);
    },
  };
});

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
  prepareClickHouseAccountErasure: mocks.prepareIdentifiers,
}));

vi.mock("../account-erasure/identifier-store.ts", () => ({
  ACCOUNT_ERASURE_IDENTIFIER_PAGE_SIZE: 500,
  AccountErasureIdentifierStore: class {
    constructor(database: unknown, input: unknown) {
      mocks.identifierStoreCreated(database, input);
    }
    readPage(family: unknown, after?: string) {
      return mocks.readIdentifierPage(family, after);
    }
    loadPhysicalProgress(stage: "initial" | "final") {
      return mocks.loadPhysicalProgress(stage);
    }
    assertClosureComplete(stage: "initial" | "final") {
      return mocks.assertIdentifierClosure(stage);
    }
  },
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

vi.mock("../account-erasure/redpanda-drain.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../account-erasure/redpanda-drain.ts")>();
  return {
    ...actual,
    assertAccountErasureConsumersDrained: mocks.assertConsumersDrained,
    assertAccountErasureQuarantineExpired: mocks.assertQuarantineExpired,
    assertAccountErasureReplayExpired: mocks.assertReplayExpired,
    captureAccountErasureHighWatermarks: mocks.captureHighWatermarks,
    captureAccountErasureQuarantineHighWatermarks: mocks.captureQuarantineHighWatermarks,
    createAccountErasureRedpandaAdminFromEnv: vi.fn((env: NodeJS.ProcessEnv = process.env) => {
      const brokers = env.REDPANDA_BROKERS?.split(",")
        .map((broker) => broker.trim())
        .filter(Boolean);
      if (!brokers?.length) {
        throw new Error("REDPANDA_BROKERS is required for account erasure");
      }
      return {
        admin: { name: "kafka-admin" },
        close: mocks.closeKafka,
        connect: mocks.connectKafka,
        routes: [
          {
            topic: "metric-stream-v1",
            consumerGroups: ["metric-stream-clickhouse-sink", "metric-stream-r2-archive"],
          },
          {
            topic: "metric-stream-live-v2",
            consumerGroups: ["metric-stream-live-clickhouse-sink", "metric-stream-live-r2-archive"],
          },
          {
            topic: "metric-stream-history-v2",
            consumerGroups: [
              "metric-stream-history-clickhouse-sink",
              "metric-stream-history-r2-archive",
            ],
          },
        ],
      };
    }),
  };
});

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
    exportObjects: [],
    fileUploads: [],
    sessionIds: [],
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
    leaseOwner: "runtime-fixture-worker",
    deleteProfile: vi.fn(async () => ({ walLsn: "0/1A2B" })),
    loadCheckpointDetails,
    loadProgress: vi.fn(async () => null),
    request: claimedRequest,
    persistProviderCredentials: vi.fn(async () => undefined),
    saveProgress: vi.fn(async () => undefined),
    scrubPii: vi.fn(async () => undefined),
  };
}

function mockClickHouse() {
  return {
    exec: vi.fn<ClickHouseClient["exec"]>(),
    command: vi.fn(async () => undefined),
    insert: vi.fn(async () => undefined),
    query: vi.fn(async () => ({ json: async () => [] })),
  };
}

const retainedRequest: ClaimedAccountErasureRequest = {
  ...request,
  encryptedRemoteSnapshot: null,
  piiScrubbedAt: new Date("2026-08-03T12:00:00.000Z"),
  userId: null,
};

const peerDbDrainCheckpoint = {
  stagingBoundary: {
    cutoff: "2026-08-03T12:00:00.000Z",
    eTag: '"boundary-etag"',
    key: "account-erasure-boundaries/10000000-0000-4000-8000-000000001994",
    mirrors: [{ name: "dofek_fitness_raw_analytics", status: "STATUS_PAUSED" as const }],
  },
  verified: true,
};

async function retentionLoadCheckpointDetails(
  phase: Parameters<AccountErasurePhaseExecution["loadCheckpointDetails"]>[0],
) {
  if (phase === "consumer_drain") {
    return {
      quarantineHighWatermarks: [
        { topic: "metric-stream-v1", low: "0", offset: "7", partition: 0 },
        { topic: "metric-stream-live-v2", low: "0", offset: "7", partition: 0 },
        { topic: "metric-stream-history-v2", low: "0", offset: "7", partition: 0 },
      ],
    };
  }
  if (phase === "ingest_fence")
    return {
      highWatermarks: [
        { topic: "metric-stream-v1", low: "0", offset: "42", partition: 0 },
        { topic: "metric-stream-live-v2", low: "0", offset: "42", partition: 0 },
        { topic: "metric-stream-history-v2", low: "0", offset: "42", partition: 0 },
      ],
    };
  if (phase === "peerdb_drain_verification") {
    return peerDbDrainCheckpoint;
  }
  return null;
}

describe("createAccountErasureRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.phaseRunnerShouldFail = false;
    process.env.REDPANDA_BROKERS = "kafka.test:9092";
    process.env.METRIC_STREAM_LEGACY_TOPIC = "metric-stream-v1";
    process.env.METRIC_STREAM_LIVE_TOPIC = "metric-stream-live-v2";
    process.env.METRIC_STREAM_HISTORY_TOPIC = "metric-stream-history-v2";
    mocks.r2Client.send.mockResolvedValue({ Contents: [], IsTruncated: false });
  });

  it("captures Kafka high-watermarks and drains consumer groups per route", async () => {
    mocks.decryptSnapshot.mockResolvedValue(snapshot);
    const database = {
      $client: ownerDatabase.$client,
      execute: vi.fn(async () => []),
      transaction: vi.fn(),
    };
    const clickhouse = {
      exec: vi.fn<ClickHouseClient["exec"]>(),
      command: vi.fn(async () => undefined),
      insert: vi.fn(async () => undefined),
      query: vi.fn(async () => ({ json: async () => [] })),
    };
    const runtime = await createAccountErasureRuntime(database, clickhouse, {
      close: vi.fn(async () => undefined),
      purge: vi.fn(async () => undefined),
    });
    try {
      const topics = ["metric-stream-v1", "metric-stream-live-v2", "metric-stream-history-v2"];
      const highWatermarks = topics.map((topic, index) => ({
        topic,
        low: "0",
        offset: "42",
        partition: 0,
        clusterId: "0000000000000000000000",
        topicId: ["AAAAAAAAAAAAAAAAAAAAAA", "BBBBBBBBBBBBBBBBBBBBBB", "CCCCCCCCCCCCCCCCCCCCCC"][
          index
        ],
      }));
      const quarantineHighWatermarks = topics.map((topic, index) => ({
        topic,
        low: "0",
        offset: "7",
        partition: 0,
        clusterId: "0000000000000000000000",
        topicId: ["aaaaaaaaaaaaaaaaaaaaaa", "bbbbbbbbbbbbbbbbbbbbbb", "cccccccccccccccccccccc"][
          index
        ],
      }));

      await expect(runtime.phaseRunner.runPhase("ingest_fence", execution())).resolves.toEqual({
        highWatermarks,
      });
      expect(mocks.configureBrokerStorage).toHaveBeenCalledWith(
        { name: "kafka-admin" },
        {
          directory: "/var/lib/dofek/kafka-data",
          brokerDirectory: "/var/lib/kafka/data",
          retiredDirectory: "/var/lib/dofek/retired-broker-data",
          topics: topics.flatMap((topic) => [topic, `${topic}.quarantine.v1`]),
        },
      );
      expect(mocks.connectKafka).toHaveBeenCalledOnce();
      expect(mocks.captureHighWatermarks).toHaveBeenCalledTimes(3);

      await expect(
        runtime.phaseRunner.runPhase(
          "consumer_drain",
          execution(async (phase) => (phase === "ingest_fence" ? { highWatermarks } : null)),
        ),
      ).resolves.toEqual({
        drained: true,
        quarantineHighWatermarks,
      });
      expect(mocks.assertConsumersDrained).toHaveBeenCalledTimes(3);
      expect(mocks.captureQuarantineHighWatermarks).toHaveBeenCalledTimes(3);
      expect(mocks.assertConsumersDrained).toHaveBeenCalledWith(
        { name: "kafka-admin" },
        "metric-stream-v1",
        [highWatermarks[0]],
        ["metric-stream-clickhouse-sink", "metric-stream-r2-archive"],
      );
      expect(mocks.withOwner).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          resourceId: "metric-stream-source",
          intentId: `account-erasure:${request.id}:prepare-identities:initial`,
        }),
        expect.any(Function),
      );
      expect(mocks.prepareIdentifiers).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          requestId: request.id,
          leaseOwner: "runtime-fixture-worker",
          stage: "initial",
        }),
      );
      expect(mocks.identifierStoreCreated).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          requestId: request.id,
          leaseOwner: "runtime-fixture-worker",
          pageSize: 500,
        }),
      );

      await expect(
        runtime.phaseRunner.runPhase(
          "consumer_drain",
          execution(async (phase) =>
            phase === "ingest_fence" ? { highWatermarks: highWatermarks.slice(0, 2) } : null,
          ),
        ),
      ).rejects.toThrow("Account erasure checkpoint is missing topic metric-stream-history-v2");
    } finally {
      await runtime.close();
      expect(mocks.closeKafka).toHaveBeenCalledOnce();
    }
  });

  it("prepares ClickHouse identifiers and drains PeerDB with staging boundary capture", async () => {
    mocks.decryptSnapshot.mockResolvedValue(snapshot);
    const workPurger = {
      close: vi.fn(async () => undefined),
      purge: vi.fn(async () => undefined),
    };
    const runtime = await createAccountErasureRuntime(ownerDatabase, mockClickHouse(), workPurger);
    try {
      await expect(
        runtime.phaseRunner.runPhase(
          "peerdb_drain_verification",
          execution(async (phase) =>
            phase === "postgres_profile_delete" ? { walLsn: "0/ABCD" } : null,
          ),
        ),
      ).resolves.toEqual({
        stagingBoundary: expect.objectContaining({
          key: peerDbDrainCheckpoint.stagingBoundary.key,
        }),
        verified: true,
      });
      expect(mocks.assertIdentifierClosure).toHaveBeenCalledWith("initial");
      expect(mocks.loadPhysicalProgress).toHaveBeenCalledWith("initial");
      expect(mocks.assertPeerDbDrained).toHaveBeenCalledWith(
        ownerDatabase,
        expect.anything(),
        "0/ABCD",
        expect.objectContaining({
          userId: request.userId,
          store: expect.anything(),
        }),
      );
      expect(mocks.capturePeerDbStagingBoundary).toHaveBeenCalledWith(
        ownerDatabase,
        mocks.peerDbMirrorApi,
        mocks.peerDbStagingStorage,
        expect.objectContaining({ requestId: request.id }),
      );

      await expect(
        runtime.phaseRunner.runPhase("clickhouse_initial", execution()),
      ).resolves.toEqual({ verified: false });
      expect(mocks.withOwner).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          resourceId: "metric-stream-source",
          intentId: `account-erasure:${request.id}:erase:initial`,
        }),
        expect.any(Function),
      );
      expect(mocks.eraseClickHouse).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          requestId: request.id,
          leaseOwner: "runtime-fixture-worker",
          stage: "initial",
        }),
      );

      await expect(
        runtime.phaseRunner.runPhase("archive_initial", execution()),
      ).resolves.toMatchObject({ objectsRewritten: 0, recordsRemoved: 0 });
      expect(mocks.eraseArchive).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          userId: request.userId,
          stage: "initial",
          store: expect.anything(),
        }),
        expect.objectContaining({ onObjectCompleted: expect.any(Function) }),
      );
    } finally {
      await runtime.close();
      expect(mocks.closeKafka).toHaveBeenCalledOnce();
      expect(workPurger.close).toHaveBeenCalledOnce();
    }
  });

  it("closes Kafka during startup cleanup when phase-runner wiring fails", async () => {
    mocks.phaseRunnerShouldFail = true;
    try {
      await expect(
        createAccountErasureRuntime(ownerDatabase, mockClickHouse(), {
          close: vi.fn(async () => undefined),
          purge: vi.fn(async () => undefined),
        }),
      ).rejects.toThrow("phase runner unavailable");
      expect(mocks.connectKafka).toHaveBeenCalledOnce();
      expect(mocks.closeKafka).toHaveBeenCalledOnce();
    } finally {
      mocks.phaseRunnerShouldFail = false;
    }
  });

  it("pages ClickHouse fence identifiers and fences each page's operation values", async () => {
    const pageOneValue = "40000000-0000-4000-8000-000000001001";
    const pageTwoValue = "40000000-0000-4000-8000-000000001002";
    mocks.readIdentifierPage
      .mockResolvedValueOnce({
        entries: [{ key: "a".repeat(64), value: pageOneValue }],
        nextCursor: "cursor-page-1",
      })
      .mockResolvedValueOnce({
        entries: [{ key: "b".repeat(64), value: pageTwoValue }],
        nextCursor: null,
      });
    const runtime = await createAccountErasureRuntime(ownerDatabase, mockClickHouse(), {
      close: vi.fn(async () => undefined),
      purge: vi.fn(async () => undefined),
    });
    try {
      await runtime.phaseRunner.runPhase("ingest_fence", execution());
      expect(mocks.readIdentifierPage).toHaveBeenNthCalledWith(1, "operation", undefined);
      expect(mocks.readIdentifierPage).toHaveBeenNthCalledWith(2, "operation", "cursor-page-1");
      expect(mocks.fenceClickHouse).toHaveBeenNthCalledWith(1, expect.anything(), request.userId, [
        pageOneValue,
      ]);
      expect(mocks.fenceClickHouse).toHaveBeenNthCalledWith(2, expect.anything(), request.userId, [
        pageTwoValue,
      ]);
      expect(mocks.withOwner).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          resourceId: "metric-stream-source",
          intentId: `account-erasure:${request.id}:fence`,
        }),
        expect.any(Function),
      );
    } finally {
      await runtime.close();
    }
  });

  it("fails closed when identifier physical preparation is incomplete", async () => {
    mocks.loadPhysicalProgress.mockResolvedValueOnce(null);
    const runtime = await createAccountErasureRuntime(ownerDatabase, mockClickHouse(), {
      close: vi.fn(async () => undefined),
      purge: vi.fn(async () => undefined),
    });
    try {
      await expect(runtime.phaseRunner.runPhase("clickhouse_initial", execution())).rejects.toThrow(
        "Account erasure physical preparation is incomplete",
      );
      expect(mocks.assertIdentifierClosure).toHaveBeenCalledWith("initial");
      expect(mocks.loadPhysicalProgress).toHaveBeenCalledWith("initial");
      expect(mocks.eraseClickHouse).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
    }
  });

  it("completes retention verification after broker storage and existing retention checks", async () => {
    const runtime = await createAccountErasureRuntime(ownerDatabase, mockClickHouse(), {
      close: vi.fn(async () => undefined),
      purge: vi.fn(async () => undefined),
    });
    try {
      await expect(
        runtime.phaseRunner.runPhase(
          "retention_verification",
          execution(retentionLoadCheckpointDetails, retainedRequest),
        ),
      ).resolves.toEqual({
        backupRetention: { deletedObjects: 2 },
        peerDbStagingRetention: {
          lifecycleRetentionDays: 1,
          multipartUploadsInspected: 0,
          objectsInspected: 2,
          verified: true,
        },
        processorRetention: {
          axiomRetentionDays: 30,
          sentryRetentionDays: 30,
        },
        quarantineRetentionVerified: true,
        verified: true,
      });
      expect(mocks.verifyPeerDbStagingRetention).toHaveBeenCalledWith(
        mocks.peerDbStagingStorage,
        expect.objectContaining({
          cutoff: new Date(peerDbDrainCheckpoint.stagingBoundary.cutoff),
          now: expect.any(Date),
        }),
      );
      expect(mocks.assertBrokerStorageExpired).toHaveBeenCalledWith([
        ...["metric-stream-v1", "metric-stream-live-v2", "metric-stream-history-v2"].map(
          (topic) => ({ topic, low: "0", offset: "42", partition: 0 }),
        ),
        ...["metric-stream-v1", "metric-stream-live-v2", "metric-stream-history-v2"].map(
          (topic) => ({ topic: `${topic}.quarantine.v1`, low: "0", offset: "7", partition: 0 }),
        ),
      ]);
      expect(mocks.assertBrokerStorageExpired).toHaveBeenCalledBefore(
        vi.mocked(mocks.verifyBackupRetention),
      );
      expect(mocks.verifyBackupRetention).toHaveBeenCalled();
      expect(mocks.verifyProcessorRetention).toHaveBeenCalled();
    } finally {
      await runtime.close();
    }
  });

  it("fails closed when required REDPANDA_BROKERS configuration is missing", async () => {
    delete process.env.REDPANDA_BROKERS;
    await expect(
      createAccountErasureRuntime(ownerDatabase, mockClickHouse(), {
        close: vi.fn(async () => undefined),
        purge: vi.fn(async () => undefined),
      }),
    ).rejects.toThrow(/REDPANDA_BROKERS is required for account erasure/);
  });

  it("fails closed when required REDPANDA_BROKERS configuration is blank", async () => {
    process.env.REDPANDA_BROKERS = "   ";
    await expect(
      createAccountErasureRuntime(ownerDatabase, mockClickHouse(), {
        close: vi.fn(async () => undefined),
        purge: vi.fn(async () => undefined),
      }),
    ).rejects.toThrow(/REDPANDA_BROKERS is required for account erasure/);
  });
});
