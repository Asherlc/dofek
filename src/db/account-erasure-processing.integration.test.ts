import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ACCOUNT_ERASURE_SNAPSHOT_SUPPORT_REQUIRED } from "../account-erasure/snapshot-budget.ts";
import { findAccountErasureStatus } from "./account-erasure.ts";
import {
  claimAccountErasureRequest,
  listPendingAccountErasureRequests,
  markAccountErasureFailed,
  markOverdueAccountErasureRequests,
  renewAccountErasureLease,
  saveAccountErasurePhaseProgress,
} from "./account-erasure-processing.ts";
import { hasDatabaseLockWaiter, setupTestDatabase, type TestContext } from "./test-helpers.ts";

describe("account erasure active lease contract", () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
  }, 120_000);

  afterAll(async () => {
    await context?.cleanup();
  });

  async function insertRunningRequest(options: {
    leaseOwner: string;
    leaseExpiresAt: Date;
  }): Promise<string> {
    const requestId = randomUUID();
    const userId = randomUUID();
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    await context.db.execute(sql`
      INSERT INTO fitness.user_profile (id, name)
      VALUES (${userId}::uuid, 'Lease contract fixture')`);
    await context.db.execute(sql`
      INSERT INTO fitness.account_erasure_request (
        id, user_id, user_hash, user_hash_key_id, write_fence_hash, status_token_hash,
        encrypted_remote_snapshot, replay_retained_until, completion_deadline,
        status, lease_owner, lease_expires_at
      ) VALUES (
        ${requestId}::uuid,
        ${userId}::uuid,
        ${digest(requestId)},
        'test-v1',
        ${digest(userId)},
        ${digest(requestId)},
        'retained-snapshot',
        now() + interval '7 days',
        now() + interval '30 days',
        'running',
        ${options.leaseOwner},
        ${options.leaseExpiresAt.toISOString()}
      )`);
    return requestId;
  }

  it("saves phase progress when the active lease is still unexpired", async () => {
    const leaseOwner = `lease-save-${randomUUID()}`;
    const requestId = await insertRunningRequest({
      leaseOwner,
      leaseExpiresAt: new Date(Date.now() + 5 * 60_000),
    });

    await saveAccountErasurePhaseProgress(
      context.db,
      requestId,
      leaseOwner,
      "retention_verification",
      {
        verifiedAt: "2026-11-05T00:00:00.000Z",
      },
    );

    const rows = await context.db.execute(sql`
      SELECT phase_progress -> 'retention_verification' AS details
      FROM fitness.account_erasure_request
      WHERE id = ${requestId}::uuid`);
    expect(rows[0]?.details).toEqual({ verifiedAt: "2026-11-05T00:00:00.000Z" });
  });

  it("rejects phase progress saves after the lease expires", async () => {
    const leaseOwner = `lease-save-expired-${randomUUID()}`;
    const requestId = await insertRunningRequest({
      leaseOwner,
      leaseExpiresAt: new Date(Date.now() - 1_000),
    });

    await expect(
      saveAccountErasurePhaseProgress(context.db, requestId, leaseOwner, "retention_verification", {
        verifiedAt: "2026-11-05T00:00:00.000Z",
      }),
    ).rejects.toThrow("Account erasure lease was lost while saving phase progress");
  });

  it("rejects phase progress saves for a different lease owner", async () => {
    const leaseOwner = `lease-save-owner-${randomUUID()}`;
    const requestId = await insertRunningRequest({
      leaseOwner,
      leaseExpiresAt: new Date(Date.now() + 5 * 60_000),
    });

    await expect(
      saveAccountErasurePhaseProgress(
        context.db,
        requestId,
        "other-lease-owner",
        "retention_verification",
        { verifiedAt: "2026-11-05T00:00:00.000Z" },
      ),
    ).rejects.toThrow("Account erasure lease was lost while saving phase progress");
  });

  it("renews an unexpired lease owned by the caller", async () => {
    const leaseOwner = `lease-renew-${randomUUID()}`;
    const requestId = await insertRunningRequest({
      leaseOwner,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    const before = await context.db.execute(sql`
      SELECT lease_expires_at,clock_timestamp() AS observed_now FROM fitness.account_erasure_request WHERE id = ${requestId}::uuid`);
    const previousExpiry = new Date(String(before[0]?.lease_expires_at));

    await renewAccountErasureLease(context.db, requestId, leaseOwner, 60_000);

    const after = await context.db.execute(sql`
      SELECT lease_expires_at,clock_timestamp() AS observed_now FROM fitness.account_erasure_request WHERE id = ${requestId}::uuid`);
    const nextExpiry = new Date(String(after[0]?.lease_expires_at));
    expect(nextExpiry.getTime()).toBeGreaterThanOrEqual(
      new Date(String(before[0]?.observed_now)).getTime() + 60_000,
    );
    expect(nextExpiry.getTime()).toBeLessThanOrEqual(
      new Date(String(after[0]?.observed_now)).getTime() + 60_000,
    );
    expect(nextExpiry.getTime()).toBeGreaterThan(previousExpiry.getTime());
  });

  it("shows support-required snapshot status without exposing stored diagnostic text", async () => {
    const leaseOwner = `lease-snapshot-${randomUUID()}`;
    const requestId = await insertRunningRequest({
      leaseOwner,
      leaseExpiresAt: new Date(Date.now() + 60000),
    });
    await markAccountErasureFailed(
      context.db,
      requestId,
      leaseOwner,
      "Account deletion snapshot requires support assistance",
    );
    const status = await findAccountErasureStatus(context.db, requestId);
    expect(status?.message).toBe(
      "Account deletion needs support assistance. Contact support with this request ID.",
    );
    expect(status).not.toHaveProperty("lastError");
  });

  it("preserves support-required snapshot status after its deadline", async () => {
    const leaseOwner = `lease-support-overdue-${randomUUID()}`;
    const requestId = await insertRunningRequest({
      leaseOwner,
      leaseExpiresAt: new Date(Date.now() + 60_000),
    });
    await context.db.execute(sql`UPDATE fitness.account_erasure_request
      SET completion_deadline=clock_timestamp()-interval '1 second'
      WHERE id=${requestId}::uuid`);
    await markAccountErasureFailed(
      context.db,
      requestId,
      leaseOwner,
      ACCOUNT_ERASURE_SNAPSHOT_SUPPORT_REQUIRED,
    );
    await markOverdueAccountErasureRequests(context.db);

    const status = await findAccountErasureStatus(context.db, requestId);
    expect(status).toMatchObject({
      deadlineMissed: true,
      message:
        "Account deletion missed its 30-day deadline and needs support assistance. Contact support with this request ID.",
    });
    const rows = await context.db.execute(sql`SELECT last_error,retry_at
      FROM fitness.account_erasure_request WHERE id=${requestId}::uuid`);
    expect(rows[0]).toMatchObject({
      last_error: ACCOUNT_ERASURE_SNAPSHOT_SUPPORT_REQUIRED,
      retry_at: null,
    });
  });

  it.each(["dispatch", "claim"] as const)(
    "keeps support-required snapshots out of automatic %s",
    async (operation) => {
      const leaseOwner = `lease-support-dispatch-${randomUUID()}`;
      const requestId = await insertRunningRequest({
        leaseOwner,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      });
      await context.db.execute(sql`UPDATE fitness.account_erasure_request
      SET encrypted_remote_snapshot=repeat('x',2097153) WHERE id=${requestId}::uuid`);
      await context.db.execute(sql`INSERT INTO fitness.account_erasure_outbox(request_id)
      VALUES (${requestId}::uuid)`);
      await markAccountErasureFailed(
        context.db,
        requestId,
        leaseOwner,
        ACCOUNT_ERASURE_SNAPSHOT_SUPPORT_REQUIRED,
      );
      const later = new Date(Date.now() + 2 * 60 * 60_000);

      if (operation === "dispatch") {
        const pending = await listPendingAccountErasureRequests(context.db, 1_000, later);
        expect(pending.map((request) => request.id)).not.toContain(requestId);
      } else {
        await expect(
          claimAccountErasureRequest(context.db, requestId, "next-worker", 60_000, later),
        ).resolves.toBeNull();
      }
      const rows =
        await context.db.execute(sql`SELECT status,failure_count::integer AS failure_count,lease_owner,retry_at
      FROM fitness.account_erasure_request WHERE id=${requestId}::uuid`);
      expect(rows[0]).toMatchObject({
        status: "failed",
        failure_count: 1,
        lease_owner: null,
        retry_at: null,
      });
    },
  );

  it("still retries ordinary transient failures and repaired support-required requests", async () => {
    for (const failure of ["Transient test failure", ACCOUNT_ERASURE_SNAPSHOT_SUPPORT_REQUIRED]) {
      const leaseOwner = `lease-retry-${randomUUID()}`;
      const requestId = await insertRunningRequest({
        leaseOwner,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      });
      await context.db.execute(sql`INSERT INTO fitness.account_erasure_outbox(request_id)
        VALUES (${requestId}::uuid)`);
      await markAccountErasureFailed(context.db, requestId, leaseOwner, failure);
      if (failure === ACCOUNT_ERASURE_SNAPSHOT_SUPPORT_REQUIRED) {
        // Models support repairing the snapshot and explicitly clearing its hold.
        await context.db.execute(sql`UPDATE fitness.account_erasure_request
          SET encrypted_remote_snapshot='repaired-snapshot',last_error=NULL
          WHERE id=${requestId}::uuid`);
      }
      const later = new Date(Date.now() + 2 * 60 * 60_000);
      const pending = await listPendingAccountErasureRequests(context.db, 1_000, later);
      expect(pending.map((request) => request.id)).toContain(requestId);
      await expect(
        claimAccountErasureRequest(context.db, requestId, "next-worker", 60_000, later),
      ).resolves.toMatchObject({ id: requestId });
    }
  });

  it("rejects renewing an expired lease instead of resurrecting it", async () => {
    const leaseOwner = `lease-renew-expired-${randomUUID()}`;
    const requestId = await insertRunningRequest({
      leaseOwner,
      leaseExpiresAt: new Date(Date.now() - 1_000),
    });
    await expect(
      renewAccountErasureLease(context.db, requestId, leaseOwner, 60_000),
    ).rejects.toThrow("Account erasure lease is no longer owned");

    const after = await context.db.execute(sql`
      SELECT lease_expires_at < now() AS still_expired
      FROM fitness.account_erasure_request
      WHERE id = ${requestId}::uuid`);
    expect(after[0]?.still_expired).toBe(true);
  });

  it.each(["renewal", "progress"] as const)(
    "rejects %s when the lease expires while waiting for its row lock",
    async (operation) => {
      const leaseOwner = `lease-renew-wait-${randomUUID()}`;
      const requestId = await insertRunningRequest({
        leaseOwner,
        leaseExpiresAt: new Date(Date.now() + 60_000),
      });
      const locker = await context.db.$client.connect();
      let committed = false;
      try {
        await locker.query("BEGIN");
        await locker.query(
          "SELECT id FROM fitness.account_erasure_request WHERE id=$1 FOR UPDATE",
          [requestId],
        );
        await locker.query(
          "UPDATE fitness.account_erasure_request SET lease_expires_at=clock_timestamp()+interval '1 minute' WHERE id=$1",
          [requestId],
        );
        const pending = (
          operation === "renewal"
            ? renewAccountErasureLease(context.db, requestId, leaseOwner, 60_000)
            : saveAccountErasurePhaseProgress(
                context.db,
                requestId,
                leaseOwner,
                "archive_initial",
                {
                  lastKey: "must-not-advance",
                },
              )
        ).then(
          () => null,
          (error: unknown) => error,
        );
        await vi.waitFor(async () => expect(await hasDatabaseLockWaiter(context.db)).toBe(true));
        const active = await locker.query(
          "SELECT lease_expires_at>clock_timestamp() AS active FROM fitness.account_erasure_request WHERE id=$1",
          [requestId],
        );
        expect(active.rows).toEqual([{ active: true }]);
        await locker.query(
          "UPDATE fitness.account_erasure_request SET lease_expires_at=clock_timestamp()-interval '1 microsecond' WHERE id=$1",
          [requestId],
        );
        await locker.query("COMMIT");
        committed = true;
        expect(await pending).toMatchObject({
          message:
            operation === "renewal"
              ? "Account erasure lease is no longer owned"
              : "Account erasure lease was lost while saving phase progress",
        });
      } finally {
        if (!committed) await locker.query("ROLLBACK");
        locker.release();
      }
    },
  );

  it("rejects renewing a lease owned by another worker", async () => {
    const leaseOwner = `lease-renew-owner-${randomUUID()}`;
    const requestId = await insertRunningRequest({
      leaseOwner,
      leaseExpiresAt: new Date(Date.now() + 5 * 60_000),
    });

    await expect(
      renewAccountErasureLease(context.db, requestId, "other-lease-owner", 60_000),
    ).rejects.toThrow("Account erasure lease is no longer owned");
  });
});
