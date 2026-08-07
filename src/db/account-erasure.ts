import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  type AccountErasureExternalIdentity,
  type AccountErasureUserIdentity,
  createAccountErasureExternalIdentityHashes,
  createAccountErasureUserIdentities,
  createAccountErasureUserIdentity,
} from "../account-erasure/identity.ts";
import type { AccountErasureRestoreIntent } from "../account-erasure/restore-ledger.ts";
import { lockAccountErasureActivation } from "./account-erasure-locks.ts";
import type { Database, TransactionDatabase } from "./index.ts";
import {
  executeWithSchema,
  type SchemaExecutionDatabase,
  timestampStringSchema,
} from "./typed-sql.ts";

const replayRetentionMs = 7 * 24 * 60 * 60 * 1_000;
const completionWindowMs = 30 * 24 * 60 * 60 * 1_000;
const preparationWindowMs = 15 * 60 * 1_000;
const bearerTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);

const accountErasureStatusSchema = z.enum([
  "pending",
  "running",
  "waiting_replay",
  "waiting_retention",
  "failed",
  "completed",
]);

const requestRowSchema = z.object({
  completed_at: timestampStringSchema.nullable(),
  completion_deadline: timestampStringSchema,
  current_phase: z.string().nullable(),
  id: z.uuid(),
  last_error: z.string().nullable(),
  replay_retained_until: timestampStringSchema,
  requested_at: timestampStringSchema,
  retry_at: timestampStringSchema.nullable(),
  status: accountErasureStatusSchema,
  user_id: z.uuid().nullable(),
});

const accountErasurePreparationRowSchema = z.object({
  expires_at: timestampStringSchema,
  request_id: z.uuid(),
  user_id: z.uuid(),
});
const accountErasureConfirmationRowSchema = z.object({
  completion_deadline: timestampStringSchema,
  id: z.uuid(),
  replay_retained_until: timestampStringSchema,
  requested_at: timestampStringSchema,
  status_token_hash: z.string().length(64),
  user_hash: z.string().length(64),
  user_hash_key_id: z.string().min(1),
});
const activeAccountErasureRequestRowSchema = z.object({
  id: z.uuid(),
});
const authIdentityRowSchema = z.object({
  auth_provider: z.string().min(1),
  provider_account_id: z.string().min(1),
});
const emailIdentityRowSchema = z.object({
  email: z.string().email(),
});

export type AccountErasureStatus = z.infer<typeof accountErasureStatusSchema>;

export interface AccountErasurePublicStatus {
  completedAt: string | null;
  currentPhase: string | null;
  deadlineMissed: boolean;
  id: string;
  message: string | null;
  replayRetainedUntil: string;
  requestedAt: string;
  retentionUntil: string;
  status: AccountErasureStatus;
}

export interface AccountErasureInitiation {
  replayRetainedUntil: string;
  requestId: string;
  retentionUntil: string;
  statusToken: string;
}

export interface AccountErasurePreparation {
  expiresAt: string;
  preparationToken: string;
}

export interface InitiateAccountErasureOptions {
  identity?: AccountErasureUserIdentity;
  now?: Date;
  preparationTokenHash?: string;
  recoveredFromRestore?: boolean;
  requestId?: string;
  statusToken?: string;
}

export interface ConfirmAccountErasureDependencies {
  createEncryptedRemoteSnapshot(database: TransactionDatabase, userId: string): Promise<string>;
  findRestoreIntent(
    reference: Pick<AccountErasureRestoreIntent, "keyId" | "requestId" | "userHash">,
  ): Promise<AccountErasureRestoreIntent | null>;
  persistRestoreIntent(intent: AccountErasureRestoreIntent): Promise<void>;
}

export class AccountErasurePreparationUnavailableError extends Error {
  constructor() {
    super("Account deletion preparation is invalid or expired. Sign in again to restart.");
    this.name = "AccountErasurePreparationUnavailableError";
  }
}

export class AccountErasureIdentityFencedError extends Error {
  constructor() {
    super(
      "This identity belongs to an account that is currently being deleted. Try again after deletion completes.",
    );
    this.name = "AccountErasureIdentityFencedError";
  }
}

export class AccountErasureUserFencedError extends Error {
  constructor(cause?: unknown) {
    super("Account deletion is active for this user.", { cause });
    this.name = "AccountErasureUserFencedError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function isAccountErasureUserFenceDatabaseError(error: unknown): boolean {
  let candidate: unknown = error;
  while (isRecord(candidate)) {
    if (
      candidate.code === "55000" &&
      typeof candidate.message === "string" &&
      candidate.message.includes("Account erasure is active for user")
    ) {
      return true;
    }
    candidate = candidate.cause;
  }
  return false;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function secureHashesEqual(first: string, second: string): boolean {
  const firstBytes = Buffer.from(first, "hex");
  const secondBytes = Buffer.from(second, "hex");
  return firstBytes.length === secondBytes.length && timingSafeEqual(firstBytes, secondBytes);
}

function accountErasureIdentityFenceCandidates(
  identities: readonly AccountErasureExternalIdentity[],
) {
  return [
    ...new Map(
      identities
        .flatMap((identity) => createAccountErasureExternalIdentityHashes(identity))
        .map((candidate) => [
          `${candidate.identityKind}:${candidate.keyId}:${candidate.identityHash}`,
          candidate,
        ]),
    ).values(),
  ].sort(
    (left, right) =>
      left.identityKind.localeCompare(right.identityKind) ||
      left.keyId.localeCompare(right.keyId) ||
      left.identityHash.localeCompare(right.identityHash),
  );
}

export async function isAccountErasureIdentityFenced(
  database: SchemaExecutionDatabase,
  identities: readonly AccountErasureExternalIdentity[],
): Promise<boolean> {
  const candidates = accountErasureIdentityFenceCandidates(identities);
  if (candidates.length === 0) return false;
  const candidateValues = sql.join(
    candidates.map(
      (candidate) =>
        sql`(
          ${candidate.identityKind},
          ${candidate.keyId},
          ${candidate.identityHash}
        )`,
    ),
    sql`, `,
  );
  const rows = await executeWithSchema(
    database,
    z.object({ fenced: z.boolean() }),
    sql`WITH candidate(identity_kind, key_id, identity_hash) AS (
          VALUES ${candidateValues}
        )
        SELECT EXISTS (
          SELECT 1
          FROM candidate
          JOIN fitness.account_erasure_identity_fence AS fence
            USING (identity_kind, key_id, identity_hash)
          JOIN fitness.account_erasure_request AS request
            ON request.id = fence.request_id
          WHERE request.status <> 'completed'
        ) AS fenced`,
  );
  return rows[0]?.fenced ?? false;
}

export async function assertAccountErasureIdentityNotFenced(
  database: SchemaExecutionDatabase,
  identities: readonly AccountErasureExternalIdentity[],
): Promise<void> {
  if (await isAccountErasureIdentityFenced(database, identities)) {
    throw new AccountErasureIdentityFencedError();
  }
}

async function lockAccountErasureIdentityCandidates(
  transaction: TransactionDatabase,
  identities: readonly AccountErasureExternalIdentity[],
): Promise<void> {
  for (const candidate of accountErasureIdentityFenceCandidates(identities)) {
    const lockKey = [
      "account-erasure-identity",
      candidate.identityKind,
      candidate.keyId,
      candidate.identityHash,
    ].join(":");
    await transaction.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
  }
}

export async function lockAndAssertAccountErasureIdentityWriteFence(
  transaction: TransactionDatabase,
  identities: readonly AccountErasureExternalIdentity[],
): Promise<void> {
  await lockAccountErasureIdentityCandidates(transaction, identities);
  await assertAccountErasureIdentityNotFenced(transaction, identities);
}

export async function withAccountErasureIdentityWriteFence<T>(
  database: Pick<Database, "transaction">,
  identities: readonly AccountErasureExternalIdentity[],
  operation: (transaction: TransactionDatabase) => Promise<T>,
): Promise<T> {
  return database.transaction(async (transaction) => {
    await lockAndAssertAccountErasureIdentityWriteFence(transaction, identities);
    return operation(transaction);
  });
}

async function lockAndRejectAccountErasureUserWrite(
  transaction: TransactionDatabase,
  userId: string,
): Promise<void> {
  try {
    await transaction.execute(
      sql`SELECT fitness.lock_and_reject_account_erasure_write(${userId}::uuid)`,
    );
  } catch (error: unknown) {
    if (isAccountErasureUserFenceDatabaseError(error)) {
      throw new AccountErasureUserFencedError(error);
    }
    throw error;
  }
}

export async function withAccountErasureUserWriteFence<T>(
  database: Pick<Database, "transaction">,
  userId: string,
  operation: (transaction: TransactionDatabase) => Promise<T>,
): Promise<T> {
  return database.transaction(async (transaction) => {
    await lockAndRejectAccountErasureUserWrite(transaction, userId);
    return operation(transaction);
  });
}

export async function withAccountErasureUserAndIdentityWriteFence<T>(
  database: Pick<Database, "transaction">,
  userId: string,
  identities: readonly AccountErasureExternalIdentity[],
  operation: (transaction: TransactionDatabase) => Promise<T>,
): Promise<T> {
  return database.transaction(async (transaction) => {
    await lockAndRejectAccountErasureUserWrite(transaction, userId);
    await lockAndAssertAccountErasureIdentityWriteFence(transaction, identities);
    return operation(transaction);
  });
}

async function loadAccountErasureExternalIdentities(
  transaction: TransactionDatabase,
  userId: string,
): Promise<AccountErasureExternalIdentity[]> {
  const authIdentities = await executeWithSchema(
    transaction,
    authIdentityRowSchema,
    sql`SELECT auth_provider, provider_account_id
        FROM fitness.auth_account
        WHERE user_id = ${userId}::uuid
        ORDER BY auth_provider, provider_account_id`,
  );
  const emailIdentities = await executeWithSchema(
    transaction,
    emailIdentityRowSchema,
    sql`SELECT email
        FROM (
          SELECT email
          FROM fitness.user_profile
          WHERE id = ${userId}::uuid
          UNION
          SELECT email
          FROM fitness.auth_account
          WHERE user_id = ${userId}::uuid
          UNION
          SELECT email
          FROM fitness.user_password_credential
          WHERE user_id = ${userId}::uuid
        ) AS identity_email
        WHERE email IS NOT NULL
        ORDER BY email`,
  );
  const providerAccountIdentities: AccountErasureExternalIdentity[] = authIdentities.map(
    (identity) => ({
      authProvider: identity.auth_provider,
      kind: "provider_account",
      providerAccountId: identity.provider_account_id,
    }),
  );
  const normalizedEmailIdentities: AccountErasureExternalIdentity[] = emailIdentities.map(
    (identity) => ({
      email: identity.email,
      kind: "email",
    }),
  );
  return [...providerAccountIdentities, ...normalizedEmailIdentities];
}

async function recordAccountErasureIdentityFences(
  transaction: TransactionDatabase,
  requestId: string,
  identities: readonly AccountErasureExternalIdentity[],
): Promise<void> {
  for (const fence of accountErasureIdentityFenceCandidates(identities)) {
    const rows = await executeWithSchema(
      transaction,
      z.object({ request_id: z.uuid() }),
      sql`INSERT INTO fitness.account_erasure_identity_fence (
            request_id, identity_kind, key_id, identity_hash
          )
          VALUES (
            ${requestId}::uuid,
            ${fence.identityKind},
            ${fence.keyId},
            ${fence.identityHash}
          )
          ON CONFLICT (identity_kind, key_id, identity_hash) DO UPDATE
            SET request_id = EXCLUDED.request_id
            WHERE
              fitness.account_erasure_identity_fence.request_id =
                EXCLUDED.request_id
              OR EXISTS (
                SELECT 1
                FROM fitness.account_erasure_request AS previous_request
                WHERE previous_request.id =
                  fitness.account_erasure_identity_fence.request_id
                  AND previous_request.status = 'completed'
              )
          RETURNING request_id`,
    );
    if (rows.length !== 1 || rows[0]?.request_id !== requestId) {
      throw new Error(`Account erasure identity fence is already owned by another request`);
    }
  }
}

async function activateAccountErasureInTransaction(
  transaction: TransactionDatabase,
  userId: string,
  createEncryptedRemoteSnapshot: (database: TransactionDatabase) => Promise<string>,
  persistRestoreIntent: (intent: AccountErasureRestoreIntent) => Promise<void>,
  requestId: string,
  statusToken: string,
  identity: AccountErasureUserIdentity,
  requestedAt: Date,
  acceptedAt: Date,
  options: Pick<InitiateAccountErasureOptions, "preparationTokenHash" | "recoveredFromRestore">,
): Promise<AccountErasureInitiation> {
  const replayRetainedUntil = new Date(requestedAt.getTime() + replayRetentionMs);
  const completionDeadline = new Date(requestedAt.getTime() + completionWindowMs);
  const profiles = await executeWithSchema(
    transaction,
    z.object({ id: z.uuid() }),
    sql`SELECT id
        FROM fitness.user_profile
        WHERE id = ${userId}::uuid
        FOR UPDATE`,
  );
  if (profiles.length === 0) {
    throw new Error("Account not found");
  }

  const externalIdentities = await loadAccountErasureExternalIdentities(transaction, userId);
  await lockAccountErasureIdentityCandidates(transaction, externalIdentities);
  await assertAccountErasureIdentityNotFenced(transaction, externalIdentities);
  const encryptedRemoteSnapshot = await createEncryptedRemoteSnapshot(transaction);
  await persistRestoreIntent({
    keyId: identity.keyId,
    requestId,
    requestedAt: requestedAt.toISOString(),
    statusToken,
    userHash: identity.userHash,
  });

  await transaction.execute(sql`DELETE FROM fitness.session WHERE user_id = ${userId}::uuid`);
  await transaction.execute(
    sql`DELETE FROM fitness.companion_token WHERE user_id = ${userId}::uuid`,
  );
  await transaction.execute(sql`DELETE FROM fitness.shared_report WHERE user_id = ${userId}::uuid`);
  await transaction.execute(
    sql`UPDATE fitness.mcp_access_token
        SET revoked_at = COALESCE(revoked_at, ${requestedAt.toISOString()})
        WHERE user_id = ${userId}::uuid`,
  );
  await transaction.execute(
    sql`INSERT INTO fitness.account_erasure_request (
          id,
          user_id,
          user_hash,
          user_hash_key_id,
          write_fence_hash,
          preparation_token_hash,
          status_token_hash,
          encrypted_remote_snapshot,
          requested_at,
          replay_retained_until,
          completion_deadline,
          recovered_from_restore
        )
        VALUES (
          ${requestId}::uuid,
          ${userId}::uuid,
          ${identity.userHash},
          ${identity.keyId},
          ${sha256(userId)},
          ${options.preparationTokenHash ?? null},
          ${sha256(statusToken)},
          ${encryptedRemoteSnapshot},
          ${requestedAt.toISOString()},
          ${replayRetainedUntil.toISOString()},
          ${completionDeadline.toISOString()},
          ${options.recoveredFromRestore ? acceptedAt.toISOString() : null}
        )`,
  );
  await transaction.execute(
    sql`INSERT INTO fitness.account_erasure_outbox (request_id)
        VALUES (${requestId}::uuid)`,
  );
  await recordAccountErasureIdentityFences(transaction, requestId, externalIdentities);

  return {
    replayRetainedUntil: replayRetainedUntil.toISOString(),
    requestId,
    retentionUntil: completionDeadline.toISOString(),
    statusToken,
  };
}

export async function initiateAccountErasure(
  database: Pick<Database, "transaction">,
  userId: string,
  createEncryptedRemoteSnapshot: (database: TransactionDatabase) => Promise<string>,
  persistRestoreIntent: (intent: AccountErasureRestoreIntent) => Promise<void>,
  options: InitiateAccountErasureOptions = {},
): Promise<AccountErasureInitiation> {
  const requestId = options.requestId ? z.uuid().parse(options.requestId) : randomUUID();
  const statusToken = options.statusToken
    ? bearerTokenSchema.parse(options.statusToken)
    : randomBytes(32).toString("base64url");
  const acceptedAt = new Date();
  const requestedAt = options.now ?? acceptedAt;
  const identity = options.identity ?? createAccountErasureUserIdentity(userId);

  return database.transaction(async (transaction) => {
    await lockAccountErasureActivation(transaction, userId);
    if (options.recoveredFromRestore) {
      const [activeRequest] = await executeWithSchema(
        transaction,
        accountErasureConfirmationRowSchema,
        sql`SELECT
              id,
              user_hash,
              user_hash_key_id,
              status_token_hash,
              requested_at,
              replay_retained_until,
              completion_deadline
            FROM fitness.account_erasure_request
            WHERE user_id = ${userId}::uuid
              AND status <> 'completed'
            LIMIT 1`,
      );
      if (activeRequest) {
        if (
          activeRequest.id !== requestId ||
          !statusTokenMatchesHash(statusToken, activeRequest.status_token_hash)
        ) {
          throw new Error(
            `Active account erasure request ${activeRequest.id} conflicts with restore intent ${requestId}`,
          );
        }
        return {
          replayRetainedUntil: activeRequest.replay_retained_until,
          requestId: activeRequest.id,
          retentionUntil: activeRequest.completion_deadline,
          statusToken,
        };
      }
    }
    return activateAccountErasureInTransaction(
      transaction,
      userId,
      createEncryptedRemoteSnapshot,
      persistRestoreIntent,
      requestId,
      statusToken,
      identity,
      requestedAt,
      acceptedAt,
      options,
    );
  });
}

function matchingRestoreIntentsForUser(
  userId: string,
  intents: readonly AccountErasureRestoreIntent[],
): AccountErasureRestoreIntent[] {
  const identities = new Set(
    createAccountErasureUserIdentities(userId).map(
      (identity) => `${identity.keyId}:${identity.userHash}`,
    ),
  );
  return intents
    .filter((intent) => identities.has(`${intent.keyId}:${intent.userHash}`))
    .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt));
}

export async function prepareAccountErasure(
  database: Pick<Database, "transaction">,
  userId: string,
  listRestoreIntentsForIdentities: (
    identities: readonly AccountErasureUserIdentity[],
  ) => Promise<readonly AccountErasureRestoreIntent[]>,
  now = new Date(),
): Promise<AccountErasurePreparation> {
  const preparationToken = randomBytes(32).toString("base64url");
  const preparationTokenHash = sha256(preparationToken);
  const expiresAt = new Date(now.getTime() + preparationWindowMs);

  await database.transaction(async (transaction) => {
    const identities = createAccountErasureUserIdentities(userId);
    await transaction.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${userId}::text, 0))`,
    );
    const matchingIntents = matchingRestoreIntentsForUser(
      userId,
      await listRestoreIntentsForIdentities(identities),
    );
    const profiles = await executeWithSchema(
      transaction,
      z.object({ id: z.uuid() }),
      sql`SELECT id
          FROM fitness.user_profile
          WHERE id = ${userId}::uuid
          FOR UPDATE`,
    );
    if (profiles.length === 0) {
      throw new Error("Account not found");
    }

    const activeRequests = await executeWithSchema(
      transaction,
      activeAccountErasureRequestRowSchema,
      sql`SELECT id
          FROM fitness.account_erasure_request
          WHERE user_id = ${userId}::uuid
            AND status <> 'completed'
          LIMIT 1`,
    );
    const activeRequest = activeRequests[0];
    const acceptedIntent = activeRequest
      ? matchingIntents.find((intent) => intent.requestId === activeRequest.id)
      : matchingIntents[0];
    if (activeRequest && !acceptedIntent) {
      throw new Error(
        `Active account erasure request ${activeRequest.id} has no matching restore intent`,
      );
    }
    const requestId = acceptedIntent?.requestId ?? randomUUID();

    await transaction.execute(
      sql`DELETE FROM fitness.account_erasure_preparation
          WHERE user_id = ${userId}::uuid`,
    );
    await transaction.execute(
      sql`INSERT INTO fitness.account_erasure_preparation (
            user_id,
            request_id,
            preparation_token_hash,
            expires_at,
            created_at
          )
          VALUES (
            ${userId}::uuid,
            ${requestId}::uuid,
            ${preparationTokenHash},
            ${expiresAt.toISOString()},
            ${now.toISOString()}
          )`,
    );
  });

  return {
    expiresAt: expiresAt.toISOString(),
    preparationToken,
  };
}

async function recoverAccountErasureConfirmation(
  dependencies: ConfirmAccountErasureDependencies,
  row: z.infer<typeof accountErasureConfirmationRowSchema>,
): Promise<AccountErasureInitiation> {
  const intent = await dependencies.findRestoreIntent({
    keyId: row.user_hash_key_id,
    requestId: row.id,
    userHash: row.user_hash,
  });
  if (!intent || !statusTokenMatchesHash(intent.statusToken, row.status_token_hash)) {
    throw new Error(`Account erasure request ${row.id} has no matching restore intent`);
  }
  return {
    replayRetainedUntil: row.replay_retained_until,
    requestId: row.id,
    retentionUntil: row.completion_deadline,
    statusToken: intent.statusToken,
  };
}

function statusTokenMatchesHash(statusToken: string, expectedHash: string): boolean {
  return secureHashesEqual(sha256(statusToken), expectedHash);
}

export async function confirmAccountErasure(
  database: Pick<Database, "transaction">,
  preparationToken: string,
  dependencies: ConfirmAccountErasureDependencies,
  now = new Date(),
): Promise<AccountErasureInitiation> {
  const preparationTokenHash = sha256(bearerTokenSchema.parse(preparationToken));
  const result = await database.transaction(async (transaction) => {
    const unlockedPreparations = await executeWithSchema(
      transaction,
      accountErasurePreparationRowSchema,
      sql`SELECT user_id, request_id, expires_at
          FROM fitness.account_erasure_preparation
          WHERE preparation_token_hash = ${preparationTokenHash}
          LIMIT 1`,
    );
    const unlockedPreparation = unlockedPreparations[0];

    if (unlockedPreparation) {
      await lockAccountErasureActivation(transaction, unlockedPreparation.user_id);
      const preparations = await executeWithSchema(
        transaction,
        accountErasurePreparationRowSchema,
        sql`SELECT user_id, request_id, expires_at
            FROM fitness.account_erasure_preparation
            WHERE preparation_token_hash = ${preparationTokenHash}
            FOR UPDATE`,
      );
      const preparation = preparations[0];
      if (preparation) {
        if (new Date(preparation.expires_at).getTime() <= now.getTime()) {
          await transaction.execute(
            sql`DELETE FROM fitness.account_erasure_preparation
                WHERE preparation_token_hash = ${preparationTokenHash}`,
          );
          return null;
        }

        const existingRequests = await executeWithSchema(
          transaction,
          accountErasureConfirmationRowSchema,
          sql`SELECT
                id,
                user_hash,
                user_hash_key_id,
                status_token_hash,
                requested_at,
                replay_retained_until,
                completion_deadline
              FROM fitness.account_erasure_request
              WHERE id = ${preparation.request_id}::uuid
                AND completion_deadline >= ${now.toISOString()}
              LIMIT 1`,
        );
        const existingRequest = existingRequests[0];
        if (existingRequest) {
          await transaction.execute(
            sql`UPDATE fitness.account_erasure_request
                SET preparation_token_hash = ${preparationTokenHash}
                WHERE id = ${existingRequest.id}::uuid`,
          );
          await transaction.execute(
            sql`DELETE FROM fitness.account_erasure_preparation
                WHERE preparation_token_hash = ${preparationTokenHash}`,
          );
          return recoverAccountErasureConfirmation(dependencies, existingRequest);
        }

        const identities = createAccountErasureUserIdentities(preparation.user_id);
        let acceptedIntent: AccountErasureRestoreIntent | null = null;
        for (const identity of identities) {
          acceptedIntent = await dependencies.findRestoreIntent({
            keyId: identity.keyId,
            requestId: preparation.request_id,
            userHash: identity.userHash,
          });
          if (acceptedIntent) break;
        }
        const identity = acceptedIntent
          ? {
              keyId: acceptedIntent.keyId,
              userHash: acceptedIntent.userHash,
            }
          : createAccountErasureUserIdentity(preparation.user_id);
        const requestedAt = acceptedIntent ? new Date(acceptedIntent.requestedAt) : now;
        const statusToken = acceptedIntent?.statusToken ?? randomBytes(32).toString("base64url");
        const result = await activateAccountErasureInTransaction(
          transaction,
          preparation.user_id,
          (snapshotTransaction) =>
            dependencies.createEncryptedRemoteSnapshot(snapshotTransaction, preparation.user_id),
          dependencies.persistRestoreIntent,
          preparation.request_id,
          statusToken,
          identity,
          requestedAt,
          now,
          {
            preparationTokenHash,
            recoveredFromRestore: acceptedIntent !== null,
          },
        );
        await transaction.execute(
          sql`DELETE FROM fitness.account_erasure_preparation
              WHERE preparation_token_hash = ${preparationTokenHash}`,
        );
        return result;
      }
    }

    const replayRows = await executeWithSchema(
      transaction,
      accountErasureConfirmationRowSchema,
      sql`SELECT
            id,
            user_hash,
            user_hash_key_id,
            status_token_hash,
            requested_at,
            replay_retained_until,
            completion_deadline
          FROM fitness.account_erasure_request
          WHERE preparation_token_hash = ${preparationTokenHash}
          LIMIT 1`,
    );
    const replay = replayRows[0];
    if (!replay) return null;
    return recoverAccountErasureConfirmation(dependencies, replay);
  });
  if (!result) throw new AccountErasurePreparationUnavailableError();
  return result;
}

export async function findAccountErasureStatus(
  database: Pick<Database, "execute">,
  statusToken: string,
  now = new Date(),
): Promise<AccountErasurePublicStatus | null> {
  const rows = await executeWithSchema(
    database,
    requestRowSchema.extend({ status_token_hash: z.string().length(64) }),
    sql`SELECT
          id,
          user_id,
          status_token_hash,
          status,
          current_phase,
          requested_at,
          replay_retained_until,
          completion_deadline,
          completed_at,
          retry_at,
          last_error
        FROM fitness.account_erasure_request
        WHERE status_token_hash = ${sha256(statusToken)}
        LIMIT 1`,
  );
  const row = rows[0];
  if (!row || !secureHashesEqual(row.status_token_hash, sha256(statusToken))) return null;
  if (row.status === "completed" && row.completed_at === null) {
    throw new Error("Completed account erasure request is missing completed_at");
  }
  const deadlineMissed =
    new Date(row.completed_at ?? now).getTime() > new Date(row.completion_deadline).getTime();

  return {
    completedAt: row.completed_at,
    currentPhase: row.current_phase,
    deadlineMissed,
    id: row.id,
    message: deadlineMissed
      ? row.status === "completed"
        ? "Account deletion completed after its 30-day deadline. Support was alerted to the delay."
        : "Account deletion missed its 30-day deadline. Deletion remains active and automatic retries are continuing; support has been alerted."
      : row.status === "failed"
        ? row.retry_at
          ? "Account deletion is still in progress. We are retrying it automatically."
          : "Account deletion needs support assistance. Contact support with this request ID."
        : null,
    replayRetainedUntil: row.replay_retained_until,
    requestedAt: row.requested_at,
    retentionUntil: row.completion_deadline,
    status: row.status,
  };
}
