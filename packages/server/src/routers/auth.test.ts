import { TRPCError } from "@trpc/server";
import { describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

const { mockCachedProtectedQuery } = vi.hoisted(() => ({
  mockCachedProtectedQuery: vi.fn(),
}));

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{ db: unknown; userId: string | null; timezone: string }>()
    .create();
  mockCachedProtectedQuery.mockImplementation(() => trpc.procedure);
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
    cachedProtectedQuery: mockCachedProtectedQuery,
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
  it("uses short caches for auth read queries", () => {
    const routerConstructionCachePolicies = mockCachedProtectedQuery.mock.calls.map(
      (call) => call[0],
    );

    expect(routerConstructionCachePolicies).toEqual([{ maxAge: 120_000 }, { maxAge: 120_000 }]);
  });

  describe("passwordCredentialStatus", () => {
    it("returns whether the user has a password credential", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([{ user_id: "user-1" }]) },
        userId: "user-1",
        timezone: "UTC",
      });

      await expect(caller.passwordCredentialStatus()).resolves.toEqual({ hasPassword: true });
    });
  });

  describe("linkedAccounts", () => {
    it("returns the canonical unlinkability for each account", async () => {
      const rows = [
        {
          id: "acc-1",
          auth_provider: "google",
          email: "test@example.com",
          name: "Test User",
          created_at: "2024-01-01",
        },
      ];
      const execute = vi.fn();
      execute.mockResolvedValueOnce(rows);
      execute.mockResolvedValueOnce([]);
      const caller = createCaller({
        db: { execute },
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
          canUnlink: false,
          unlinkReason: "Cannot unlink your only login method",
        },
      ]);
    });

    it.each([
      {
        name: "a password-only user",
        accounts: [],
        passwordRows: [{ user_id: "user-1" }],
        expected: [],
      },
      {
        name: "an OAuth-only user",
        accounts: [
          {
            id: "oauth-1",
            auth_provider: "google",
            email: null,
            name: null,
            created_at: "2024-01-01",
          },
        ],
        passwordRows: [],
        expected: [false],
      },
      {
        name: "a user with a password and OAuth account",
        accounts: [
          {
            id: "oauth-1",
            auth_provider: "google",
            email: null,
            name: null,
            created_at: "2024-01-01",
          },
        ],
        passwordRows: [{ user_id: "user-1" }],
        expected: [true],
      },
      {
        name: "a user with two OAuth accounts",
        accounts: [
          {
            id: "oauth-1",
            auth_provider: "google",
            email: null,
            name: null,
            created_at: "2024-01-01",
          },
          {
            id: "oauth-2",
            auth_provider: "apple",
            email: null,
            name: null,
            created_at: "2024-01-02",
          },
        ],
        passwordRows: [],
        expected: [true, true],
      },
      {
        name: "a user with an OAuth account and data-provider connection",
        accounts: [
          {
            id: "oauth-1",
            auth_provider: "google",
            email: null,
            name: null,
            created_at: "2024-01-01",
          },
          {
            id: "data-1",
            auth_provider: "garmin",
            email: null,
            name: null,
            created_at: "2024-01-02",
          },
        ],
        passwordRows: [],
        expected: [false, true],
      },
    ])("handles $name", async ({ accounts, passwordRows, expected }) => {
      const execute = vi.fn();
      execute.mockResolvedValueOnce(accounts);
      execute.mockResolvedValueOnce(passwordRows);
      const caller = createCaller({ db: { execute }, userId: "user-1", timezone: "UTC" });

      const result = await caller.linkedAccounts();

      expect(result.map((account) => account.canUnlink)).toEqual(expected);
    });
  });

  describe("unlinkAccount", () => {
    it("throws BAD_REQUEST when unlinking the only login method", async () => {
      const execute = vi.fn();
      execute.mockResolvedValueOnce([
        {
          id: "00000000-0000-0000-0000-000000000001",
          auth_provider: "google",
          email: null,
          name: null,
          created_at: "2024-01-01",
        },
      ]);
      execute.mockResolvedValueOnce([]);
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
      });

      await expect(
        caller.unlinkAccount({ accountId: "00000000-0000-0000-0000-000000000001" }),
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    });

    it("rejects invalid accountId before hitting the repository", async () => {
      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-1",
        timezone: "UTC",
      });

      await expect(caller.unlinkAccount({ accountId: "not-a-valid-guid" })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    });

    it("throws NOT_FOUND when account does not belong to user", async () => {
      const execute = vi.fn();
      execute.mockResolvedValueOnce([
        {
          id: "00000000-0000-0000-0000-000000000001",
          auth_provider: "google",
          email: null,
          name: null,
          created_at: "2024-01-01",
        },
      ]);
      execute.mockResolvedValueOnce([{ user_id: "user-1" }]);
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
      execute.mockResolvedValueOnce([
        {
          id: "00000000-0000-0000-0000-000000000001",
          auth_provider: "google",
          email: null,
          name: null,
          created_at: "2024-01-01",
        },
      ]);
      execute.mockResolvedValueOnce([{ user_id: "user-1" }]);
      execute.mockResolvedValueOnce([{ id: "00000000-0000-0000-0000-000000000001" }]);
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
