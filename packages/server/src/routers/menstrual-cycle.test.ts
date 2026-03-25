import { describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC.context<{ db: unknown; userId: string | null }>().create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
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

import { menstrualCycleRouter } from "./menstrual-cycle.ts";

const createCaller = createTestCallerFactory(menstrualCycleRouter);

describe("menstrualCycleRouter", () => {
  describe("currentPhase", () => {
    it("returns null phase when no periods logged", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });
      const result = await caller.currentPhase();

      expect(result.phase).toBeNull();
      expect(result.dayOfCycle).toBeNull();
    });

    it("computes current phase from most recent period", async () => {
      // Most recent period started 10 days ago, avg cycle = 28
      const rows = [
        {
          start_date: new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10),
          avg_cycle_length: 28,
        },
      ];

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
      });
      const result = await caller.currentPhase();

      expect(result.phase).not.toBeNull();
      expect(result.dayOfCycle).toBe(11); // day 1 is start day, day 11 is 10 days later
      expect(result.cycleLength).toBe(28);
    });
  });

  describe("history", () => {
    it("returns empty history when no data", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });
      const result = await caller.history({ months: 6 });

      expect(result).toEqual([]);
    });

    it("returns period history from SQL results", async () => {
      const rows = [
        {
          id: "p1",
          start_date: "2026-01-15",
          end_date: "2026-01-20",
          notes: null,
        },
        {
          id: "p2",
          start_date: "2026-02-12",
          end_date: "2026-02-17",
          notes: null,
        },
      ];

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
      });
      const result = await caller.history({ months: 6 });

      expect(result).toHaveLength(2);
      expect(result[0]?.startDate).toBe("2026-01-15");
      expect(result[1]?.startDate).toBe("2026-02-12");
    });
  });

  describe("logPeriod", () => {
    it("logs a new period start", async () => {
      const insertedRow = {
        id: "new-id",
        start_date: "2026-03-01",
        end_date: null,
        notes: null,
      };

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([insertedRow]) },
        userId: "user-1",
      });
      const result = await caller.logPeriod({ startDate: "2026-03-01" });

      expect(result?.id).toBe("new-id");
      expect(result?.startDate).toBe("2026-03-01");
    });
  });
});
