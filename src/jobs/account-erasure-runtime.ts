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
            intentId: `account-erasure:${input.requestId}:prepare-identities:${input.stage}`,
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
                await captureAccountErasureHighWatermarks(redpanda.admin, topic)
              ).map((entry) => ({
                ...entry,
                topic,
              })),
            ),
          )
        ).flat(),
      captureQuarantineHighWatermarks: async () =>
        (
          await Promise.all(
            redpanda.routes.map(async ({ topic }) =>
              (
                await captureAccountErasureQuarantineHighWatermarks(redpanda.admin, topic)
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
            intentId: `account-erasure:${input.requestId}:erase:${input.stage}`,
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
            intentId: `account-erasure:${input.requestId}:fence`,
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
