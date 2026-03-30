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
    adminProcedure: trpc.procedure,
    cachedProtectedQuery: () => trpc.procedure,
    cachedProtectedQueryLight: () => trpc.procedure,
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

import { adminRouter } from "./admin.ts";

const createCaller = createTestCallerFactory(adminRouter);

describe("adminRouter", () => {
  describe("overview", () => {
    it("returns table row counts", async () => {
      const rows = [
        { table_name: "user_profile", row_count: "5" },
        { table_name: "activity", row_count: "1000" },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "admin-1",
        timezone: "UTC",
      });
      const result = await caller.overview();
      expect(result).toEqual(rows);
    });
  });

  describe("users", () => {
    it("returns user profiles", async () => {
      const rows = [
        {
          id: "user-1",
          name: "Test",
          email: "test@test.com",
          birth_date: null,
          is_admin: false,
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-01T00:00:00Z",
        },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "admin-1",
        timezone: "UTC",
      });
      const result = await caller.users();
      expect(result).toHaveLength(1);
      expect(result[0]).toBeDefined();
      expect(result[0]?.name).toBe("Test");
    });
  });

  describe("setAdmin", () => {
    it("updates admin status", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        db: { execute },
        userId: "admin-1",
        timezone: "UTC",
      });
      const result = await caller.setAdmin({
        userId: "00000000-0000-0000-0000-000000000002",
        isAdmin: true,
      });
      expect(result).toEqual({ ok: true });
      expect(execute).toHaveBeenCalledOnce();
    });
  });

  describe("syncLogs", () => {
    it("returns paginated sync logs with total count", async () => {
      const execute = vi.fn();
      execute.mockResolvedValueOnce([
        {
          id: "log-1",
          provider_id: "whoop",
          user_id: "user-1",
          user_name: "Test",
          data_type: "sleep",
          status: "success",
          records_synced: "10",
          error_message: null,
          started_at: "2024-01-01T00:00:00Z",
          completed_at: "2024-01-01T00:01:00Z",
        },
      ]);
      execute.mockResolvedValueOnce([{ count: "100" }]);
      const caller = createCaller({
        db: { execute },
        userId: "admin-1",
        timezone: "UTC",
      });
      const result = await caller.syncLogs({ limit: 50, offset: 0 });
      expect(result.rows).toHaveLength(1);
      expect(result.total).toBe("100");
    });
  });

  describe("deleteSession", () => {
    it("deletes a session", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        db: { execute },
        userId: "admin-1",
        timezone: "UTC",
      });
      const result = await caller.deleteSession({ sessionId: "session-abc" });
      expect(result).toEqual({ ok: true });
      expect(execute).toHaveBeenCalledOnce();
    });
  });

  describe("syncHealth", () => {
    it("returns provider sync stats", async () => {
      const rows = [
        {
          provider_id: "whoop",
          total: "50",
          succeeded: "48",
          failed: "2",
          last_sync: "2024-01-01T00:00:00Z",
        },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "admin-1",
        timezone: "UTC",
      });
      const result = await caller.syncHealth();
      expect(result).toHaveLength(1);
      expect(result[0]).toBeDefined();
      expect(result[0]?.provider_id).toBe("whoop");
    });
  });
});
