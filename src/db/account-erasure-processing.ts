import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { captureAccountErasurePostgresWalLsn } from "../account-erasure/peerdb-erasure.ts";
import { assertPostgresAccountErasureComplete } from "../account-erasure/postgres-erasure.ts";
import type { AccountErasurePhase } from "../jobs/process-account-erasure-job.ts";
import type { Database } from "./index.ts";
import { executeWithSchema, timestampStringSchema } from "./typed-sql.ts";

const queuedRequestRowSchema = z.object({
  id: z.uuid(),
});
const checkpointRowSchema = z.object({ phase: z.string() });
const checkpointDetailsRowSchema = z.object({
  details: z.record(z.string(), z.unknown()).nullable(),
});
const claimedRequestRowSchema = z.object({
  completion_deadline: timestampStringSchema,
  encrypted_remote_snapshot: z.string().min(1).nullable(),
  id: z.uuid(),
  pii_scrubbed_at: timestampStringSchema.nullable(),
  requested_at: timestampStringSchema,
  replay_retained_until: timestampStringSchema,
  user_hash: z.string().length(64),
  user_hash_key_id: z.string().min(1),
  user_id: z.uuid().nullable(),
});
const idRowSchema = z.object({ id: z.uuid() });

export interface QueuedAccountErasureRequest {
  id: string;
}

export interface ClaimedAccountErasureRequest {
  completionDeadline: Date;
  encryptedRemoteSnapshot: string | null;
  id: string;
  piiScrubbedAt: Date | null;
  requestedAt: Date;
  replayRetainedUntil: Date;
  userHash: string;
  userHashKeyId: string;
  userId: string | null;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function isAccountErasureActive(
  database: Pick<Database, "execute">,
  userId: string,
): Promise<boolean> {
  const rows = await database.execute(
    sql`SELECT 1
        FROM fitness.account_erasure_request
        WHERE (
            user_id = ${userId}::uuid
            AND status <> 'completed'
          )
          OR write_fence_hash = ${sha256(userId)}
        LIMIT 1`,
  );
  return rows.length > 0;
}

export async function listPendingAccountErasureRequests(
  database: Pick<Database, "execute">,
  limit: number,
  now = new Date(),
): Promise<QueuedAccountErasureRequest[]> {
  const parsedLimit = z.number().int().positive().max(1_000).parse(limit);
  const rows = await executeWithSchema(
    database,
    queuedRequestRowSchema,
    sql`SELECT request.id
        FROM fitness.account_erasure_outbox AS outbox
        JOIN fitness.account_erasure_request AS request ON request.id = outbox.request_id
        WHERE request.status <> 'completed'
          AND (
            request.user_id IS NOT NULL
            OR request.pii_scrubbed_at IS NOT NULL
          )
          AND (request.retry_at IS NULL OR request.retry_at <= ${now.toISOString()})
          AND (
            request.lease_expires_at IS NULL
            OR request.lease_expires_at <= ${now.toISOString()}
          )
        ORDER BY request.retry_at NULLS FIRST, outbox.created_at, outbox.request_id
        LIMIT ${parsedLimit}`,
  );
  return rows;
}

export async function deleteExpiredAccountErasurePreparations(
  database: Pick<Database, "execute">,
  limit = 1_000,
  now = new Date(),
): Promise<number> {
  const parsedLimit = z.number().int().positive().max(10_000).parse(limit);
  const rows = await executeWithSchema(
    database,
    idRowSchema,
    sql`WITH expired AS (
          SELECT user_id
          FROM fitness.account_erasure_preparation
          WHERE expires_at <= ${now.toISOString()}
          ORDER BY expires_at, user_id
          LIMIT ${parsedLimit}
          FOR UPDATE SKIP LOCKED
        )
        DELETE FROM fitness.account_erasure_preparation AS preparation
        USING expired
        WHERE preparation.user_id = expired.user_id
        RETURNING preparation.user_id AS id`,
  );
  return rows.length;
}

export async function markAccountErasureDispatched(
  database: Pick<Database, "execute">,
  requestId: string,
): Promise<void> {
  await database.execute(
    sql`UPDATE fitness.account_erasure_outbox
        SET status = 'dispatched', dispatched_at = now()
        WHERE request_id = ${requestId}::uuid
          AND status = 'pending'`,
  );
}

export async function markOverdueAccountErasureRequests(
  database: Pick<Database, "execute">,
  now = new Date(),
): Promise<number> {
  const rows = await executeWithSchema(
    database,
    idRowSchema,
    sql`UPDATE fitness.account_erasure_request
        SET
          last_error =
            'Account erasure exceeded its 30-day completion deadline; deletion continues',
          updated_at = ${now.toISOString()}
        WHERE status <> 'completed'
          AND completion_deadline <= ${now.toISOString()}
          AND last_error IS DISTINCT FROM
            'Account erasure exceeded its 30-day completion deadline; deletion continues'
        RETURNING id`,
  );
  return rows.length;
}

export async function claimAccountErasureRequest(
  database: Pick<Database, "execute">,
  requestId: string,
  leaseOwner: string,
  leaseDurationMs: number,
  now = new Date(),
): Promise<ClaimedAccountErasureRequest | null> {
  const parsedLeaseOwner = z.string().min(1).max(200).parse(leaseOwner);
  const parsedLeaseDurationMs = z
    .number()
    .int()
    .min(30_000)
    .max(24 * 60 * 60 * 1_000)
    .parse(leaseDurationMs);
  const leaseExpiresAt = new Date(now.getTime() + parsedLeaseDurationMs);
  const rows = await executeWithSchema(
    database,
    claimedRequestRowSchema,
    sql`UPDATE fitness.account_erasure_request
        SET
          status = 'running',
          lease_owner = ${parsedLeaseOwner},
          lease_expires_at = ${leaseExpiresAt.toISOString()},
          started_at = COALESCE(started_at, ${now.toISOString()}),
          retry_at = NULL,
          updated_at = ${now.toISOString()}
        WHERE id = ${requestId}::uuid
          AND status <> 'completed'
          AND (
            (
              user_id IS NOT NULL
              AND encrypted_remote_snapshot IS NOT NULL
              AND pii_scrubbed_at IS NULL
            )
            OR (
              user_id IS NULL
              AND encrypted_remote_snapshot IS NULL
              AND pii_scrubbed_at IS NOT NULL
              AND EXISTS (
                SELECT 1
                FROM fitness.account_erasure_checkpoint AS checkpoint
                WHERE checkpoint.request_id =
                  fitness.account_erasure_request.id
                  AND checkpoint.phase = 'request_pii_scrub'
              )
            )
          )
          AND (
            lease_owner = ${parsedLeaseOwner}
            OR lease_expires_at IS NULL
            OR lease_expires_at <= ${now.toISOString()}
          )
        RETURNING
          id,
          user_id,
          user_hash,
          user_hash_key_id,
          encrypted_remote_snapshot,
          pii_scrubbed_at,
          requested_at,
          replay_retained_until,
          completion_deadline`,
  );
  const row = rows[0];
  return row
    ? {
        completionDeadline: new Date(row.completion_deadline),
        encryptedRemoteSnapshot: row.encrypted_remote_snapshot,
        id: row.id,
        piiScrubbedAt: row.pii_scrubbed_at ? new Date(row.pii_scrubbed_at) : null,
        requestedAt: new Date(row.requested_at),
        replayRetainedUntil: new Date(row.replay_retained_until),
        userHash: row.user_hash,
        userHashKeyId: row.user_hash_key_id,
        userId: row.user_id,
      }
    : null;
}

export async function renewAccountErasureLease(
  database: Pick<Database, "execute">,
  requestId: string,
  leaseOwner: string,
  leaseDurationMs: number,
  now = new Date(),
): Promise<void> {
  const parsedLeaseOwner = z.string().min(1).max(200).parse(leaseOwner);
  const parsedLeaseDurationMs = z
    .number()
    .int()
    .min(30_000)
    .max(24 * 60 * 60 * 1_000)
    .parse(leaseDurationMs);
  const leaseExpiresAt = new Date(now.getTime() + parsedLeaseDurationMs);
  const rows = await executeWithSchema(
    database,
    idRowSchema,
    sql`UPDATE fitness.account_erasure_request
        SET
          lease_expires_at = ${leaseExpiresAt.toISOString()},
          updated_at = ${now.toISOString()}
        WHERE id = ${requestId}::uuid
          AND lease_owner = ${parsedLeaseOwner}
          AND status <> 'completed'
        RETURNING id`,
  );
  if (rows.length !== 1) {
    throw new Error("Account erasure lease is no longer owned");
  }
}

export async function loadAccountErasureCheckpoints(
  database: Pick<Database, "execute">,
  requestId: string,
): Promise<ReadonlySet<string>> {
  const rows = await executeWithSchema(
    database,
    checkpointRowSchema,
    sql`SELECT phase
        FROM fitness.account_erasure_checkpoint
        WHERE request_id = ${requestId}::uuid`,
  );
  return new Set(rows.map((row) => row.phase));
}

export async function loadAccountErasureCheckpointDetails(
  database: Pick<Database, "execute">,
  requestId: string,
  phase: AccountErasurePhase,
): Promise<Record<string, unknown> | null> {
  const rows = await executeWithSchema(
    database,
    checkpointDetailsRowSchema,
    sql`SELECT details
        FROM fitness.account_erasure_checkpoint
        WHERE request_id = ${requestId}::uuid
          AND phase = ${phase}
        LIMIT 1`,
  );
  return rows[0]?.details ?? null;
}

export async function loadAccountErasurePhaseProgress(
  database: Pick<Database, "execute">,
  requestId: string,
  phase: AccountErasurePhase,
): Promise<Record<string, unknown> | null> {
  const rows = await executeWithSchema(
    database,
    checkpointDetailsRowSchema,
    sql`SELECT phase_progress -> ${phase} AS details
        FROM fitness.account_erasure_request
        WHERE id = ${requestId}::uuid
        LIMIT 1`,
  );
  return rows[0]?.details ?? null;
}

export async function saveAccountErasurePhaseProgress(
  database: Pick<Database, "execute">,
  requestId: string,
  leaseOwner: string,
  phase: AccountErasurePhase,
  details: Record<string, unknown>,
): Promise<void> {
  const rows = await executeWithSchema(
    database,
    idRowSchema,
    sql`UPDATE fitness.account_erasure_request
        SET
          phase_progress = jsonb_set(
            phase_progress,
            ARRAY[${phase}],
            ${JSON.stringify(details)}::jsonb,
            true
          ),
          updated_at = now()
        WHERE id = ${requestId}::uuid
          AND lease_owner = ${leaseOwner}
          AND status <> 'completed'
        RETURNING id`,
  );
  if (rows.length !== 1) {
    throw new Error("Account erasure lease was lost while saving phase progress");
  }
}

export async function markAccountErasurePhaseCompleted(
  database: Pick<Database, "transaction">,
  requestId: string,
  leaseOwner: string,
  phase: AccountErasurePhase,
  details: Record<string, unknown> | null = null,
): Promise<void> {
  await database.transaction(async (transaction) => {
    const rows = await executeWithSchema(
      transaction,
      idRowSchema,
      sql`UPDATE fitness.account_erasure_request
          SET
            status = 'running',
            current_phase = ${phase},
            started_at = COALESCE(started_at, now()),
            retry_at = NULL,
            last_error = NULL,
            updated_at = now()
          WHERE id = ${requestId}::uuid
            AND lease_owner = ${leaseOwner}
            AND status <> 'completed'
          RETURNING id`,
    );
    if (rows.length !== 1) {
      throw new Error("Account erasure lease was lost before checkpointing");
    }
    const checkpoints = await executeWithSchema(
      transaction,
      z.object({ request_id: z.uuid() }),
      sql`INSERT INTO fitness.account_erasure_checkpoint (
            request_id, phase, details
          )
          VALUES (
            ${requestId}::uuid,
            ${phase},
            ${details ? JSON.stringify(details) : null}::jsonb
          )
          ON CONFLICT (request_id, phase) DO UPDATE
            SET details = EXCLUDED.details
          RETURNING request_id`,
    );
    if (checkpoints.length !== 1) {
      throw new Error("Account erasure checkpoint was not persisted");
    }
  });
}

export async function markAccountErasureWaiting(
  database: Pick<Database, "execute">,
  requestId: string,
  leaseOwner: string,
  retryAt: Date,
  reason: "replay" | "retention",
): Promise<void> {
  const status = reason === "replay" ? "waiting_replay" : "waiting_retention";
  const currentPhase = reason === "replay" ? "replay_retention" : "processor_log_backup_retention";
  const rows = await executeWithSchema(
    database,
    idRowSchema,
    sql`UPDATE fitness.account_erasure_request
        SET
          status = ${status},
          current_phase = ${currentPhase},
          retry_at = ${retryAt.toISOString()},
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = now()
        WHERE id = ${requestId}::uuid
          AND lease_owner = ${leaseOwner}
          AND status <> 'completed'
        RETURNING id`,
  );
  if (rows.length !== 1) {
    throw new Error(`Account erasure lease was lost while scheduling ${reason} verification`);
  }
}

export async function markAccountErasureFailed(
  database: Pick<Database, "execute">,
  requestId: string,
  leaseOwner: string,
  failure: string,
  now = new Date(),
): Promise<void> {
  const retryAt = new Date(now.getTime() + 60 * 60 * 1_000);
  const rows = await executeWithSchema(
    database,
    idRowSchema,
    sql`UPDATE fitness.account_erasure_request
        SET
          status = 'failed',
          failure_count = failure_count + 1,
          last_error = ${failure},
          retry_at = ${retryAt.toISOString()},
          lease_owner = NULL,
          lease_expires_at = NULL,
          updated_at = ${now.toISOString()}
        WHERE id = ${requestId}::uuid
          AND lease_owner = ${leaseOwner}
          AND status <> 'completed'
        RETURNING id`,
  );
  if (rows.length !== 1) {
    throw new Error("Account erasure lease was lost while persisting failure");
  }
}

export async function deleteAccountErasureUserProfile(
  database: Pick<Database, "execute" | "transaction">,
  requestId: string,
  userId: string,
  leaseOwner: string,
): Promise<{ walLsn: string }> {
  await database.transaction(async (transaction) => {
    const ownedRequests = await executeWithSchema(
      transaction,
      z.object({ id: z.uuid() }),
      sql`SELECT id
          FROM fitness.account_erasure_request
          WHERE id = ${requestId}::uuid
            AND user_id = ${userId}::uuid
            AND lease_owner = ${leaseOwner}
            AND status <> 'completed'
          FOR UPDATE`,
    );
    if (ownedRequests.length !== 1) {
      throw new Error("Account erasure request does not own the supplied user");
    }
    await executeWithSchema(
      transaction,
      z.object({ id: z.uuid() }),
      sql`DELETE FROM fitness.user_profile
          WHERE id = ${userId}::uuid
          RETURNING id`,
    );
    // A zero-row delete is the expected retry state after a worker stops
    // between the committed delete and its durable phase checkpoint.
    await assertPostgresAccountErasureComplete(transaction, userId);
  });
  // Capture after the delete transaction commits so PeerDB must replicate
  // through the user-profile tombstone before final ClickHouse verification.
  return {
    walLsn: await captureAccountErasurePostgresWalLsn(database),
  };
}

const ACCOUNT_ERASURE_PII_SCRUB_PREREQUISITES = [
  "work_verification",
  "consumer_drain_verification",
  "stripe_erasure_verification",
  "remote_revocation_verification",
  "processor_erasure_verification",
  "postgres_profile_delete",
  "peerdb_drain_verification",
  "clickhouse_verification",
  "archive_verification",
] as const satisfies readonly AccountErasurePhase[];

export async function scrubAccountErasureRequestPii(
  database: Pick<Database, "transaction">,
  requestId: string,
  userId: string,
  leaseOwner: string,
  scrubbedAt = new Date(),
): Promise<void> {
  await database.transaction(async (transaction) => {
    const ownedRequests = await executeWithSchema(
      transaction,
      z.object({ id: z.uuid() }),
      sql`SELECT id
          FROM fitness.account_erasure_request
          WHERE id = ${requestId}::uuid
            AND user_id = ${userId}::uuid
            AND encrypted_remote_snapshot IS NOT NULL
            AND pii_scrubbed_at IS NULL
            AND lease_owner = ${leaseOwner}
            AND status <> 'completed'
          FOR UPDATE`,
    );
    if (ownedRequests.length !== 1) {
      throw new Error("Account erasure request does not own PII eligible for scrubbing");
    }

    const completedPhases = new Set(
      (
        await executeWithSchema(
          transaction,
          checkpointRowSchema,
          sql`SELECT phase
              FROM fitness.account_erasure_checkpoint
              WHERE request_id = ${requestId}::uuid`,
        )
      ).map((row) => row.phase),
    );
    const missingPhases = ACCOUNT_ERASURE_PII_SCRUB_PREREQUISITES.filter(
      (phase) => !completedPhases.has(phase),
    );
    if (missingPhases.length > 0) {
      throw new Error(
        `Account erasure cannot scrub request PII before verification phases complete: ${missingPhases.join(", ")}`,
      );
    }

    const profiles = await executeWithSchema(
      transaction,
      z.object({ count: z.coerce.number().int().nonnegative() }),
      sql`SELECT count(*)::integer AS count
          FROM fitness.user_profile
          WHERE id = ${userId}::uuid`,
    );
    if (profiles[0]?.count !== 0) {
      throw new Error("Account erasure cannot scrub request PII before deleting the user profile");
    }

    await transaction.execute(
      sql`INSERT INTO fitness.account_erasure_checkpoint (
            request_id, phase, details
          )
          VALUES (${requestId}::uuid, 'request_pii_scrub', NULL)
          ON CONFLICT (request_id, phase) DO UPDATE SET details = NULL`,
    );
    await transaction.execute(
      sql`UPDATE fitness.account_erasure_checkpoint
          SET details =
            CASE
              WHEN phase = 'consumer_drain' THEN jsonb_build_object(
                'quarantineHighWatermarks',
                details -> 'quarantineHighWatermarks'
              )
              WHEN phase = 'peerdb_drain_verification' THEN jsonb_build_object(
                'stagingBoundary',
                jsonb_build_object(
                  'cutoff',
                  details #> '{stagingBoundary,cutoff}'
                )
              )
              ELSE NULL
            END
          WHERE request_id = ${requestId}::uuid`,
    );
    const scrubbedRequests = await executeWithSchema(
      transaction,
      idRowSchema,
      sql`UPDATE fitness.account_erasure_request
          SET
            user_id = NULL,
            encrypted_remote_snapshot = NULL,
            phase_progress = '{}'::jsonb,
            pii_scrubbed_at = ${scrubbedAt.toISOString()},
            current_phase = 'request_pii_scrub',
            last_error = NULL,
            updated_at = ${scrubbedAt.toISOString()}
          WHERE id = ${requestId}::uuid
            AND user_id = ${userId}::uuid
            AND lease_owner = ${leaseOwner}
            AND status <> 'completed'
          RETURNING id`,
    );
    if (scrubbedRequests.length !== 1) {
      throw new Error("Account erasure request PII scrub was not persisted");
    }
  });
}

export async function completeAccountErasure(
  database: Pick<Database, "transaction">,
  requestId: string,
  leaseOwner: string,
  completedAt = new Date(),
): Promise<void> {
  await database.transaction(async (transaction) => {
    const ownedRequests = await executeWithSchema(
      transaction,
      z.object({ id: z.uuid() }),
      sql`SELECT id
          FROM fitness.account_erasure_request
          WHERE id = ${requestId}::uuid
            AND lease_owner = ${leaseOwner}
            AND status <> 'completed'
            AND user_id IS NULL
            AND encrypted_remote_snapshot IS NULL
            AND pii_scrubbed_at IS NOT NULL
            AND EXISTS (
              SELECT 1
              FROM fitness.account_erasure_checkpoint AS checkpoint
              WHERE checkpoint.request_id =
                fitness.account_erasure_request.id
                AND checkpoint.phase = 'retention_verification'
            )
          FOR UPDATE`,
    );
    if (ownedRequests.length !== 1) {
      throw new Error("Account erasure request is not ready for pseudonymous completion");
    }

    await transaction.execute(
      sql`DELETE FROM fitness.account_erasure_identity_fence
          WHERE request_id = ${requestId}::uuid`,
    );
    await transaction.execute(
      sql`DELETE FROM fitness.account_erasure_checkpoint
          WHERE request_id = ${requestId}::uuid`,
    );
    const completedRequests = await executeWithSchema(
      transaction,
      z.object({ id: z.uuid() }),
      sql`UPDATE fitness.account_erasure_request
          SET
            user_id = NULL,
            encrypted_remote_snapshot = NULL,
            phase_progress = '{}'::jsonb,
            status = 'completed',
            current_phase = 'completed',
            completed_at = ${completedAt.toISOString()},
            retry_at = NULL,
            lease_owner = NULL,
            lease_expires_at = NULL,
            last_error = NULL,
            updated_at = now()
          WHERE id = ${requestId}::uuid
            AND lease_owner = ${leaseOwner}
            AND status <> 'completed'
          RETURNING id`,
    );
    if (completedRequests.length !== 1) {
      throw new Error("Account erasure request completion was not persisted");
    }
  });
}
