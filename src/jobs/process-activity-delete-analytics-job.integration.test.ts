import { EventEmitter } from "node:events";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initiateAccountErasure } from "../db/account-erasure.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { createAccountErasureWorkLockPool } from "./account-erasure-work-guard.ts";
import { processActivityDeleteAnalyticsJob } from "./process-activity-delete-analytics-job.ts";
import {
  closeAllQueueResources,
  closeAnalyticsRefreshWaiters,
  getAnalyticsRefreshQueue,
} from "./queues.ts";

const userId = "a5000000-0000-4000-8000-000000001994";
describe("activity analytics wait lifecycle (Postgres and Redis integration)", () => {
  let context: TestContext;
  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(
      sql`INSERT INTO fitness.user_profile (id,name,email) VALUES (${userId}::uuid,'Analytics wait','analytics-wait@example.test')`,
    );
  });
  afterAll(async () => {
    await context.cleanup();
  });

  it("allows account erasure while awaiting analytics and settles the waiter on shutdown", async () => {
    const pool = createAccountErasureWorkLockPool(context.connectionString);
    const queue = getAnalyticsRefreshQueue();
    let registered = () => {};
    const waiting = new Promise<void>((resolve) => {
      registered = resolve;
    });
    const onListener = (event: string | symbol) => {
      if (event === "closing") registered();
    };
    EventEmitter.prototype.on.call(queue, "newListener", onListener);
    let processing: Promise<void> | undefined;
    try {
      await queue.pause();
      processing = processActivityDeleteAnalyticsJob(
        {
          data: { type: "activity-recompute-analytics-refresh", userId, activityIds: [] },
          updateProgress: async () => {},
        },
        context.db,
        pool,
      );
      const interrupted = expect(processing).rejects.toThrow("worker is shutting down");
      await waiting;
      // This must acquire immediately: the queued analytics job is still waiting.
      expect(await pool.tryRunWithExclusiveUserLock(userId, async () => "acquired")).toBe(
        "acquired",
      );
      await initiateAccountErasure(
        context.db,
        userId,
        async () => "encrypted-test-snapshot",
        async () => undefined,
      );
      await closeAnalyticsRefreshWaiters();
      await interrupted;
    } finally {
      queue.removeListener("newListener", onListener);
      await closeAnalyticsRefreshWaiters();
      await processing?.catch(() => undefined); // Expected shutdown rejection asserted above.
      await queue.resume();
      await closeAllQueueResources();
      await pool.close();
    }
  }, 15_000);
});
