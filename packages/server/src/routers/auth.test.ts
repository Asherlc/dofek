import { TRPCError } from "@trpc/server";
import { describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{ db: unknown; userId: string | null; timezone: string }>()
    .create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
    cachedProtectedQuery: () => trpc.procedure,
    CacheTTL: { SHORT: 120_000, MEDIUM: 600_000, LONG: 3_600_000 },
  };
});

vi.mock("../lib/typed-sql.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/typed-sql.ts")>();
  return {
    ...original,
    executeWithSchema: vi.fn(
      async (
        db: { execute: (q: unknown) => Promise<unknown[]> },
        _schema: unknown,
        query: unknown,
      ) => db.execute(query),
    ),
  };
});

vi.mock("dofek/lib/cache", () => ({
  queryCache: { invalidateByPrefix: vi.fn().mockResolvedValue(undefined) },
}));

import { queryCache } from "dofek/lib/cache";
import { authRouter } from "./auth.ts";

const createCaller = createTestCallerFactory(authRouter);

describe("authRouter", () => {
  describe("linkedAccounts", () => {
    it("returns mapped account rows", async () => {
      const rows = [
        {
          id: "acc-1",
          auth_provider: "google",
          email: "test@example.com",
          name: "Test User",
          created_at: "2024-01-01",
        },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.linkedAccounts();

      expect(result).toEqual([
        {
          id: "acc-1",
          authProvider: "google",
          email: "test@example.com",
          name: "Test User",
          createdAt: "2024-01-01",
        },
      ]);
    });
  });

  describe("unlinkAccount", () => {
    it("throws BAD_REQUEST when only one account", async () => {
      const execute = vi.fn();
      execute.mockResolvedValueOnce([{ count: "1" }]);
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      await expect(
        caller.unlinkAccount({ accountId: "00000000-0000-0000-0000-000000000001" }),
      ).rejects.toThrow(TRPCError);
    });

    it("throws NOT_FOUND when account does not belong to user", async () => {
      const execute = vi.fn();
      execute.mockResolvedValueOnce([{ count: "2" }]);
      execute.mockResolvedValueOnce([]); // no rows deleted
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      await expect(
        caller.unlinkAccount({ accountId: "00000000-0000-0000-0000-000000000001" }),
      ).rejects.toThrow(TRPCError);
    });

    it("successfully unlinks when multiple accounts exist", async () => {
      const execute = vi.fn();
      execute.mockResolvedValueOnce([{ count: "3" }]);
      execute.mockResolvedValueOnce([{ id: "acc-1" }]); // deleted row returned
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.unlinkAccount({
        accountId: "00000000-0000-0000-0000-000000000001",
      });
      expect(result).toEqual({ ok: true });
      expect(queryCache.invalidateByPrefix).toHaveBeenCalledWith("user-1:auth.linkedAccounts");
    });
  });
});
