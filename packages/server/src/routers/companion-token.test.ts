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
  };
});

vi.mock("../lib/typed-sql.ts", () => ({
  executeWithSchema: async (
    db: { execute: (q: unknown) => Promise<unknown[]> },
    _schema: unknown,
    query: unknown,
  ): Promise<unknown[]> => {
    return db.execute(query);
  },
  timestampStringSchema: Object.assign(
    { parse: (v: unknown) => v },
    { nullable: () => ({ parse: (v: unknown) => v }) },
  ),
}));

vi.mock("dofek/db/account-erasure", () => ({
  AccountErasureUserFencedError: class AccountErasureUserFencedError extends Error {},
  withAccountErasureUserWriteFence: vi.fn(
    async (
      db: {
        transaction: <T>(
          operation: (transaction: {
            execute: (query: unknown) => Promise<unknown[]>;
          }) => Promise<T>,
        ) => Promise<T>;
      },
      _userId: string,
      operation: (transaction: {
        execute: (query: unknown) => Promise<unknown[]>;
      }) => Promise<unknown>,
    ) => db.transaction(operation),
  ),
}));

const { companionTokenRouter } = await import("./companion-token.ts");

const createCaller = createTestCallerFactory(companionTokenRouter);

describe("companionTokenRouter", () => {
  describe("retrieve", () => {
    it("returns a token when none exists", async () => {
      const execute = vi.fn();
      execute.mockResolvedValueOnce([
        {
          id: "new-id",
          user_id: "user-1",
          connection_type: "zepp-main",
          created_at: "2026-01-01T00:00:00.000Z",
          revoked_at: null,
        },
      ]);
      const caller = createCaller({ db: { execute }, userId: "user-1", timezone: "UTC" });
      const result = await caller.retrieve();
      expect(result.id).toBe("new-id");
      expect(result.token).not.toBeNull();
    });

    it("returns existing token metadata when token already exists", async () => {
      const execute = vi.fn();
      execute
        .mockResolvedValueOnce([]) // INSERT ON CONFLICT DO NOTHING returns nothing
        .mockResolvedValueOnce([
          {
            id: "existing-id",
            user_id: "user-1",
            connection_type: "zepp-main",
            created_at: "2026-01-01T00:00:00.000Z",
            revoked_at: null,
          },
        ]); // SELECT returns existing row
      const caller = createCaller({ db: { execute }, userId: "user-1", timezone: "UTC" });
      const result = await caller.retrieve();
      expect(result.id).toBe("existing-id");
      expect(result.token).toBeNull();
    });
  });

  describe("regenerate", () => {
    it("revokes existing token and creates a new one", async () => {
      const execute = vi.fn();
      execute
        .mockResolvedValueOnce([
          {
            acquired: true,
          },
        ]) // Acquire advisory lock
        .mockResolvedValueOnce([]) // UPDATE revoke
        .mockResolvedValueOnce([
          {
            id: "new-id",
            user_id: "user-1",
            connection_type: "zepp-main",
            created_at: "2026-01-01T00:00:00.000Z",
            revoked_at: null,
          },
        ]); // INSERT ... ON CONFLICT ... RETURNING
      const caller = createCaller({
        db: {
          transaction: async <T>(
            callback: (transaction: { execute: typeof execute }) => Promise<T>,
          ) => callback({ execute }),
        },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.regenerate();
      expect(result.id).toBe("new-id");
      expect(result.token).not.toBeNull();
    });

    it("returns a conflict when account deletion fences the write", async () => {
      const fenceError = new Error("Account deletion is active for this user.");
      const accountErasure = await import("dofek/db/account-erasure");
      vi.mocked(accountErasure.withAccountErasureUserWriteFence).mockRejectedValueOnce(
        Object.assign(new accountErasure.AccountErasureUserFencedError(), {
          message: fenceError.message,
        }),
      );
      const caller = createCaller({
        db: { transaction: vi.fn() },
        userId: "user-1",
        timezone: "UTC",
      });

      await expect(caller.regenerate()).rejects.toMatchObject({ code: "CONFLICT" });
    });
  });

  it("lists active connection types without exposing tokens", async () => {
    const execute = vi.fn().mockResolvedValueOnce([
      {
        id: "main-id",
        user_id: "user-1",
        connection_type: "zepp-main",
        created_at: "2026-01-01T00:00:00.000Z",
        revoked_at: null,
      },
      {
        id: "workout-id",
        user_id: "user-1",
        connection_type: "zepp-workout",
        created_at: "2026-01-02T00:00:00.000Z",
        revoked_at: null,
      },
    ]);
    const caller = createCaller({ db: { execute }, userId: "user-1", timezone: "UTC" });

    await expect(caller.list()).resolves.toEqual([
      {
        id: "main-id",
        connectionType: "zepp-main",
        createdAt: "2026-01-01T00:00:00.000Z",
        revokedAt: null,
      },
      {
        id: "workout-id",
        connectionType: "zepp-workout",
        createdAt: "2026-01-02T00:00:00.000Z",
        revokedAt: null,
      },
    ]);
  });

  it("revokes one requested connection type", async () => {
    const execute = vi.fn().mockResolvedValueOnce([
      {
        id: "workout-id",
        user_id: "user-1",
        connection_type: "zepp-workout",
        created_at: "2026-01-02T00:00:00.000Z",
        revoked_at: "2026-01-03T00:00:00.000Z",
      },
    ]);
    const caller = createCaller({ db: { execute }, userId: "user-1", timezone: "UTC" });

    await expect(caller.revoke({ connectionType: "zepp-workout" })).resolves.toEqual({
      revoked: true,
    });
  });
});
