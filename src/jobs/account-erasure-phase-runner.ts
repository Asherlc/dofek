import { z } from "zod";
import type { ArchiveErasureResult } from "../account-erasure/archive-erasure.ts";
import type { PeerDbStagingRetentionResult } from "../account-erasure/peerdb-staging-retention.ts";
import type { PeerDbStagingBoundary } from "../account-erasure/peerdb-staging-writer-barrier.ts";
import type { AccountErasureProcessorProgress } from "../account-erasure/processor-erasure.ts";
import type { AccountErasureHighWatermark } from "../account-erasure/redpanda-drain.ts";
import type {
  ProviderCredentialDisposition,
  StripeAccountErasureResult,
} from "../account-erasure/remote-revocation.ts";
import type { AccountErasureRemoteSnapshot } from "../account-erasure/remote-snapshot.ts";
import type { AccountErasurePhase } from "./process-account-erasure-job.ts";
import type {
  AccountErasurePhaseExecution,
  AccountErasurePhaseRunner,
} from "./process-account-erasure-request.ts";

const highWatermarksCheckpointSchema = z.object({
  highWatermarks: z.array(
    z.object({
      low: z.string().regex(/^\d+$/),
      offset: z.string().regex(/^\d+$/),
      partition: z.number().int().nonnegative(),
    }),
  ),
});
const quarantineHighWatermarksCheckpointSchema = z.object({
  quarantineHighWatermarks: highWatermarksCheckpointSchema.shape.highWatermarks,
});

const archiveProgressSchema = z.object({
  lastKey: z.string().min(1),
});
const postProfileDeleteCheckpointSchema = z.object({
  walLsn: z.string().regex(/^[0-9A-F]+\/[0-9A-F]+$/i),
});
const peerDbDrainCheckpointSchema = z.object({
  stagingBoundary: z.object({
    cutoff: z.iso.datetime(),
  }),
});
const processorProgressSchema = z.object({
  posthogPersonUuids: z.array(z.uuid()),
});

interface ArchiveSweepOptions {
  onObjectCompleted?(key: string): Promise<void>;
  startAfter?: string;
}

export interface AccountErasurePhaseRunnerDependencies {
  assertConsumersDrained(highWatermarks: readonly AccountErasureHighWatermark[]): Promise<void>;
  assertPeerDbDrained(snapshot: AccountErasureRemoteSnapshot, walLsn: string): Promise<void>;
  assertQuarantineExpired(highWatermarks: readonly AccountErasureHighWatermark[]): Promise<void>;
  assertReplayExpired(highWatermarks: readonly AccountErasureHighWatermark[]): Promise<void>;
  captureHighWatermarks(): Promise<AccountErasureHighWatermark[]>;
  capturePeerDbStagingBoundary(input: {
    loadProgress(): Promise<Record<string, unknown> | null>;
    requestId: string;
    saveProgress(progress: Record<string, unknown>): Promise<void>;
  }): Promise<PeerDbStagingBoundary>;
  captureQuarantineHighWatermarks(): Promise<AccountErasureHighWatermark[]>;
  decryptSnapshot(encryptedSnapshot: string, userId: string): Promise<AccountErasureRemoteSnapshot>;
  eraseArchive(
    snapshot: AccountErasureRemoteSnapshot,
    options: ArchiveSweepOptions,
  ): Promise<ArchiveErasureResult>;
  eraseClickHouse(snapshot: AccountErasureRemoteSnapshot): Promise<void>;
  erasePostgres(requestId: string, userId: string): Promise<void>;
  eraseProcessors(
    snapshot: AccountErasureRemoteSnapshot,
    progress: AccountErasureProcessorProgress,
  ): Promise<Record<string, unknown>>;
  verifyProcessors(
    snapshot: AccountErasureRemoteSnapshot,
    initialCheckpoint: Record<string, unknown> | null,
    progress: AccountErasureProcessorProgress,
  ): Promise<Record<string, unknown>>;
  eraseStripe(snapshot: AccountErasureRemoteSnapshot): Promise<StripeAccountErasureResult>;
  fenceIngest(snapshot: AccountErasureRemoteSnapshot): Promise<void>;
  now(): Date;
  purgeWork(snapshot: AccountErasureRemoteSnapshot): Promise<void>;
  revokeRemote(snapshot: AccountErasureRemoteSnapshot): Promise<ProviderCredentialDisposition[]>;
  verifyBackupRetention(input: {
    now: Date;
    piiScrubbedAt: Date;
    requestId: string;
    requestedAt: Date;
  }): Promise<{ deletedObjects: number }>;
  verifyProcessorRetention(input: {
    now: Date;
    piiScrubbedAt: Date;
    requestId: string;
    requestedAt: Date;
  }): Promise<Record<string, unknown>>;
  verifyPeerDbStagingRetention(input: {
    cutoff: Date;
    now: Date;
  }): Promise<PeerDbStagingRetentionResult>;
}

function requireIdentifyingRequest(
  phase: AccountErasurePhase,
  execution: AccountErasurePhaseExecution,
): { encryptedSnapshot: string; userId: string } {
  const { encryptedRemoteSnapshot, piiScrubbedAt, userId } = execution.request;
  if (!userId || !encryptedRemoteSnapshot || piiScrubbedAt) {
    throw new Error(`Identifying account-erasure phase ${phase} requires live request PII`);
  }
  return { encryptedSnapshot: encryptedRemoteSnapshot, userId };
}

async function loadHighWatermarks(
  execution: AccountErasurePhaseExecution,
): Promise<AccountErasureHighWatermark[]> {
  const checkpoint = highWatermarksCheckpointSchema.parse(
    await execution.loadCheckpointDetails("ingest_fence"),
  );
  return checkpoint.highWatermarks;
}

function archiveDetails(result: ArchiveErasureResult) {
  return {
    objectsRewritten: result.objectsRewritten,
    recordsRemoved: result.recordsRemoved,
  };
}

async function loadProcessorProgress(
  execution: AccountErasurePhaseExecution,
): Promise<AccountErasureProcessorProgress> {
  const stored = processorProgressSchema.nullable().parse(await execution.loadProgress());
  return {
    knownPosthogPersonUuids: stored?.posthogPersonUuids ?? [],
    savePosthogPersonUuids: async (personUuids) => {
      const parsed = processorProgressSchema.parse({
        posthogPersonUuids: [...personUuids],
      });
      await execution.saveProgress(parsed);
    },
  };
}

export function createAccountErasurePhaseRunner(
  dependencies: AccountErasurePhaseRunnerDependencies,
): AccountErasurePhaseRunner {
  const loadSnapshot = async (
    phase: AccountErasurePhase,
    execution: AccountErasurePhaseExecution,
  ): Promise<AccountErasureRemoteSnapshot> => {
    const identifying = requireIdentifyingRequest(phase, execution);
    return dependencies.decryptSnapshot(identifying.encryptedSnapshot, identifying.userId);
  };

  return {
    async runPhase(
      phase: AccountErasurePhase,
      execution: AccountErasurePhaseExecution,
    ): Promise<Record<string, unknown> | null> {
      switch (phase) {
        case "ingest_fence": {
          const snapshot = await loadSnapshot(phase, execution);
          await dependencies.fenceIngest(snapshot);
          const highWatermarks = await dependencies.captureHighWatermarks();
          return { highWatermarks };
        }
        case "stripe_erasure": {
          const snapshot = await loadSnapshot(phase, execution);
          await dependencies.eraseStripe(snapshot);
          return null;
        }
        case "stripe_erasure_verification": {
          const snapshot = await loadSnapshot(phase, execution);
          const cleanup = await dependencies.eraseStripe(snapshot);
          const verification = await dependencies.eraseStripe(snapshot);
          if (verification.customersDeleted !== 0 || verification.subscriptionsCanceled !== 0) {
            throw new Error("Stripe account erasure verification found new remote state");
          }
          return {
            ...cleanup,
            verified: true,
          };
        }
        case "work_purge":
        case "work_verification": {
          const snapshot = await loadSnapshot(phase, execution);
          await dependencies.purgeWork(snapshot);
          return { verified: phase === "work_verification" };
        }
        case "consumer_drain": {
          const highWatermarks = await loadHighWatermarks(execution);
          await dependencies.assertConsumersDrained(highWatermarks);
          const quarantineHighWatermarks = await dependencies.captureQuarantineHighWatermarks();
          return { quarantineHighWatermarks };
        }
        case "consumer_drain_verification": {
          const highWatermarks = await loadHighWatermarks(execution);
          await dependencies.assertConsumersDrained(highWatermarks);
          await dependencies.assertReplayExpired(highWatermarks);
          return { drained: true, replayExpired: true };
        }
        case "remote_revocation":
        case "remote_revocation_verification": {
          const snapshot = await loadSnapshot(phase, execution);
          const dispositions = await dependencies.revokeRemote(snapshot);
          return {
            dispositions,
            verified: phase === "remote_revocation_verification",
          };
        }
        case "processor_erasure": {
          const snapshot = await loadSnapshot(phase, execution);
          return dependencies.eraseProcessors(snapshot, await loadProcessorProgress(execution));
        }
        case "processor_erasure_verification": {
          const snapshot = await loadSnapshot(phase, execution);
          const initialCheckpoint = await execution.loadCheckpointDetails("processor_erasure");
          return {
            ...(await dependencies.verifyProcessors(
              snapshot,
              initialCheckpoint,
              await loadProcessorProgress(execution),
            )),
            verified: true,
          };
        }
        case "postgres_erasure": {
          const identifying = requireIdentifyingRequest(phase, execution);
          await dependencies.erasePostgres(execution.request.id, identifying.userId);
          return null;
        }
        case "clickhouse_initial":
        case "clickhouse_verification": {
          const snapshot = await loadSnapshot(phase, execution);
          await dependencies.eraseClickHouse(snapshot);
          return { verified: phase === "clickhouse_verification" };
        }
        case "archive_initial": {
          const snapshot = await loadSnapshot(phase, execution);
          const progress = archiveProgressSchema.nullable().parse(await execution.loadProgress());
          const result = await dependencies.eraseArchive(snapshot, {
            ...(progress ? { startAfter: progress.lastKey } : {}),
            onObjectCompleted: (lastKey) => execution.saveProgress({ lastKey }),
          });
          return archiveDetails(result);
        }
        case "postgres_profile_delete": {
          requireIdentifyingRequest(phase, execution);
          return execution.deleteProfile();
        }
        case "peerdb_drain_verification": {
          const snapshot = await loadSnapshot(phase, execution);
          const checkpoint = postProfileDeleteCheckpointSchema.parse(
            await execution.loadCheckpointDetails("postgres_profile_delete"),
          );
          await dependencies.assertPeerDbDrained(snapshot, checkpoint.walLsn);
          const stagingBoundary = await dependencies.capturePeerDbStagingBoundary({
            loadProgress: execution.loadProgress,
            requestId: execution.request.id,
            saveProgress: execution.saveProgress,
          });
          return { stagingBoundary, verified: true };
        }
        case "archive_verification": {
          const snapshot = await loadSnapshot(phase, execution);
          const cleanup = await dependencies.eraseArchive(snapshot, {
            startAfter: undefined,
          });
          const verification = await dependencies.eraseArchive(snapshot, {
            startAfter: undefined,
          });
          if (verification.recordsRemoved !== 0) {
            throw new Error(
              "R2 archive account-erasure verification observed new attributable records",
            );
          }
          return {
            objectsRewritten: cleanup.objectsRewritten,
            recordsRemoved: cleanup.recordsRemoved,
            verified: true,
          };
        }
        case "request_pii_scrub":
          await execution.scrubPii();
          return null;
        case "retention_verification": {
          const { encryptedRemoteSnapshot, id, piiScrubbedAt, requestedAt, userId } =
            execution.request;
          if (userId || encryptedRemoteSnapshot || !piiScrubbedAt) {
            throw new Error(
              "Account-erasure retention verification requires a pseudonymous request",
            );
          }
          const retentionInput = {
            now: dependencies.now(),
            piiScrubbedAt,
            requestId: id,
            requestedAt,
          };
          const quarantineCheckpoint = quarantineHighWatermarksCheckpointSchema.parse(
            await execution.loadCheckpointDetails("consumer_drain"),
          );
          await dependencies.assertQuarantineExpired(quarantineCheckpoint.quarantineHighWatermarks);
          const peerDbCheckpoint = peerDbDrainCheckpointSchema.parse(
            await execution.loadCheckpointDetails("peerdb_drain_verification"),
          );
          const peerDbStagingRetention = await dependencies.verifyPeerDbStagingRetention({
            cutoff: new Date(peerDbCheckpoint.stagingBoundary.cutoff),
            now: retentionInput.now,
          });
          const processorRetention = await dependencies.verifyProcessorRetention(retentionInput);
          const backupRetention = await dependencies.verifyBackupRetention(retentionInput);
          return {
            backupRetention,
            peerDbStagingRetention,
            processorRetention,
            quarantineRetentionVerified: true,
            verified: true,
          };
        }
      }
    },
  };
}
