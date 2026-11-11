import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  type AccountErasureWorkLockPool,
  createAccountErasureWorkLockPool,
} from "../jobs/account-erasure-work-guard.ts";
import { accountErasureQueuedUserWorkLockName } from "./account-erasure-locks.ts";
import { providerExecutionLockName } from "./provider-execution-lock.ts";
import { withProviderOperationFence } from "./provider-operation-fence.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";
import { executeWithSchema } from "./typed-sql.ts";

describe("provider operation fences", () => {
  let context: TestContext;
  let workLockPool: AccountErasureWorkLockPool;
  const userId = "50000000-0000-4000-8000-000000000001";
  beforeAll(async () => {
    context = await setupTestDatabase();
    workLockPool = createAccountErasureWorkLockPool(context.connectionString);
  }, 60_000);
  afterAll(async () => {
    await workLockPool?.close();
    await context?.cleanup();
  });

  it("blocks concurrent provider work and account activation while permitting independent durable credential writes", async () => {
    const observer = await context.db.$client.connect();
    try {
      const tryLock = async (key: string) => {
        const response = await observer.query<{ locked: boolean }>(
          "SELECT pg_try_advisory_lock(hashtextextended($1::text, 0)) AS locked",
          [key],
        );
        const locked = response.rows[0]?.locked;
        if (locked)
          await observer.query("SELECT pg_advisory_unlock(hashtextextended($1::text, 0))", [key]);
        return locked;
      };
      await withProviderOperationFence(
        context.db,
        userId,
        "garmin",
        async () => {
          expect(await tryLock(providerExecutionLockName(userId, "garmin"))).toBe(false);
          expect(await tryLock(accountErasureQueuedUserWorkLockName(userId))).toBe(false);
          expect(await tryLock(providerExecutionLockName(userId, "wahoo"))).toBe(true);
          // A refresh can commit separately before a later revocation fails.
          expect(await tryLock(userId)).toBe(true);
        },
        workLockPool,
      );
      expect(await tryLock(providerExecutionLockName(userId, "garmin"))).toBe(true);
      const failure = new Error("Remote revocation failed after token refresh");
      await expect(
        withProviderOperationFence(
          context.db,
          userId,
          "garmin",
          async () => {
            throw failure;
          },
          workLockPool,
        ),
      ).rejects.toBe(failure);
      expect(await tryLock(providerExecutionLockName(userId, "garmin"))).toBe(true);
    } finally {
      observer.release();
    }
  });

  it("keeps work connections available when more requests wait than the main pool can serve", async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        withProviderOperationFence(
          context.db,
          userId,
          "garmin",
          async () => {
            // This independent transaction models committing a rotated credential.
            const [row] = await executeWithSchema(
              context.db,
              z.object({ ok: z.literal(1) }),
              sql`SELECT 1 AS ok`,
            );
            return row?.ok;
          },
          workLockPool,
        ),
      ),
    );
    expect(results).toEqual(Array.from({ length: 12 }, () => 1));
  });
});
