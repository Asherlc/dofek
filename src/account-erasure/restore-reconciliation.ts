import { createHash, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { type AccountErasureInitiation, initiateAccountErasure } from "../db/account-erasure.ts";
import type { Database, TransactionDatabase } from "../db/index.ts";
import { executeWithSchema, timestampStringSchema } from "../db/typed-sql.ts";
import { createAccountErasureUserIdentities, readAccountErasureLedgerKeyring } from "./identity.ts";
import type { AccountErasureRestoreLedger } from "./restore-ledger.ts";

const profileRowSchema = z.object({ id: z.string().min(1) });
const requestRowSchema = z.object({
  id: z.uuid(),
  requested_at: timestampStringSchema,
  status_token_hash: z.string().length(64),
  user_hash_key_id: z.string().min(1),
  user_hash: z.string().length(64),
  user_id: z.string().min(1).nullable(),
});
const activeInitiationRowSchema = z.object({
  completion_deadline: timestampStringSchema,
  id: z.uuid(),
  replay_retained_until: timestampStringSchema,
  status_token_hash: z.string().length(64),
});

export interface AccountErasureRestoreReconciliationDependencies {
  createEncryptedRemoteSnapshot(database: TransactionDatabase, userId: string): Promise<string>;
  database: Pick<Database, "execute" | "transaction">;
  ledger: AccountErasureRestoreLedger;
}

export interface AccountErasureRestoreReconciliationResult {
  recoveredRequestIds: string[];
}

function statusTokenMatchesHash(statusToken: string, expectedHash: string): boolean {
  const actual = Buffer.from(createHash("sha256").update(statusToken).digest("hex"), "hex");
  const expected = Buffer.from(expectedHash, "hex");
  return actual.byteLength === expected.byteLength && timingSafeEqual(actual, expected);
}

export async function recoverAccountErasureIntentForUser(
  dependencies: AccountErasureRestoreReconciliationDependencies,
  userId: string,
): Promise<AccountErasureInitiation | null> {
  const identities = createAccountErasureUserIdentities(userId);
  const identityKeys = new Set(
    identities.map((identity) => `${identity.keyId}:${identity.userHash}`),
  );
  const matchingIntents = (await dependencies.ledger.listIntentsForIdentities(identities))
    .filter((intent) => identityKeys.has(`${intent.keyId}:${intent.userHash}`))
    .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt));
  if (matchingIntents.length === 0) return null;

  const activeRows = await executeWithSchema(
    dependencies.database,
    activeInitiationRowSchema,
    sql`SELECT
          id,
          status_token_hash,
          replay_retained_until,
          completion_deadline
        FROM fitness.account_erasure_request
        WHERE user_id = ${userId}::uuid
          AND status <> 'completed'
        LIMIT 1`,
  );
  const active = activeRows[0];
  if (active) {
    const intent = matchingIntents.find((candidate) => candidate.requestId === active.id);
    if (!intent || !statusTokenMatchesHash(intent.statusToken, active.status_token_hash)) {
      throw new Error(`Active account erasure request ${active.id} has no matching restore intent`);
    }
    return {
      replayRetainedUntil: active.replay_retained_until,
      requestId: active.id,
      retentionUntil: active.completion_deadline,
      statusToken: intent.statusToken,
    };
  }

  const intent = matchingIntents[0];
  if (!intent) return null;
  return initiateAccountErasure(
    dependencies.database,
    userId,
    (transaction) => dependencies.createEncryptedRemoteSnapshot(transaction, userId),
    (restoreIntent) => dependencies.ledger.recordIntent(restoreIntent),
    {
      identity: { keyId: intent.keyId, userHash: intent.userHash },
      now: new Date(intent.requestedAt),
      recoveredFromRestore: true,
      requestId: intent.requestId,
      statusToken: intent.statusToken,
    },
  );
}

export async function reconcileAccountErasureRestoreIntents(
  dependencies: AccountErasureRestoreReconciliationDependencies,
): Promise<AccountErasureRestoreReconciliationResult> {
  const keyring = readAccountErasureLedgerKeyring();
  // Capture the local state before listing the remote ledger. Concurrent
  // startup reconcilers must make their local snapshots before either one can
  // begin recovery; otherwise one reconciler can observe the other's newly
  // committed request and report a different result for the same intent.
  const [profiles, requests] = await Promise.all([
    executeWithSchema(
      dependencies.database,
      profileRowSchema,
      sql`SELECT id FROM fitness.user_profile ORDER BY id`,
    ),
    executeWithSchema(
      dependencies.database,
      requestRowSchema,
      sql`SELECT
            id,
            requested_at,
            status_token_hash,
            user_hash,
            user_hash_key_id,
            user_id
          FROM fitness.account_erasure_request
          WHERE status <> 'completed'`,
    ),
  ]);
  const references = await dependencies.ledger.listIntentReferences();
  const configuredKeyIds = new Set(Object.keys(keyring.keys));
  for (const reference of references) {
    if (!configuredKeyIds.has(reference.keyId)) {
      throw new Error(
        `Account erasure restore ledger references unconfigured key ID ${reference.keyId}`,
      );
    }
  }
  await Promise.all(
    requests.map(async (request) => {
      if (!configuredKeyIds.has(request.user_hash_key_id)) {
        throw new Error(
          `Active account erasure request ${request.id} references unconfigured key ID ${request.user_hash_key_id}`,
        );
      }
      const intent = await dependencies.ledger.findIntent({
        keyId: request.user_hash_key_id,
        requestId: request.id,
        userHash: request.user_hash,
      });
      if (
        !intent ||
        intent.requestedAt !== request.requested_at ||
        !statusTokenMatchesHash(intent.statusToken, request.status_token_hash)
      ) {
        throw new Error(
          `Active account erasure request ${request.id} has no matching restore intent`,
        );
      }
    }),
  );
  const usersByIdentity = new Map(
    profiles.flatMap((profile) =>
      createAccountErasureUserIdentities(profile.id, keyring).map(
        (identity) => [`${identity.keyId}:${identity.userHash}`, profile.id] as const,
      ),
    ),
  );
  const activeUserIds = new Set(
    requests.map((request) => request.user_id).filter((userId) => userId !== null),
  );
  const knownRequestIds = new Set(requests.map((request) => request.id));
  const recoveredRequestIds: string[] = [];

  const candidateReferences = references.filter((reference) => {
    const userId = usersByIdentity.get(`${reference.keyId}:${reference.userHash}`);
    return userId !== undefined && !activeUserIds.has(userId);
  });
  const intents = (
    await Promise.all(
      candidateReferences.map(async (reference) => {
        const intent = await dependencies.ledger.findIntent(reference);
        if (!intent) {
          throw new Error(
            `Account erasure restore intent ${reference.requestId} disappeared during reconciliation`,
          );
        }
        return intent;
      }),
    )
  ).sort((left, right) => left.requestedAt.localeCompare(right.requestedAt));

  for (const intent of intents) {
    const userId = usersByIdentity.get(`${intent.keyId}:${intent.userHash}`);
    if (!userId || activeUserIds.has(userId)) continue;
    const result = await initiateAccountErasure(
      dependencies.database,
      userId,
      (transaction) => dependencies.createEncryptedRemoteSnapshot(transaction, userId),
      (restoreIntent) => dependencies.ledger.recordIntent(restoreIntent),
      {
        identity: { keyId: intent.keyId, userHash: intent.userHash },
        now: new Date(intent.requestedAt),
        recoveredFromRestore: true,
        requestId: knownRequestIds.has(intent.requestId) ? undefined : intent.requestId,
        statusToken: intent.statusToken,
      },
    );
    activeUserIds.add(userId);
    knownRequestIds.add(result.requestId);
    recoveredRequestIds.push(result.requestId);
  }

  return { recoveredRequestIds };
}
