import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withAccountErasureDeliveryFence } from "./account-erasure-delivery-fence.ts";
import { lockAccountErasureActivation } from "./account-erasure-locks.ts";
import {
  createTestBarrier,
  hasDatabaseLockWaiter,
  setupTestDatabase,
  type TestContext,
} from "./test-helpers.ts";

describe("withAccountErasureDeliveryFence against real Postgres", () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
  }, 120_000);

  afterAll(async () => {
    await context?.cleanup();
  });

  async function insertActiveRequest(userId: string): Promise<string> {
    const requestId = randomUUID();
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    await context.db.execute(sql`
      INSERT INTO fitness.user_profile (id, name)
      VALUES (${userId}::uuid, 'Delivery fence fixture')
      ON CONFLICT (id) DO NOTHING`);
    await context.db.execute(sql`
      INSERT INTO fitness.account_erasure_request (
        id, user_id, user_hash, user_hash_key_id, write_fence_hash, status_token_hash,
        encrypted_remote_snapshot, replay_retained_until, completion_deadline, status
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
        'running'
      )`);
    return requestId;
  }

  it("returns active and scrubbed write_fence_hash matches while holding sorted locks", async () => {
    const activeUser = randomUUID();
    const scrubbedUser = randomUUID();
    const openUser = randomUUID();
    await insertActiveRequest(activeUser);
    const digest = createHash("sha256").update(scrubbedUser).digest("hex");
    await context.db.execute(sql`
      INSERT INTO fitness.account_erasure_request (
        id, user_id, user_hash, user_hash_key_id, write_fence_hash, status_token_hash,
        encrypted_remote_snapshot, replay_retained_until, completion_deadline,
        status, pii_scrubbed_at
      ) VALUES (
        ${randomUUID()}::uuid,
        NULL,
        ${digest},
        'test-v1',
        ${digest},
        ${createHash("sha256").update("scrubbed").digest("hex")},
        NULL,
        now() + interval '7 days',
        now() + interval '30 days',
        'waiting_retention',
        now()
      )`);

    let fenced: ReadonlySet<string> = new Set();
    await withAccountErasureDeliveryFence(
      context.db,
      [scrubbedUser, openUser, activeUser],
      async (ids) => {
        fenced = ids;
      },
    );
    expect(fenced).toEqual(new Set([activeUser.toLowerCase(), scrubbedUser.toLowerCase()]));
  });

  it("lets concurrent shared consumer fences coexist on the same advisory key", async () => {
    const userId = randomUUID();
    await insertActiveRequest(userId);
    const bothEntered = createTestBarrier();
    const release = createTestBarrier();
    let firstInside = false;
    let secondInside = false;

    const first = withAccountErasureDeliveryFence(context.db, [userId], async () => {
      firstInside = true;
      if (secondInside) bothEntered.resolve();
      await release.promise;
    });
    const second = withAccountErasureDeliveryFence(context.db, [userId], async () => {
      secondInside = true;
      if (firstInside) bothEntered.resolve();
      await release.promise;
    });
    const settled = Promise.allSettled([first, second]);
    try {
      await bothEntered.promise;
      expect(firstInside).toBe(true);
      expect(secondInside).toBe(true);
      await expect.poll(() => hasDatabaseLockWaiter(context.db)).toBe(false);
    } finally {
      release.resolve();
    }
    await settled;
  });

  it("keeps exclusive activation waiting while a shared consumer fence is held", async () => {
    const userId = randomUUID();
    await insertActiveRequest(userId);
    const sharedHeld = createTestBarrier();
    const releaseShared = createTestBarrier();
    let activationEntered = false;

    const shared = withAccountErasureDeliveryFence(context.db, [userId], async () => {
      sharedHeld.resolve();
      await releaseShared.promise;
    });
    await sharedHeld.promise;

    const exclusive = context.db.transaction(async (transaction) => {
      await lockAccountErasureActivation(transaction, userId);
      activationEntered = true;
    });
    const settled = Promise.allSettled([shared, exclusive]);
    try {
      await expect.poll(() => hasDatabaseLockWaiter(context.db)).toBe(true);
      expect(activationEntered).toBe(false);
    } finally {
      releaseShared.resolve();
    }
    await settled;
    expect(activationEntered).toBe(true);
  });

  it("accepts nil and non-RFC GUID account ids through the real fence path", async () => {
    const nilUserId = "00000000-0000-0000-0000-000000000000";
    const nonRfcUserId = "00000000-0000-0000-0000-000000000001";
    await context.db.execute(sql`
      INSERT INTO fitness.user_profile (id, name)
      VALUES
        (${nilUserId}::uuid, 'Nil GUID fence fixture'),
        (${nonRfcUserId}::uuid, 'Non-RFC GUID fence fixture')
      ON CONFLICT (id) DO NOTHING`);
    await insertActiveRequest(nilUserId);
    await insertActiveRequest(nonRfcUserId);

    let fenced: ReadonlySet<string> = new Set();
    await withAccountErasureDeliveryFence(context.db, [nilUserId, nonRfcUserId], async (ids) => {
      fenced = ids;
    });
    expect(fenced).toEqual(new Set([nilUserId, nonRfcUserId]));
    await expect(
      withAccountErasureDeliveryFence(context.db, ["not-a-guid"], async () => undefined),
    ).rejects.toThrow();
  });
});
