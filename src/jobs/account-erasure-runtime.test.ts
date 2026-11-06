import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AccountErasureRemoteSnapshot } from "../account-erasure/remote-snapshot.ts";
import type { ClaimedAccountErasureRequest } from "../db/account-erasure-processing.ts";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import { createDatabase } from "../db/index.ts";
import type { AccountErasurePhaseExecution } from "./process-account-erasure-request.ts";

const mocks = vi.hoisted(() => ({
  withOwner: vi.fn(
    async (
      _database: unknown,
      client: ClickHouseClient,
      _input: unknown,
      operation: (owner: { client: ClickHouseClient }) => Promise<unknown>,
    ) => operation({ client }),
  ),
  assertPeerDbDrained: vi.fn(async () => undefined),
  assertSubscriptionsDrained: vi.fn(async () => undefined),
  captureNativeFenceProgress: vi.fn(
    async (_admin: unknown, stream: { epoch: string; topic: string; partition: number }) => ({
      fence: {
        transport: "pulsar" as const,
        state: "empty" as const,
        epoch: stream.epoch,
        topic: stream.topic,
        partition: stream.partition,
      },
    }),
  ),
  resolveNativeDrainStreams: vi.fn(async () => [
    {
      epoch: "transport-epoch",
      topic: "persistent://public/default/legacy",
      partition: -1,
      subscriptions: ["metric-stream-clickhouse-sink", "metric-stream-r2-archive"],
    },
    {
      epoch: "transport-epoch",
      topic: "persistent://public/default/live",
      partition: -1,
      subscriptions: ["metric-stream-live-clickhouse-sink", "metric-stream-live-r2-archive"],
    },
    {
      epoch: "transport-epoch",
      topic: "persistent://public/default/history",
      partition: -1,
      subscriptions: ["metric-stream-history-clickhouse-sink", "metric-stream-history-r2-archive"],
    },
  ]),
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
  loadPhysicalProgress: vi.fn(async (_stage?: "initial" | "final") => ({
    step: "apply" as const,
    afterIntentKey: null,
    pending: null,
  })),
  loadPhaseProgress: vi.fn(async (): Promise<Record<string, unknown> | null> => null),
  loadCheckpointCompletedAt: vi.fn(
    async (): Promise<Date | null> => new Date("2026-08-26T09:00:00.000Z"),
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
}));

vi.mock("../analytics/analytics-query-owner.ts", () => ({
  ANALYTICS_PUBLICATION_RESOURCE: "metric-stream-source",
  withAnalyticsQueryOwner: mocks.withOwner,
}));
const ownerDatabase = createDatabase("postgres://unit:unit@localhost/unit");
afterAll(async () => ownerDatabase.$client.end());

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

vi.mock("../db/account-erasure-processing.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/account-erasure-processing.ts")>();
  return {
    ...actual,
    loadAccountErasureCheckpointCompletedAt: mocks.loadCheckpointCompletedAt,
    loadAccountErasurePhaseProgress: mocks.loadPhaseProgress,
  };
});

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

vi.mock("../metric-stream/pulsar-drain.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../metric-stream/pulsar-drain.ts")>();
  return {
    ...actual,
    assertAccountErasureSubscriptionsDrained: mocks.assertSubscriptionsDrained,
    captureAccountErasureNativeFenceProgress: mocks.captureNativeFenceProgress,
    createPulsarDrainAdminFromUrls: vi.fn(() => ({ name: "pulsar-admin" })),
    resolveAccountErasureNativeDrainStreams: mocks.resolveNativeDrainStreams,
  };
});

vi.mock("../metric-stream/consumer-routes.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../metric-stream/consumer-routes.ts")>();
  return {
    ...actual,
    resolveMetricStreamConsumerRoutes: vi.fn(() => [
      {
        id: "legacy",
        topicKey: "METRIC_STREAM_LEGACY_TOPIC",
        topic: "persistent://public/default/legacy",
        sinkSubscription: "metric-stream-clickhouse-sink",
        archiveSubscription: "metric-stream-r2-archive",
        subscriptions: ["metric-stream-clickhouse-sink", "metric-stream-r2-archive"],
      },
      {
        id: "live",
        topicKey: "METRIC_STREAM_LIVE_TOPIC",
        topic: "persistent://public/default/live",
        sinkSubscription: "metric-stream-live-clickhouse-sink",
        archiveSubscription: "metric-stream-live-r2-archive",
        subscriptions: ["metric-stream-live-clickhouse-sink", "metric-stream-live-r2-archive"],
      },
      {
        id: "history",
        topicKey: "METRIC_STREAM_HISTORY_TOPIC",
        topic: "persistent://public/default/history",
        sinkSubscription: "metric-stream-history-clickhouse-sink",
        archiveSubscription: "metric-stream-history-r2-archive",
        subscriptions: [
          "metric-stream-history-clickhouse-sink",
          "metric-stream-history-r2-archive",
        ],
      },
    ]),
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

const ingestFenceCompletedAt = new Date("2026-08-26T09:00:00.000Z");

function orderedStockPhysicalMaintenanceAck(now: Date = new Date()) {
  const fenceMs = ingestFenceCompletedAt.getTime();
  return {
    kind: "stock_physical_maintenance_ack" as const,
    runId: "maintenance-runtime-fixture",
    operator: "runtime-fixture@example.test",
    verifiedCutoffAt: new Date(fenceMs + 60 * 60 * 1_000).toISOString(),
    verifiedAt: new Date(
      Math.min(now.getTime() - 60_000, fenceMs + 2 * 60 * 60 * 1_000),
    ).toISOString(),
    runbookRevision: "docs/pulsar-remaining-work.md#physical",
  };
}

async function retentionLoadCheckpointDetails(
  phase: Parameters<AccountErasurePhaseExecution["loadCheckpointDetails"]>[0],
) {
  if (phase === "peerdb_drain_verification") {
    return peerDbDrainCheckpoint;
  }
  return null;
}

describe("createAccountErasureRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.PULSAR_ADMIN_URL = "http://pulsar-admin.test";
    process.env.METRIC_STREAM_TRANSPORT_EPOCH = "transport-epoch";
    process.env.METRIC_STREAM_LEGACY_TOPIC = "persistent://public/default/legacy";
    process.env.METRIC_STREAM_LIVE_TOPIC = "persistent://public/default/live";
    process.env.METRIC_STREAM_HISTORY_TOPIC = "persistent://public/default/history";
    mocks.r2Client.send.mockResolvedValue({ Contents: [], IsTruncated: false });
    mocks.loadCheckpointCompletedAt.mockResolvedValue(ingestFenceCompletedAt);
    mocks.loadPhaseProgress.mockResolvedValue(null);
  });

  it("captures native ingest streams and drains with epoch-scoped route identity", async () => {
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
      const ingest = await runtime.phaseRunner.runPhase("ingest_fence", execution());
      expect(mocks.captureNativeFenceProgress).toHaveBeenCalledTimes(3);
      expect(mocks.resolveNativeDrainStreams).toHaveBeenCalledWith(expect.anything(), {
        epoch: "transport-epoch",
        routes: [
          {
            topic: "persistent://public/default/legacy",
            subscriptions: ["metric-stream-clickhouse-sink", "metric-stream-r2-archive"],
          },
          {
            topic: "persistent://public/default/live",
            subscriptions: ["metric-stream-live-clickhouse-sink", "metric-stream-live-r2-archive"],
          },
          {
            topic: "persistent://public/default/history",
            subscriptions: [
              "metric-stream-history-clickhouse-sink",
              "metric-stream-history-r2-archive",
            ],
          },
        ],
      });
      await expect(
        runtime.phaseRunner.runPhase(
          "consumer_drain",
          execution(async (phase) => (phase === "ingest_fence" ? ingest : null)),
        ),
      ).resolves.toEqual({ drained: true });
      expect(mocks.assertSubscriptionsDrained).toHaveBeenCalledTimes(3);
    } finally {
      await runtime.close();
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

  it("rejects drain when checkpoint epoch differs from the current transport epoch", async () => {
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
      const stale = {
        streams: [
          {
            fence: {
              transport: "pulsar" as const,
              state: "empty" as const,
              epoch: "old-epoch",
              topic: "persistent://public/default/history",
              partition: -1,
            },
          },
          {
            fence: {
              transport: "pulsar" as const,
              state: "empty" as const,
              epoch: "old-epoch",
              topic: "persistent://public/default/legacy",
              partition: -1,
            },
          },
          {
            fence: {
              transport: "pulsar" as const,
              state: "empty" as const,
              epoch: "old-epoch",
              topic: "persistent://public/default/live",
              partition: -1,
            },
          },
        ],
      };
      await expect(
        runtime.phaseRunner.runPhase(
          "consumer_drain",
          execution(async (phase) => (phase === "ingest_fence" ? stale : null)),
        ),
      ).rejects.toThrow(/missing route for epoch old-epoch/);
      expect(mocks.assertSubscriptionsDrained).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
    }
  });

  it("rejects same-count drain checkpoints whose stream set differs from resolved routes", async () => {
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
      const different = {
        streams: [
          {
            fence: {
              transport: "pulsar" as const,
              state: "empty" as const,
              epoch: "transport-epoch",
              topic: "persistent://public/default/alpha",
              partition: -1,
            },
          },
          {
            fence: {
              transport: "pulsar" as const,
              state: "empty" as const,
              epoch: "transport-epoch",
              topic: "persistent://public/default/beta",
              partition: -1,
            },
          },
          {
            fence: {
              transport: "pulsar" as const,
              state: "empty" as const,
              epoch: "transport-epoch",
              topic: "persistent://public/default/gamma",
              partition: -1,
            },
          },
        ],
      };
      await expect(
        runtime.phaseRunner.runPhase(
          "consumer_drain",
          execution(async (phase) => (phase === "ingest_fence" ? different : null)),
        ),
      ).rejects.toThrow(/missing route for epoch transport-epoch/);
    } finally {
      await runtime.close();
    }
  });

  it("fails closed when stock physical maintenance ack is missing from phase_progress", async () => {
    mocks.loadPhaseProgress.mockResolvedValue(null);
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
      ).rejects.toThrow(/missing from retention_verification|Stock physical/i);
      expect(mocks.loadCheckpointCompletedAt).toHaveBeenCalledWith(
        ownerDatabase,
        request.id,
        "ingest_fence",
      );
      expect(mocks.loadPhaseProgress).toHaveBeenCalledWith(
        ownerDatabase,
        request.id,
        "retention_verification",
      );
    } finally {
      await runtime.close();
    }
  });

  it("fails closed when durable ingest_fence.completed_at is missing", async () => {
    mocks.loadCheckpointCompletedAt.mockResolvedValue(null);
    mocks.loadPhaseProgress.mockResolvedValue(orderedStockPhysicalMaintenanceAck());
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
      ).rejects.toThrow(/requires durable ingest_fence\.completed_at/);
      expect(mocks.loadPhaseProgress).not.toHaveBeenCalled();
      expect(mocks.verifyBackupRetention).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
    }
  });

  it("rejects stock physical maintenance ack that does not cover ingest_fence.completed_at", async () => {
    // Credible public boundary: fence noon, ack cutoff 10:00 (before fence) must fail closed.
    const fenceCompletedAt = new Date("2026-08-26T12:00:00.000Z");
    const uncoveredAck = {
      kind: "stock_physical_maintenance_ack" as const,
      runId: "maintenance-runtime-fixture",
      operator: "runtime-fixture@example.test",
      verifiedCutoffAt: "2026-08-26T10:00:00.000Z",
      verifiedAt: "2026-08-26T11:00:00.000Z",
      runbookRevision: "docs/pulsar-remaining-work.md#physical",
    };
    mocks.loadCheckpointCompletedAt.mockResolvedValue(fenceCompletedAt);
    mocks.loadPhaseProgress.mockResolvedValue(uncoveredAck);
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
      ).rejects.toThrow(/cover durable ingest_fence/);
      // Prove the runtime actually observed fence noon + uncovered 10:00 cutoff (call order + values).
      expect(mocks.loadCheckpointCompletedAt.mock.invocationCallOrder[0]).toBeLessThan(
        mocks.loadPhaseProgress.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
      );
      await expect(mocks.loadCheckpointCompletedAt.mock.results[0]?.value).resolves.toEqual(
        fenceCompletedAt,
      );
      await expect(mocks.loadPhaseProgress.mock.results[0]?.value).resolves.toEqual(uncoveredAck);
      expect(mocks.verifyBackupRetention).not.toHaveBeenCalled();
      expect(mocks.verifyPeerDbStagingRetention).not.toHaveBeenCalled();
    } finally {
      await runtime.close();
    }
  });

  it("completes retention verification when ordered stock physical maintenance ack is present", async () => {
    const ack = orderedStockPhysicalMaintenanceAck();
    mocks.loadCheckpointCompletedAt.mockResolvedValue(ingestFenceCompletedAt);
    mocks.loadPhaseProgress.mockResolvedValue(ack);
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
        physicalMaintenanceAcknowledged: {
          runId: ack.runId,
          operator: ack.operator,
          runbookRevision: ack.runbookRevision,
        },
        processorRetention: {
          axiomRetentionDays: 30,
          sentryRetentionDays: 30,
        },
        verified: true,
      });
      expect(mocks.verifyPeerDbStagingRetention).toHaveBeenCalledWith(
        mocks.peerDbStagingStorage,
        expect.objectContaining({
          cutoff: new Date(peerDbDrainCheckpoint.stagingBoundary.cutoff),
          now: expect.any(Date),
        }),
      );
      expect(mocks.verifyBackupRetention).toHaveBeenCalled();
      expect(mocks.verifyProcessorRetention).toHaveBeenCalled();
    } finally {
      await runtime.close();
    }
  });

  it("rejects drain when ingest checkpoint stream count differs from resolved routes", async () => {
    const runtime = await createAccountErasureRuntime(ownerDatabase, mockClickHouse(), {
      close: vi.fn(async () => undefined),
      purge: vi.fn(async () => undefined),
    });
    try {
      const partial = {
        streams: [
          {
            fence: {
              transport: "pulsar" as const,
              state: "empty" as const,
              epoch: "transport-epoch",
              topic: "persistent://public/default/legacy",
              partition: -1,
            },
          },
        ],
      };
      await expect(
        runtime.phaseRunner.runPhase(
          "consumer_drain",
          execution(async (phase) => (phase === "ingest_fence" ? partial : null)),
        ),
      ).rejects.toThrow(/stream count 1 differs from resolved drain stream count 3/);
      expect(mocks.assertSubscriptionsDrained).toHaveBeenCalledOnce();
    } finally {
      await runtime.close();
    }
  });

  it("fails closed when required Pulsar admin configuration is missing", async () => {
    delete process.env.PULSAR_ADMIN_URL;
    await expect(
      createAccountErasureRuntime(ownerDatabase, mockClickHouse(), {
        close: vi.fn(async () => undefined),
        purge: vi.fn(async () => undefined),
      }),
    ).rejects.toThrow(/PULSAR_ADMIN_URL is required for account erasure/);
  });

  it("fails closed when required Pulsar admin configuration is blank", async () => {
    process.env.PULSAR_ADMIN_URL = "   ";
    await expect(
      createAccountErasureRuntime(ownerDatabase, mockClickHouse(), {
        close: vi.fn(async () => undefined),
        purge: vi.fn(async () => undefined),
      }),
    ).rejects.toThrow(/PULSAR_ADMIN_URL is required for account erasure/);
  });
});
