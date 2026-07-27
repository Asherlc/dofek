import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findAccountErasureStatus, initiateAccountErasure } from "../db/account-erasure.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { createAccountErasureUserHash } from "./identity.ts";
import type { AccountErasureRestoreIntent, AccountErasureRestoreLedger } from "./restore-ledger.ts";
import {
  reconcileAccountErasureRestoreIntents,
  recoverAccountErasureIntentForUser,
} from "./restore-reconciliation.ts";

const restoredUserId = "81000000-0000-4000-8000-000000001994";
const activeUserId = "82000000-0000-4000-8000-000000001994";
const restoredRequestId = "83000000-0000-4000-8000-000000001994";
const concurrentRestoreUserId = "84000000-0000-4000-8000-000000001994";
const concurrentRestoreRequestId = "85000000-0000-4000-8000-000000001994";
const retiredKeyRequestId = "86000000-0000-4000-8000-000000001994";

class MemoryRestoreLedger implements AccountErasureRestoreLedger {
  findIntentCalls = 0;
  readonly intents = new Map<string, AccountErasureRestoreIntent>();

  async findIntent(
    reference: Pick<AccountErasureRestoreIntent, "keyId" | "requestId" | "userHash">,
  ): Promise<AccountErasureRestoreIntent | null> {
    this.findIntentCalls += 1;
    const intent = this.intents.get(reference.requestId);
    return intent?.keyId === reference.keyId && intent.userHash === reference.userHash
      ? intent
      : null;
  }

  async listIntentReferences() {
    return [...this.intents.values()].map(({ keyId, requestId, userHash }) => ({
      keyId,
      requestId,
      userHash,
    }));
  }

  async listIntentsForIdentities(
    identities: readonly Pick<AccountErasureRestoreIntent, "keyId" | "userHash">[],
  ): Promise<readonly AccountErasureRestoreIntent[]> {
    const acceptedIdentities = new Set(
      identities.map((identity) => `${identity.keyId}:${identity.userHash}`),
    );
    return [...this.intents.values()].filter((intent) =>
      acceptedIdentities.has(`${intent.keyId}:${intent.userHash}`),
    );
  }

  async recordIntent(intent: AccountErasureRestoreIntent): Promise<void> {
    if (!this.intents.has(intent.requestId)) {
      this.intents.set(intent.requestId, intent);
    }
  }
}

class ConcurrentRestoreLedger extends MemoryRestoreLedger {
  #listCallCount = 0;
  #releaseListings: () => void = () => {
    throw new Error("restore listing release was not initialized");
  };
  readonly #bothListingsStarted = new Promise<void>((resolve) => {
    this.#releaseListings = resolve;
  });

  override async listIntentReferences() {
    this.#listCallCount += 1;
    if (this.#listCallCount === 2) this.#releaseListings();
    await this.#bothListingsStarted;
    return super.listIntentReferences();
  }
}

describe("account erasure restore reconciliation (integration)", () => {
  let activeRequestId: string;
  let context: TestContext;
  let ledger: MemoryRestoreLedger;

  beforeAll(async () => {
    context = await setupTestDatabase();
    ledger = new MemoryRestoreLedger();
    await context.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name, email)
          VALUES
            (${restoredUserId}::uuid, 'Restored User', 'restored-1994@example.test'),
            (${activeUserId}::uuid, 'Active Erasure User', 'active-erasure-1994@example.test'),
            (${concurrentRestoreUserId}::uuid, 'Concurrent Restore User', 'concurrent-restore-1994@example.test')`,
    );
    await context.db.execute(
      sql`INSERT INTO fitness.session (id, user_id, expires_at)
          VALUES (
            'restored-account-session',
            ${restoredUserId}::uuid,
            now() + interval '1 day'
          )`,
    );
  }, 120_000);

  afterAll(async () => {
    await context?.cleanup();
  });

  it("rejects a retained intent reference whose key ID is no longer configured", async () => {
    const retiredKeyLedger = new MemoryRestoreLedger();
    await retiredKeyLedger.recordIntent({
      keyId: "retired-v0",
      requestId: retiredKeyRequestId,
      requestedAt: "2026-07-26T12:00:00.000Z",
      statusToken: "k".repeat(43),
      userHash: "e".repeat(64),
    });

    await expect(
      reconcileAccountErasureRestoreIntents({
        createEncryptedRemoteSnapshot: async () => "must-not-run",
        database: context.db,
        ledger: retiredKeyLedger,
      }),
    ).rejects.toThrow("references unconfigured key ID retired-v0");
    expect(retiredKeyLedger.findIntentCalls).toBe(0);
  });

  it("reconstructs the same request from an external-only accepted intent", async () => {
    await ledger.recordIntent({
      keyId: "test-v1",
      requestId: restoredRequestId,
      requestedAt: "2026-07-26T12:00:00.000Z",
      statusToken: "r".repeat(43),
      userHash: createAccountErasureUserHash(restoredUserId),
    });
    await ledger.recordIntent({
      keyId: "test-v1",
      requestId: "86000000-0000-4000-8000-000000001994",
      requestedAt: "2026-07-26T12:00:00.000Z",
      statusToken: "x".repeat(43),
      userHash: "f".repeat(64),
    });

    await expect(
      reconcileAccountErasureRestoreIntents({
        createEncryptedRemoteSnapshot: async () => "encrypted-restored-snapshot",
        database: context.db,
        ledger,
      }),
    ).resolves.toEqual({ recoveredRequestIds: [restoredRequestId] });
    expect(ledger.findIntentCalls).toBe(1);

    const rows = await context.db.execute(
      sql`SELECT id, recovered_from_restore IS NOT NULL AS recovered
          FROM fitness.account_erasure_request
          WHERE id = ${restoredRequestId}::uuid`,
    );
    const sessions = await context.db.execute(
      sql`SELECT id FROM fitness.session WHERE user_id = ${restoredUserId}::uuid`,
    );
    expect(rows).toEqual([{ id: restoredRequestId, recovered: true }]);
    expect(sessions).toEqual([]);
    await expect(findAccountErasureStatus(context.db, "r".repeat(43))).resolves.toEqual(
      expect.objectContaining({
        retentionUntil: "2026-08-25T12:00:00.000Z",
        id: restoredRequestId,
        replayRetainedUntil: "2026-08-02T12:00:00.000Z",
      }),
    );
    await expect(
      recoverAccountErasureIntentForUser(
        {
          createEncryptedRemoteSnapshot: async () => {
            throw new Error("active recovery must not replace its snapshot");
          },
          database: context.db,
          ledger,
        },
        restoredUserId,
      ),
    ).resolves.toEqual(
      expect.objectContaining({
        requestId: restoredRequestId,
        statusToken: "r".repeat(43),
      }),
    );
  });

  it("does not duplicate a request that committed after its external intent", async () => {
    const initiation = await initiateAccountErasure(
      context.db,
      activeUserId,
      async () => "encrypted-active-snapshot",
      (intent) => ledger.recordIntent(intent),
    );
    activeRequestId = initiation.requestId;
    const findIntentCallsBeforeReconciliation = ledger.findIntentCalls;

    await expect(
      reconcileAccountErasureRestoreIntents({
        createEncryptedRemoteSnapshot: async () => "should-not-run",
        database: context.db,
        ledger,
      }),
    ).resolves.toEqual({ recoveredRequestIds: [] });
    expect(ledger.findIntentCalls - findIntentCallsBeforeReconciliation).toBe(2);

    const rows = await context.db.execute(
      sql`SELECT count(*)::integer AS count
          FROM fitness.account_erasure_request
          WHERE user_hash = (
            SELECT user_hash
            FROM fitness.account_erasure_request
            WHERE id = ${initiation.requestId}::uuid
          )`,
    );
    expect(rows).toEqual([{ count: 1 }]);
  });

  it("fails closed when an active request has no exact immutable restore intent", async () => {
    const activeIntent = ledger.intents.get(activeRequestId);
    if (!activeIntent) {
      throw new Error("active restore intent fixture was not initialized");
    }
    ledger.intents.delete(activeRequestId);
    try {
      await expect(
        reconcileAccountErasureRestoreIntents({
          createEncryptedRemoteSnapshot: async () => "must-not-run",
          database: context.db,
          ledger,
        }),
      ).rejects.toThrow(
        `Active account erasure request ${activeRequestId} has no matching restore intent`,
      );
    } finally {
      ledger.intents.set(activeRequestId, activeIntent);
    }
  });

  it("fails closed when an active request restore intent has the wrong status token", async () => {
    const activeIntent = ledger.intents.get(activeRequestId);
    if (!activeIntent) {
      throw new Error("active restore intent fixture was not initialized");
    }
    ledger.intents.set(activeRequestId, {
      ...activeIntent,
      statusToken: "z".repeat(43),
    });
    try {
      await expect(
        reconcileAccountErasureRestoreIntents({
          createEncryptedRemoteSnapshot: async () => "must-not-run",
          database: context.db,
          ledger,
        }),
      ).rejects.toThrow(
        `Active account erasure request ${activeRequestId} has no matching restore intent`,
      );
    } finally {
      ledger.intents.set(activeRequestId, activeIntent);
    }
  });

  it("fails closed when an active request restore intent has a different request time", async () => {
    const activeIntent = ledger.intents.get(activeRequestId);
    if (!activeIntent) {
      throw new Error("active restore intent fixture was not initialized");
    }
    ledger.intents.set(activeRequestId, {
      ...activeIntent,
      requestedAt: new Date(new Date(activeIntent.requestedAt).getTime() + 1_000).toISOString(),
    });
    try {
      await expect(
        reconcileAccountErasureRestoreIntents({
          createEncryptedRemoteSnapshot: async () => "must-not-run",
          database: context.db,
          ledger,
        }),
      ).rejects.toThrow(
        `Active account erasure request ${activeRequestId} has no matching restore intent`,
      );
    } finally {
      ledger.intents.set(activeRequestId, activeIntent);
    }
  });

  it("converges concurrent server and worker startup reconciliation on one request", async () => {
    const raceLedger = new ConcurrentRestoreLedger();
    for (const intent of ledger.intents.values()) {
      await raceLedger.recordIntent(intent);
    }
    await raceLedger.recordIntent({
      keyId: "test-v1",
      requestId: concurrentRestoreRequestId,
      requestedAt: "2026-07-26T12:00:00.000Z",
      statusToken: "c".repeat(43),
      userHash: createAccountErasureUserHash(concurrentRestoreUserId),
    });
    let snapshots = 0;
    const reconcile = () =>
      reconcileAccountErasureRestoreIntents({
        createEncryptedRemoteSnapshot: async () => {
          snapshots += 1;
          return "encrypted-concurrent-restore-snapshot";
        },
        database: context.db,
        ledger: raceLedger,
      });

    await expect(Promise.all([reconcile(), reconcile()])).resolves.toEqual([
      { recoveredRequestIds: [concurrentRestoreRequestId] },
      { recoveredRequestIds: [concurrentRestoreRequestId] },
    ]);

    const rows = await context.db.execute(
      sql`SELECT
            count(*)::int AS request_count,
            (SELECT count(*)::int
              FROM fitness.account_erasure_outbox
              WHERE request_id = ${concurrentRestoreRequestId}::uuid) AS outbox_count
          FROM fitness.account_erasure_request
          WHERE id = ${concurrentRestoreRequestId}::uuid`,
    );
    expect(rows).toEqual([{ outbox_count: 1, request_count: 1 }]);
    expect(snapshots).toBe(1);
  });
});
