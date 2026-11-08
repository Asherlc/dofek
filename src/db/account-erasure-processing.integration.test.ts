import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  renewAccountErasureLease,
  saveAccountErasurePhaseProgress,
} from "./account-erasure-processing.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";

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

  it("rejects renewal when the lease expires while waiting for its row lock", async () => {
    const leaseOwner = `lease-renew-wait-${randomUUID()}`;
    const requestId = await insertRunningRequest({
      leaseOwner,
      leaseExpiresAt: new Date(Date.now() + 1000),
    });
    const locker = await context.db.$client.connect();
    try {
      await locker.query("BEGIN");
      await locker.query("SELECT id FROM fitness.account_erasure_request WHERE id=$1 FOR UPDATE", [
        requestId,
      ]);
      const renewal = renewAccountErasureLease(context.db, requestId, leaseOwner, 60000).then(
        () => null,
        (error: unknown) => error,
      );
      await locker.query("SELECT pg_sleep(1.1)");
      await locker.query("COMMIT");
      expect(await renewal).toMatchObject({ message: "Account erasure lease is no longer owned" });
    } finally {
      await locker.query("ROLLBACK");
      locker.release();
    }
  });

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
