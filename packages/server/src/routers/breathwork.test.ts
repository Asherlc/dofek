import { describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const t = initTRPC.context<{ db: unknown; userId: string | null }>().create();
  return {
    router: t.router,
    protectedProcedure: t.procedure,
    cachedProtectedQuery: () => t.procedure,
    cachedProtectedQueryLight: () => t.procedure,
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

import { breathworkRouter } from "./breathwork.ts";

const createCaller = createTestCallerFactory(breathworkRouter);

describe("breathworkRouter", () => {
  describe("techniques", () => {
    it("returns all available techniques", async () => {
      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-1",
      });
      const result = await caller.techniques();

      expect(result.length).toBeGreaterThanOrEqual(3);
      for (const technique of result) {
        expect(technique.id).toBeTruthy();
        expect(technique.name).toBeTruthy();
        expect(technique.inhaleSeconds).toBeGreaterThan(0);
        expect(technique.exhaleSeconds).toBeGreaterThan(0);
      }
    });
  });

  describe("logSession", () => {
    it("logs a breathwork session", async () => {
      const insertedRow = {
        id: "session-1",
        technique_id: "box-breathing",
        rounds: 4,
        duration_seconds: 64,
        started_at: "2026-03-22T10:00:00.000Z",
        notes: null,
      };

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([insertedRow]) },
        userId: "user-1",
      });
      const result = await caller.logSession({
        techniqueId: "box-breathing",
        rounds: 4,
        durationSeconds: 64,
        startedAt: "2026-03-22T10:00:00.000Z",
      });

      expect(result).not.toBeNull();
      expect(result?.techniqueId).toBe("box-breathing");
      expect(result?.rounds).toBe(4);
      expect(result?.durationSeconds).toBe(64);
    });
  });

  describe("history", () => {
    it("returns empty history when no sessions", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });
      const result = await caller.history({ days: 30 });

      expect(result).toEqual([]);
    });

    it("returns session history", async () => {
      const rows = [
        {
          id: "s1",
          technique_id: "box-breathing",
          rounds: 4,
          duration_seconds: 64,
          started_at: "2026-03-20T10:00:00.000Z",
          notes: null,
        },
        {
          id: "s2",
          technique_id: "4-7-8",
          rounds: 4,
          duration_seconds: 76,
          started_at: "2026-03-21T10:00:00.000Z",
          notes: "Before bed",
        },
      ];

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
      });
      const result = await caller.history({ days: 30 });

      expect(result).toHaveLength(2);
      expect(result[0]?.techniqueId).toBe("box-breathing");
      expect(result[1]?.notes).toBe("Before bed");
    });
  });
});
