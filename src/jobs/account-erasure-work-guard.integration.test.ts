import { sql } from "drizzle-orm";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  confirmAccountErasure,
  initiateAccountErasure,
  prepareAccountErasure,
  withAccountErasureUserWriteFence,
} from "../db/account-erasure.ts";
import { accountErasureQueuedUserWorkLockName } from "../db/account-erasure-locks.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import {
  createAccountErasureWorkLockPool,
  runQueuedUserWorkUnlessAccountErasing,
} from "./account-erasure-work-guard.ts";

const inverseRaceUserId = "a0000000-0000-4000-8000-000000001994";
const concurrentWorkUserId = "a1000000-0000-4000-8000-000000001994";
const shutdownUserId = "a2000000-0000-4000-8000-000000001994";
const confirmationRaceUserId = "a3000000-0000-4000-8000-000000001994";
const lockOrderUserId = "a4000000-0000-4000-8000-000000001994";

async function waitForExclusiveAdvisoryLockWait(connectionString: string): Promise<void> {
  const observer = new Client({ connectionString });
  await observer.connect();
  try {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const result = await observer.query<{ waiting: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM pg_locks AS waiting_lock
           JOIN pg_stat_activity AS waiting_activity
             ON waiting_activity.pid = waiting_lock.pid
           WHERE waiting_lock.locktype = 'advisory'
             AND waiting_lock.granted = false
             AND waiting_activity.datname = current_database()
             AND waiting_activity.wait_event = 'advisory'
             AND waiting_activity.query LIKE '%pg_advisory_xact_lock%'
         ) AS waiting`,
      );
      if (result.rows[0]?.waiting) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Account-erasure activation never waited for queued user work");
  } finally {
    await observer.end();
  }
}

describe("account-erasure queued-work barrier (integration)", () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
    await context.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name, email)
          VALUES
            (${inverseRaceUserId}::uuid, 'Inverse Race', 'inverse-race@example.test'),
            (${concurrentWorkUserId}::uuid, 'Concurrent Work', 'concurrent-work@example.test'),
            (${shutdownUserId}::uuid, 'Shutdown Work', 'shutdown-work@example.test'),
            (${confirmationRaceUserId}::uuid, 'Confirmation Race', 'confirmation-race@example.test'),
            (${lockOrderUserId}::uuid, 'Lock Order', 'lock-order@example.test')`,
    );
  });

  afterAll(async () => {
    await context.cleanup();
  });

  it("waits for pre-fence jobs and discards jobs admitted after the fence commits", async () => {
    const workLockPool = createAccountErasureWorkLockPool(context.connectionString);
    context.addCleanup(() => workLockPool.close());
    let releaseWork: () => void = () => {
      throw new Error("Work release was not initialized");
    };
    let reportWorkStarted: () => void = () => {
      throw new Error("Work start signal was not initialized");
    };
    const workStarted = new Promise<void>((resolve) => {
      reportWorkStarted = resolve;
    });
    const workReleased = new Promise<void>((resolve) => {
      releaseWork = resolve;
    });

    const preFenceWork = runQueuedUserWorkUnlessAccountErasing(
      workLockPool,
      context.db,
      inverseRaceUserId,
      "inverse-race export",
      async () => {
        reportWorkStarted();
        await workReleased;
        return "finished";
      },
    );
    await workStarted;

    let snapshotStarted = false;
    const initiation = initiateAccountErasure(
      context.db,
      inverseRaceUserId,
      async () => {
        snapshotStarted = true;
        return "encrypted-inverse-race-snapshot";
      },
      async () => undefined,
    );
    await waitForExclusiveAdvisoryLockWait(context.connectionString);
    expect(snapshotStarted).toBe(false);

    releaseWork();
    await expect(preFenceWork).resolves.toBe("finished");
    await expect(initiation).resolves.toEqual(
      expect.objectContaining({ requestId: expect.any(String) }),
    );
    expect(snapshotStarted).toBe(true);

    const postFenceWork = vi.fn(async () => "must-not-run");
    await expect(
      runQueuedUserWorkUnlessAccountErasing(
        workLockPool,
        context.db,
        inverseRaceUserId,
        "post-fence export",
        postFenceWork,
      ),
    ).resolves.toBeUndefined();
    expect(postFenceWork).not.toHaveBeenCalled();
  });

  it("allows concurrent queued jobs for the same unfenced user", async () => {
    const workLockPool = createAccountErasureWorkLockPool(context.connectionString);
    context.addCleanup(() => workLockPool.close());
    let releaseWork: () => void = () => {
      throw new Error("Concurrent work release was not initialized");
    };
    const workReleased = new Promise<void>((resolve) => {
      releaseWork = resolve;
    });
    let startedCount = 0;
    let reportBothStarted: () => void = () => {
      throw new Error("Concurrent work signal was not initialized");
    };
    const bothStarted = new Promise<void>((resolve) => {
      reportBothStarted = resolve;
    });
    const startWork = async (): Promise<void> => {
      startedCount++;
      if (startedCount === 2) reportBothStarted();
      await workReleased;
    };

    const first = runQueuedUserWorkUnlessAccountErasing(
      workLockPool,
      context.db,
      concurrentWorkUserId,
      "first concurrent sync",
      startWork,
    );
    const second = runQueuedUserWorkUnlessAccountErasing(
      workLockPool,
      context.db,
      concurrentWorkUserId,
      "second concurrent sync",
      startWork,
    );
    await bothStarted;
    releaseWork();

    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
  });

  it("drains queued work before confirmation activates the public erasure fence", async () => {
    const workLockPool = createAccountErasureWorkLockPool(context.connectionString);
    context.addCleanup(() => workLockPool.close());
    const preparation = await prepareAccountErasure(
      context.db,
      confirmationRaceUserId,
      async () => [],
    );
    let releaseWork: () => void = () => {
      throw new Error("Confirmation work release was not initialized");
    };
    let reportWorkStarted: () => void = () => {
      throw new Error("Confirmation work signal was not initialized");
    };
    const workStarted = new Promise<void>((resolve) => {
      reportWorkStarted = resolve;
    });
    const workReleased = new Promise<void>((resolve) => {
      releaseWork = resolve;
    });
    const preFenceWork = runQueuedUserWorkUnlessAccountErasing(
      workLockPool,
      context.db,
      confirmationRaceUserId,
      "confirmation-race import",
      async () => {
        reportWorkStarted();
        await workReleased;
      },
    );
    await workStarted;

    let snapshotStarted = false;
    const confirmation = confirmAccountErasure(context.db, preparation.preparationToken, {
      createEncryptedRemoteSnapshot: async () => {
        snapshotStarted = true;
        return "encrypted-confirmation-race-snapshot";
      },
      findRestoreIntent: async () => null,
      persistRestoreIntent: async () => undefined,
    });
    await waitForExclusiveAdvisoryLockWait(context.connectionString);
    expect(snapshotStarted).toBe(false);

    releaseWork();
    await preFenceWork;
    await expect(confirmation).resolves.toEqual(
      expect.objectContaining({ requestId: expect.any(String) }),
    );
    expect(snapshotStarted).toBe(true);
  });

  it("does not deadlock a pre-fence job that takes the existing user-write lock", async () => {
    const workLockPool = createAccountErasureWorkLockPool(context.connectionString);
    context.addCleanup(() => workLockPool.close());
    let allowUserWrite: () => void = () => {
      throw new Error("User-write release was not initialized");
    };
    let reportWorkStarted: () => void = () => {
      throw new Error("Lock-order work signal was not initialized");
    };
    const workStarted = new Promise<void>((resolve) => {
      reportWorkStarted = resolve;
    });
    const userWriteAllowed = new Promise<void>((resolve) => {
      allowUserWrite = resolve;
    });
    const preFenceWork = runQueuedUserWorkUnlessAccountErasing(
      workLockPool,
      context.db,
      lockOrderUserId,
      "lock-order sync",
      async () => {
        reportWorkStarted();
        await userWriteAllowed;
        await withAccountErasureUserWriteFence(context.db, lockOrderUserId, async () => undefined);
      },
    );
    await workStarted;

    const initiation = initiateAccountErasure(
      context.db,
      lockOrderUserId,
      async () => "encrypted-lock-order-snapshot",
      async () => undefined,
    );
    await waitForExclusiveAdvisoryLockWait(context.connectionString);
    allowUserWrite();

    await preFenceWork;
    await expect(initiation).resolves.toEqual(
      expect.objectContaining({ requestId: expect.any(String) }),
    );
  });

  it("waits for active work during shutdown and releases its session lock", async () => {
    const workLockPool = createAccountErasureWorkLockPool(context.connectionString);
    let releaseWork: () => void = () => {
      throw new Error("Shutdown work release was not initialized");
    };
    let reportWorkStarted: () => void = () => {
      throw new Error("Shutdown work signal was not initialized");
    };
    const workStarted = new Promise<void>((resolve) => {
      reportWorkStarted = resolve;
    });
    const workReleased = new Promise<void>((resolve) => {
      releaseWork = resolve;
    });
    const work = runQueuedUserWorkUnlessAccountErasing(
      workLockPool,
      context.db,
      shutdownUserId,
      "shutdown sync",
      async () => {
        reportWorkStarted();
        await workReleased;
      },
    );
    await workStarted;

    let poolClosed = false;
    const close = workLockPool.close().then(() => {
      poolClosed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(poolClosed).toBe(false);

    releaseWork();
    await work;
    await close;

    const probe = new Client({ connectionString: context.connectionString });
    await probe.connect();
    try {
      const result = await probe.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock(hashtextextended($1::text, 0)) AS acquired",
        [accountErasureQueuedUserWorkLockName(shutdownUserId)],
      );
      expect(result.rows).toEqual([{ acquired: true }]);
    } finally {
      await probe.end();
    }
  });
});
