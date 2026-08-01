import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { captureAccountErasurePostgresWalLsn } from "../account-erasure/peerdb-erasure.ts";
import { erasePostgresAccount } from "../account-erasure/postgres-erasure.ts";
import { findAccountErasureStatus, initiateAccountErasure } from "../db/account-erasure.ts";
import { markAccountErasureDispatched } from "../db/account-erasure-processing.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import {
  type AccountErasurePhaseRunnerDependencies,
  createAccountErasurePhaseRunner,
} from "./account-erasure-phase-runner.ts";
import {
  ACCOUNT_ERASURE_ACTIVE_PHASES,
  type AccountErasurePhase,
  accountErasureRetentionVerificationAt,
} from "./process-account-erasure-job.ts";
import {
  type AccountErasurePhaseExecution,
  processAccountErasureRequest,
} from "./process-account-erasure-request.ts";

const userId = "86000000-0000-4000-8000-000000001994";
const requestedAt = new Date("2026-07-01T00:00:00.000Z");
const peerDbStagingBoundary = {
  cutoff: "2026-07-01T12:00:00.000Z",
  eTag: '"request-to-completion-boundary"',
  key: "account-erasure-boundaries/request-to-completion",
  mirrors: [
    {
      name: "dofek_fitness_raw_analytics",
      status: "STATUS_PAUSED" as const,
    },
  ],
};

function createRetentionPhaseRunner(now: Date) {
  const unexpectedDependency = async (): Promise<never> => {
    throw new Error("Unexpected identifying account-erasure dependency");
  };
  const verifyPeerDbStagingRetention = vi.fn(async () => ({
    lifecycleRetentionDays: 1,
    multipartUploadsInspected: 0,
    objectsInspected: 0,
    verified: true as const,
  }));
  const dependencies = {
    assertConsumersDrained: unexpectedDependency,
    assertPeerDbDrained: unexpectedDependency,
    assertQuarantineExpired: vi.fn(async () => undefined),
    assertReplayExpired: unexpectedDependency,
    captureHighWatermarks: unexpectedDependency,
    capturePeerDbStagingBoundary: unexpectedDependency,
    captureQuarantineHighWatermarks: unexpectedDependency,
    decryptSnapshot: unexpectedDependency,
    eraseArchive: unexpectedDependency,
    eraseClickHouse: unexpectedDependency,
    erasePostgres: unexpectedDependency,
    eraseProcessors: unexpectedDependency,
    eraseStripe: unexpectedDependency,
    fenceIngest: unexpectedDependency,
    now: () => now,
    purgeWork: unexpectedDependency,
    revokeRemote: unexpectedDependency,
    verifyBackupRetention: vi.fn(async () => ({ deletedObjects: 0 })),
    verifyProcessorRetention: vi.fn(async () => ({})),
    verifyPeerDbStagingRetention,
    verifyProcessors: unexpectedDependency,
  } satisfies AccountErasurePhaseRunnerDependencies;
  return {
    runner: createAccountErasurePhaseRunner(dependencies),
    verifyPeerDbStagingRetention,
  };
}

describe("processAccountErasureRequest request-to-completion (integration)", () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name, email)
          VALUES (
            ${userId}::uuid,
            'End-to-end erasure',
            'request-to-completion-1994@example.test'
          )`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.user_settings (user_id, key, value)
          VALUES (${userId}::uuid, 'erasure-fixture', 'true'::jsonb)`,
    );
  }, 120_000);

  afterAll(async () => {
    await context?.cleanup();
  });

  it("persists both waits, erases relational ownership, scrubs PII, and completes", async () => {
    const accepted = await initiateAccountErasure(
      context.db,
      userId,
      async () => "encrypted-request-to-completion-snapshot",
      async () => {},
      { now: requestedAt },
    );
    await markAccountErasureDispatched(context.db, accepted.requestId);
    const retentionVerificationAt = accountErasureRetentionVerificationAt(requestedAt);
    const retention = createRetentionPhaseRunner(retentionVerificationAt);
    expect(new Date(accepted.retentionUntil).getTime() - retentionVerificationAt.getTime()).toBe(
      24 * 60 * 60 * 1_000,
    );

    const phaseRuns: AccountErasurePhase[] = [];
    const phaseRunner = {
      async runPhase(
        phase: AccountErasurePhase,
        execution: AccountErasurePhaseExecution,
      ): Promise<Record<string, unknown> | null> {
        phaseRuns.push(phase);
        if (phase === "postgres_erasure") {
          await erasePostgresAccount(context.db, execution.request.id, userId);
          return null;
        }
        if (phase === "postgres_profile_delete") {
          return execution.deleteProfile();
        }
        if (phase === "consumer_drain") {
          return {
            quarantineHighWatermarks: [{ low: "4", offset: "12", partition: 0 }],
          };
        }
        if (phase === "peerdb_drain_verification") {
          return { stagingBoundary: peerDbStagingBoundary, verified: true };
        }
        if (phase === "request_pii_scrub") {
          await execution.scrubPii();
        }
        if (phase === "retention_verification") {
          return retention.runner.runPhase(phase, execution);
        }
        return null;
      },
    };

    await expect(
      processAccountErasureRequest(
        context.db,
        accepted.requestId,
        "request-to-completion-worker-replay",
        phaseRunner,
        new Date(accepted.replayRetainedUntil),
      ),
    ).resolves.toEqual({
      retryAt: retentionVerificationAt,
      status: "waiting",
      waitReason: "retention",
    });

    await expect(findAccountErasureStatus(context.db, accepted.statusToken)).resolves.toEqual(
      expect.objectContaining({
        currentPhase: "processor_log_backup_retention",
        status: "waiting_retention",
      }),
    );
    expect(phaseRuns).not.toContain("retention_verification");
    const [peerDbCheckpoint] = await context.db.execute(
      sql`SELECT details
          FROM fitness.account_erasure_checkpoint
          WHERE request_id = ${accepted.requestId}::uuid
            AND phase = 'peerdb_drain_verification'`,
    );
    expect(peerDbCheckpoint).toEqual({
      details: {
        stagingBoundary: {
          cutoff: peerDbStagingBoundary.cutoff,
        },
      },
    });

    await expect(
      processAccountErasureRequest(
        context.db,
        accepted.requestId,
        "request-to-completion-worker-retention",
        phaseRunner,
        retentionVerificationAt,
      ),
    ).resolves.toEqual({ status: "completed" });

    expect(phaseRuns).toEqual(ACCOUNT_ERASURE_ACTIVE_PHASES);
    expect(retention.verifyPeerDbStagingRetention).toHaveBeenCalledWith({
      cutoff: new Date(peerDbStagingBoundary.cutoff),
      now: retentionVerificationAt,
    });
    await expect(findAccountErasureStatus(context.db, accepted.statusToken)).resolves.toEqual(
      expect.objectContaining({
        completedAt: retentionVerificationAt.toISOString(),
        currentPhase: "completed",
        deadlineMissed: false,
        message: null,
        status: "completed",
      }),
    );

    const rows = await context.db.execute(
      sql`SELECT
            request.user_id,
            request.encrypted_remote_snapshot,
            request.pii_scrubbed_at IS NOT NULL AS pii_scrubbed,
            request.completed_at IS NOT NULL AS completed,
            outbox.status AS outbox_status,
            EXISTS (
              SELECT 1
              FROM fitness.user_profile
              WHERE id = ${userId}::uuid
            ) AS profile_exists,
            EXISTS (
              SELECT 1
              FROM fitness.user_settings
              WHERE user_id = ${userId}::uuid
            ) AS settings_exist
          FROM fitness.account_erasure_request AS request
          JOIN fitness.account_erasure_outbox AS outbox
            ON outbox.request_id = request.id
          WHERE request.id = ${accepted.requestId}::uuid`,
    );
    expect(rows).toEqual([
      {
        completed: true,
        encrypted_remote_snapshot: null,
        outbox_status: "dispatched",
        pii_scrubbed: true,
        profile_exists: false,
        settings_exist: false,
        user_id: null,
      },
    ]);
  });

  it("retries safely when the worker stops after profile commit but before checkpointing", async () => {
    const crashUserId = "87000000-0000-4000-8000-000000001994";
    const crashRequestedAt = new Date("2026-06-01T00:00:00.000Z");
    const firstAttemptAt = new Date("2026-07-01T00:00:00.000Z");
    const retryAt = new Date("2026-07-01T02:00:00.000Z");
    await context.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name, email)
          VALUES (
            ${crashUserId}::uuid,
            'Crash-safe erasure',
            'crash-safe-erasure-1994@example.test'
          )`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.user_settings (user_id, key, value)
          VALUES (${crashUserId}::uuid, 'crash-safe-erasure', 'true'::jsonb)`,
    );
    const accepted = await initiateAccountErasure(
      context.db,
      crashUserId,
      async () => "encrypted-crash-safe-snapshot",
      async () => {},
      { now: crashRequestedAt },
    );
    await markAccountErasureDispatched(context.db, accepted.requestId);

    let stopAfterProfileCommit = true;
    let preProfileDeleteWalLsn: string | null = null;
    let firstPostProfileDeleteWalLsn: string | null = null;
    let peerDbCheckpoint: Record<string, unknown> | null = null;
    const phaseRunner = {
      async runPhase(
        phase: AccountErasurePhase,
        execution: AccountErasurePhaseExecution,
      ): Promise<Record<string, unknown> | null> {
        if (phase === "postgres_erasure") {
          await erasePostgresAccount(context.db, execution.request.id, crashUserId);
          return null;
        }
        if (phase === "postgres_profile_delete") {
          if (stopAfterProfileCommit) {
            preProfileDeleteWalLsn = await captureAccountErasurePostgresWalLsn(context.db);
          }
          const checkpoint = await execution.deleteProfile();
          if (stopAfterProfileCommit) {
            firstPostProfileDeleteWalLsn = checkpoint.walLsn;
            stopAfterProfileCommit = false;
            throw new Error("simulated worker termination after profile commit");
          }
          return checkpoint;
        }
        if (phase === "peerdb_drain_verification") {
          peerDbCheckpoint = await execution.loadCheckpointDetails("postgres_profile_delete");
        }
        if (phase === "request_pii_scrub") {
          await execution.scrubPii();
        }
        return null;
      },
    };

    await expect(
      processAccountErasureRequest(
        context.db,
        accepted.requestId,
        "crash-safe-worker-first",
        phaseRunner,
        firstAttemptAt,
      ),
    ).rejects.toThrow("simulated worker termination after profile commit");

    expect(preProfileDeleteWalLsn).toMatch(/^[0-9A-F]+\/[0-9A-F]+$/i);
    expect(firstPostProfileDeleteWalLsn).toMatch(/^[0-9A-F]+\/[0-9A-F]+$/i);
    const walRows = await context.db.execute(
      sql`SELECT pg_wal_lsn_diff(
            ${firstPostProfileDeleteWalLsn}::pg_lsn,
            ${preProfileDeleteWalLsn}::pg_lsn
          ) > 0 AS advanced`,
    );
    expect(walRows).toEqual([{ advanced: true }]);
    const afterTermination = await context.db.execute(
      sql`SELECT
            EXISTS (
              SELECT 1
              FROM fitness.user_profile
              WHERE id = ${crashUserId}::uuid
            ) AS profile_exists,
            EXISTS (
              SELECT 1
              FROM fitness.account_erasure_checkpoint
              WHERE request_id = ${accepted.requestId}::uuid
                AND phase = 'postgres_profile_delete'
            ) AS checkpoint_exists`,
    );
    expect(afterTermination).toEqual([
      {
        checkpoint_exists: false,
        profile_exists: false,
      },
    ]);

    await expect(
      processAccountErasureRequest(
        context.db,
        accepted.requestId,
        "crash-safe-worker-retry",
        phaseRunner,
        retryAt,
      ),
    ).resolves.toEqual({ status: "completed" });

    expect(peerDbCheckpoint).toEqual({
      walLsn: expect.stringMatching(/^[0-9A-F]+\/[0-9A-F]+$/i),
    });
  });
});
