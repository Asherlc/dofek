import * as Sentry from "@sentry/node";
import {
  eraseMetricStreamArchive,
  R2MetricStreamArchiveStorage,
} from "../account-erasure/archive-erasure.ts";
import { verifyAccountErasureBackupRetention } from "../account-erasure/backup-retention.ts";
import {
  eraseClickHouseAccount,
  fenceClickHouseAccount,
  prepareClickHouseAccountErasure,
} from "../account-erasure/clickhouse-erasure.ts";
import { R2DatabaseBackupStorage } from "../account-erasure/database-backup-storage.ts";
import {
  ACCOUNT_ERASURE_IDENTIFIER_PAGE_SIZE,
  AccountErasureIdentifierStore,
} from "../account-erasure/identifier-store.ts";
import { KafkaLogStorage } from "../account-erasure/kafka-log-storage.ts";
import { KafkaRemoteHistory } from "../account-erasure/kafka-remote-history.ts";
import { KafkaRemoteStorage } from "../account-erasure/kafka-remote-storage.ts";
import { assertPeerDbAccountErasureDrained } from "../account-erasure/peerdb-erasure.ts";
import {
  createPeerDbStagingStorageFromEnv,
  verifyPeerDbStagingRetention,
} from "../account-erasure/peerdb-staging-retention.ts";
import { capturePeerDbStagingBoundary } from "../account-erasure/peerdb-staging-writer-barrier.ts";
import { erasePostgresAccount } from "../account-erasure/postgres-erasure.ts";
import {
  accountErasureProcessorConfigFromEnv,
  eraseAccountProcessors,
  verifyAccountProcessors,
} from "../account-erasure/processor-erasure.ts";
import {
  processorRetentionConfigFromEnv,
  verifyProcessorRetentionPolicies,
} from "../account-erasure/processor-retention.ts";
import {
  assertAccountErasureConsumersDrained,
  assertAccountErasureQuarantineExpired,
  assertAccountErasureReplayExpired,
  captureAccountErasureHighWatermarks,
  captureAccountErasureQuarantineHighWatermarks,
  createAccountErasureRedpandaAdminFromEnv,
} from "../account-erasure/redpanda-drain.ts";
import { eraseStripeAccount, revokeRemoteAccounts } from "../account-erasure/remote-revocation.ts";
import {
  type AccountErasureRemoteSnapshot,
  decryptAccountErasureSnapshot,
} from "../account-erasure/remote-snapshot.ts";
import {
  ANALYTICS_PUBLICATION_RESOURCE,
  withAnalyticsQueryOwner,
} from "../analytics/analytics-query-owner.ts";
import type { ClickHouseClient } from "../db/clickhouse.ts";
import { createPeerDbMirrorApiClientFromEnv } from "../db/clickhouse-cdc.ts";
import type { Database } from "../db/index.ts";
import { metricStreamQuarantineTopic } from "../metric-stream/redpanda-quarantine.ts";
import { getAllProviders } from "../providers/index.ts";
import { createR2Client, requiredR2EnvironmentVariable } from "../r2-storage.ts";
import {
  type AccountErasurePhaseRunnerDependencies,
  createAccountErasurePhaseRunner,
} from "./account-erasure-phase-runner.ts";
import type { AccountErasurePhaseRunner } from "./process-account-erasure-request.ts";
import { ensureProvidersRegistered } from "./provider-registration.ts";

const DATABASE_BACKUP_RETENTION_DAYS = 21;
const MAX_DATABASE_BACKUP_SWEEP_PASSES = 3;

export interface AccountErasureWorkPurger {
  close(): Promise<void>;
  purge(snapshot: AccountErasureRemoteSnapshot): Promise<void>;
}

export interface AccountErasureRuntime {
  close(): Promise<void>;
  phaseRunner: AccountErasurePhaseRunner;
}

type AccountErasureRuntimeDatabase = Pick<Database, "execute" | "transaction" | "$client">;
type AccountErasureRuntimeClickHouseClient = ClickHouseClient;

export async function createAccountErasureRuntime(
  database: AccountErasureRuntimeDatabase,
  clickHouseClient: AccountErasureRuntimeClickHouseClient,
  workPurger: AccountErasureWorkPurger,
): Promise<AccountErasureRuntime> {
  const startupCleanup: Array<() => Promise<void>> = [() => workPurger.close()];
  try {
    await ensureProvidersRegistered();
    const providers = getAllProviders();
    const r2Client = createR2Client();
    startupCleanup.push(async () => {
      r2Client.destroy();
    });
    const archiveStorage = new R2MetricStreamArchiveStorage(
      r2Client,
      requiredR2EnvironmentVariable("METRIC_STREAM_R2_BUCKET"),
    );
    const databaseBackupStorage = new R2DatabaseBackupStorage(
      r2Client,
      requiredR2EnvironmentVariable("DB_BACKUPS_R2_BUCKET"),
    );
    const peerDbStaging = createPeerDbStagingStorageFromEnv();
    const peerDbMirrorApi = createPeerDbMirrorApiClientFromEnv();
    startupCleanup.push(async () => {
      peerDbStaging.close();
    });
    const processorConfig = accountErasureProcessorConfigFromEnv();
    const processorRetentionConfig = processorRetentionConfigFromEnv();
    const redpanda = createAccountErasureRedpandaAdminFromEnv();
    startupCleanup.push(() => redpanda.close());
    await redpanda.connect();
    if (requiredR2EnvironmentVariable("KAFKA_TIERED_STORAGE_REGION") !== "auto")
      throw new Error("KAFKA_TIERED_STORAGE_REGION must be auto for the qualified R2 endpoint");
    const brokerR2Client = createR2Client({
      accessKeyId: requiredR2EnvironmentVariable("KAFKA_TIERED_STORAGE_ACCESS_KEY_ID"),
      secretAccessKey: requiredR2EnvironmentVariable("KAFKA_TIERED_STORAGE_SECRET_ACCESS_KEY"),
      endpoint: requiredR2EnvironmentVariable("KAFKA_TIERED_STORAGE_ENDPOINT"),
    });
    startupCleanup.push(async () => brokerR2Client.destroy());
    const remoteHistory = new KafkaRemoteHistory(redpanda.admin, () =>
      redpanda.createMetadataConsumer(),
    );
    const remoteStorage = new KafkaRemoteStorage(
      brokerR2Client,
      requiredR2EnvironmentVariable("KAFKA_TIERED_STORAGE_BUCKET"),
      `${requiredR2EnvironmentVariable("KAFKA_CLUSTER_ID")}/`,
      (boundaries) => remoteHistory.assertDeleted(boundaries),
    );
    const brokerStorage = new KafkaLogStorage(
      redpanda.admin,
      {
        directory: "/var/lib/dofek/kafka-data",
        brokerDirectory: "/var/lib/kafka/data",
        retiredDirectories: [
          "/var/lib/dofek/retired-broker-data",
          "/var/lib/dofek/aborted-kafka-data",
        ],
        topics: redpanda.routes.flatMap(({ topic }) => [topic, metricStreamQuarantineTopic(topic)]),
      },
      remoteStorage,
    );

    const identifiers = (input: { requestId: string; leaseOwner: string }) =>
      new AccountErasureIdentifierStore(database, {
        ...input,
        pageSize: ACCOUNT_ERASURE_IDENTIFIER_PAGE_SIZE,
      });
    const dependencies: AccountErasurePhaseRunnerDependencies = {
      prepareIdentifiers: (input) =>
        withAnalyticsQueryOwner(
          database,
          clickHouseClient,
          {
            resourceId: ANALYTICS_PUBLICATION_RESOURCE,
            intentId: `account-erasure:${input.requestId}`,
          },
          (owner) =>
            prepareClickHouseAccountErasure(
              owner,
              new AccountErasureIdentifierStore(database, {
                requestId: input.requestId,
                leaseOwner: input.leaseOwner,
                pageSize: ACCOUNT_ERASURE_IDENTIFIER_PAGE_SIZE,
              }),
              input,
            ),
        ),
      assertIdentifiersReady: async (input) => {
        const store = new AccountErasureIdentifierStore(database, {
          requestId: input.requestId,
          leaseOwner: input.leaseOwner,
          pageSize: ACCOUNT_ERASURE_IDENTIFIER_PAGE_SIZE,
        });
        await store.assertClosureComplete(input.stage);
        if (!(await store.loadPhysicalProgress(input.stage)))
          throw new Error("Account erasure physical preparation is incomplete");
      },
      assertBrokerStorageExpired: (boundaries) => brokerStorage.assertExpired(boundaries),
      assertConsumersDrained: async (highWatermarks) => {
        for (const route of redpanda.routes) {
          const captured = highWatermarks.filter((entry) => entry.topic === route.topic);
          if (captured.length === 0)
            throw new Error(`Account erasure checkpoint is missing topic ${route.topic}`);
          await assertAccountErasureConsumersDrained(
            redpanda.admin,
            route.topic,
            captured,
            route.consumerGroups,
          );
        }
      },
      assertPeerDbDrained: (input, walLsn) =>
        assertPeerDbAccountErasureDrained(database, clickHouseClient, walLsn, {
          userId: input.userId,
          store: identifiers(input),
        }),
      assertQuarantineExpired: async (highWatermarks) => {
        for (const route of redpanda.routes) {
          const captured = highWatermarks.filter((entry) => entry.topic === route.topic);
          if (captured.length === 0)
            throw new Error(`Account erasure checkpoint is missing topic ${route.topic}`);
          await assertAccountErasureQuarantineExpired(redpanda.admin, route.topic, captured);
        }
      },
      assertReplayExpired: async (highWatermarks) => {
        for (const route of redpanda.routes) {
          const captured = highWatermarks.filter((entry) => entry.topic === route.topic);
          if (captured.length === 0)
            throw new Error(`Account erasure checkpoint is missing topic ${route.topic}`);
          await assertAccountErasureReplayExpired(redpanda.admin, route.topic, captured);
        }
      },
      captureHighWatermarks: async () =>
        (
          await Promise.all(
            redpanda.routes.map(async ({ topic }) =>
              (
                await brokerStorage.capture(topic, () =>
                  captureAccountErasureHighWatermarks(redpanda.admin, topic),
                )
              ).map((entry) => ({ ...entry, topic })),
            ),
          )
        ).flat(),
      captureQuarantineHighWatermarks: async () =>
        (
          await Promise.all(
            redpanda.routes.map(async ({ topic }) =>
              (
                await brokerStorage.capture(metricStreamQuarantineTopic(topic), () =>
                  captureAccountErasureQuarantineHighWatermarks(redpanda.admin, topic),
                )
              ).map((entry) => ({ ...entry, topic })),
            ),
          )
        ).flat(),
      capturePeerDbStagingBoundary: (input) =>
        capturePeerDbStagingBoundary(database, peerDbMirrorApi, peerDbStaging.storage, input),
      decryptSnapshot: decryptAccountErasureSnapshot,
      eraseArchive: (input, options) =>
        eraseMetricStreamArchive(
          archiveStorage,
          { userId: input.userId, stage: input.stage, store: identifiers(input) },
          options,
        ),
      eraseClickHouse: (input) =>
        withAnalyticsQueryOwner(
          database,
          clickHouseClient,
          {
            resourceId: ANALYTICS_PUBLICATION_RESOURCE,
            intentId: `account-erasure:${input.requestId}`,
          },
          (owner) =>
            eraseClickHouseAccount(
              owner,
              new AccountErasureIdentifierStore(database, {
                requestId: input.requestId,
                leaseOwner: input.leaseOwner,
                pageSize: ACCOUNT_ERASURE_IDENTIFIER_PAGE_SIZE,
              }),
              input,
            ),
        ),
      erasePostgres: (requestId, userId) => erasePostgresAccount(database, requestId, userId),
      eraseProcessors: (snapshot, progress) =>
        eraseAccountProcessors(snapshot, processorConfig, progress),
      eraseStripe: (snapshot) => eraseStripeAccount(snapshot),
      // Activation already committed its PG fence; never hold that transaction
      // while waiting for this global ClickHouse publication owner.
      fenceIngest: (input) =>
        withAnalyticsQueryOwner(
          database,
          clickHouseClient,
          {
            resourceId: ANALYTICS_PUBLICATION_RESOURCE,
            intentId: `account-erasure:${input.requestId}`,
          },
          async (owner) => {
            const store = identifiers(input);
            let cursor: string | undefined;
            do {
              const page = await store.readPage("operation", cursor);
              await fenceClickHouseAccount(
                owner.client,
                input.userId,
                page.entries.map((entry) => entry.value),
              );
              cursor = page.nextCursor ?? undefined;
            } while (cursor);
          },
        ),
      now: () => new Date(),
      purgeWork: (snapshot) => workPurger.purge(snapshot),
      revokeRemote: (snapshot, persistProviderCredentials) =>
        revokeRemoteAccounts(snapshot, providers, persistProviderCredentials),
      verifyBackupRetention: (input) =>
        verifyAccountErasureBackupRetention(databaseBackupStorage, {
          maxSweepPasses: MAX_DATABASE_BACKUP_SWEEP_PASSES,
          now: input.now,
          piiScrubbedAt: input.piiScrubbedAt,
          requestedAt: input.requestedAt,
          retentionDays: DATABASE_BACKUP_RETENTION_DAYS,
        }),
      verifyProcessorRetention: () => verifyProcessorRetentionPolicies(processorRetentionConfig),
      verifyPeerDbStagingRetention: (input) =>
        verifyPeerDbStagingRetention(peerDbStaging.storage, input),
      verifyProcessors: (snapshot, initialCheckpoint, progress) =>
        verifyAccountProcessors(snapshot, initialCheckpoint, processorConfig, progress),
    };

    return {
      async close(): Promise<void> {
        try {
          await Promise.all([redpanda.close(), workPurger.close()]);
        } finally {
          try {
            peerDbStaging.close();
          } finally {
            brokerR2Client.destroy();
            r2Client.destroy();
          }
        }
      },
      phaseRunner: createAccountErasurePhaseRunner(dependencies),
    };
  } catch (error: unknown) {
    Sentry.captureException(error, {
      tags: { accountErasureStep: "runtimeStartup" },
    });
    const cleanupResults = await Promise.allSettled(
      [...startupCleanup].reverse().map((cleanup) => cleanup()),
    );
    const cleanupFailures: unknown[] = [];
    for (const cleanupResult of cleanupResults) {
      if (cleanupResult.status === "rejected") {
        cleanupFailures.push(cleanupResult.reason);
        Sentry.captureException(cleanupResult.reason, {
          tags: { accountErasureStep: "runtimeStartupCleanup" },
        });
      }
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        [error, ...cleanupFailures],
        "Account erasure runtime startup and cleanup failed",
        { cause: error },
      );
    }
    throw error;
  }
}
