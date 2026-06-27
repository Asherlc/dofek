import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import { describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC.context<{ db: unknown; userId: string | null; timezone: string }>().create();
  return { router: trpc.router, protectedProcedure: trpc.procedure, cachedProtectedQuery: () => trpc.procedure };
});

vi.mock("../lib/typed-sql.ts", () => ({
  executeWithSchema: async (db: { execute: (q: unknown) => unknown }, _schema: unknown, query: unknown) => {
    const rows = await db.execute(query);
    return rows as unknown[];
  },
  timestampStringSchema: { parse: (v: unknown) => v },
}));

const { companionTokenRouter } = await import("./companion-token.ts");

const createCaller = createTestCallerFactory(companionTokenRouter);

describe("companionTokenRouter", () => {
  describe("retrieve", () => {
    it("returns a token when none exists", async () => {
      const execute = vi.fn();
      execute
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: "new-id", user_id: "user-1", created_at: "2026-01-01T00:00:00.000Z", revoked_at: null }]);
      const caller = createCaller({ db: { execute }, userId: "user-1", timezone: "UTC" });
      const result = await caller.retrieve();
      expect(result.id).toBe("new-id");
      expect(result.token).not.toBe("");
    });

    it("returns existing token metadata when token already exists", async () => {
      const execute = vi.fn();
      execute
        .mockResolvedValueOnce([{ token_hash: "exists" }])
        .mockResolvedValueOnce([{ id: "existing-id", user_id: "user-1", created_at: "2026-01-01T00:00:00.000Z", revoked_at: null }]);
      const caller = createCaller({ db: { execute }, userId: "user-1", timezone: "UTC" });
      const result = await caller.retrieve();
      expect(result.id).toBe("existing-id");
      expect(result.token).toBe("");
    });
  });

  describe("regenerate", () => {
    it("revokes existing token and creates a new one", async () => {
      const execute = vi.fn();
      execute
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: "new-id", user_id: "user-1", created_at: "2026-01-01T00:00:00.000Z", revoked_at: null }]);
      const caller = createCaller({ db: { execute }, userId: "user-1", timezone: "UTC" });
      const result = await caller.regenerate();
      expect(result.id).toBe("new-id");
      expect(result.token).not.toBe("");
    });
  });
});
