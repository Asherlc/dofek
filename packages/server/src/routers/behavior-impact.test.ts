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

import { behaviorImpactRouter } from "./behavior-impact.ts";

const createCaller = createTestCallerFactory(behaviorImpactRouter);

describe("behaviorImpactRouter", () => {
  describe("impactSummary", () => {
    it("returns empty array when no data", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });
      const result = await caller.impactSummary({ days: 90 });

      expect(result).toEqual([]);
    });

    it("returns behavior impact data from SQL results", async () => {
      const rows = [
        {
          question_slug: "alcohol",
          display_name: "Alcohol",
          category: "substance",
          avg_readiness_yes: 55,
          avg_readiness_no: 70,
          yes_count: 10,
          no_count: 20,
        },
        {
          question_slug: "meditation",
          display_name: "Meditation",
          category: "wellness",
          avg_readiness_yes: 75,
          avg_readiness_no: 60,
          yes_count: 15,
          no_count: 12,
        },
      ];

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
      });
      const result = await caller.impactSummary({ days: 90 });

      expect(result).toHaveLength(2);

      const alcohol = result.find((r) => r.questionSlug === "alcohol");
      expect(alcohol).toBeDefined();
      expect(alcohol?.displayName).toBe("Alcohol");
      expect(alcohol?.category).toBe("substance");
      // Impact: ((55 - 70) / 70) * 100 = -21.4%
      expect(alcohol?.impactPercent).toBeCloseTo(-21.4, 0);
      expect(alcohol?.yesCount).toBe(10);
      expect(alcohol?.noCount).toBe(20);

      const meditation = result.find((r) => r.questionSlug === "meditation");
      expect(meditation).toBeDefined();
      // Impact: ((75 - 60) / 60) * 100 = 25%
      expect(meditation?.impactPercent).toBeCloseTo(25, 0);
    });

    it("uses default days of 90", async () => {
      const executeMock = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        db: { execute: executeMock },
        userId: "user-1",
      });
      await caller.impactSummary({});

      expect(executeMock).toHaveBeenCalled();
    });
  });
});
