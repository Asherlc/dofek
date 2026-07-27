import * as Sentry from "@sentry/node";
import {
  eraseMetricStreamArchive,
  R2MetricStreamArchiveStorage,
} from "../account-erasure/archive-erasure.ts";
import { verifyAccountErasureBackupRetention } from "../account-erasure/backup-retention.ts";
import {
  eraseClickHouseAccount,
  fenceClickHouseAccount,
} from "../account-erasure/clickhouse-erasure.ts";
import { R2DatabaseBackupStorage } from "../account-erasure/database-backup-storage.ts";
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

type AccountErasureRuntimeDatabase = Pick<Database, "execute" | "transaction">;
type AccountErasureRuntimeClickHouseClient = Parameters<typeof eraseClickHouseAccount>[0] &
  Parameters<typeof assertPeerDbAccountErasureDrained>[1];

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

    const identifiers = (snapshot: AccountErasureRemoteSnapshot) => ({
      activityIds: snapshot.localIdentifiers.activityIds,
      operationIds: snapshot.localIdentifiers.processingOperationIds,
      sleepSessionIds: snapshot.localIdentifiers.sleepSessionIds,
      userId: snapshot.localIdentifiers.userId,
    });
    const dependencies: AccountErasurePhaseRunnerDependencies = {
      assertConsumersDrained: (highWatermarks) =>
        assertAccountErasureConsumersDrained(redpanda.admin, redpanda.topic, highWatermarks),
      assertPeerDbDrained: (snapshot, walLsn) =>
        assertPeerDbAccountErasureDrained(
          database,
          clickHouseClient,
          walLsn,
          identifiers(snapshot),
        ),
      assertQuarantineExpired: (highWatermarks) =>
        assertAccountErasureQuarantineExpired(redpanda.admin, redpanda.topic, highWatermarks),
      assertReplayExpired: (highWatermarks) =>
        assertAccountErasureReplayExpired(redpanda.admin, redpanda.topic, highWatermarks),
      captureHighWatermarks: () =>
        captureAccountErasureHighWatermarks(redpanda.admin, redpanda.topic),
      capturePeerDbStagingBoundary: (input) =>
        capturePeerDbStagingBoundary(database, peerDbMirrorApi, peerDbStaging.storage, input),
      captureQuarantineHighWatermarks: () =>
        captureAccountErasureQuarantineHighWatermarks(redpanda.admin, redpanda.topic),
      decryptSnapshot: decryptAccountErasureSnapshot,
      eraseArchive: (snapshot, options) =>
        eraseMetricStreamArchive(
          archiveStorage,
          {
            activityIds: new Set(snapshot.localIdentifiers.activityIds),
            operationIds: new Set(snapshot.localIdentifiers.processingOperationIds),
            userId: snapshot.localIdentifiers.userId,
          },
          options,
        ),
      eraseClickHouse: (snapshot) =>
        eraseClickHouseAccount(clickHouseClient, identifiers(snapshot)),
      erasePostgres: (requestId, userId) => erasePostgresAccount(database, requestId, userId),
      eraseProcessors: (snapshot, progress) =>
        eraseAccountProcessors(snapshot, processorConfig, progress),
      eraseStripe: (snapshot) => eraseStripeAccount(snapshot),
      fenceIngest: (snapshot) =>
        fenceClickHouseAccount(
          clickHouseClient,
          snapshot.localIdentifiers.userId,
          snapshot.localIdentifiers.processingOperationIds,
        ),
      now: () => new Date(),
      purgeWork: (snapshot) => workPurger.purge(snapshot),
      revokeRemote: (snapshot) => revokeRemoteAccounts(snapshot, providers),
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
