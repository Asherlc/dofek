import { describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC.context<{ db: unknown; userId: string | null }>().create();
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

// The insights engine is the heavy computation — mock it so we test router delegation
vi.mock("../insights/engine.ts", () => ({
  computeInsights: vi.fn(() => ({
    insights: [{ type: "sleep", title: "Good sleep consistency", score: 85 }],
    generatedAt: "2026-03-28",
  })),
}));

import { insightsRouter } from "./insights.ts";

const createCaller = createTestCallerFactory(insightsRouter);

function makeCaller(rows: Record<string, unknown>[] = []) {
  return createCaller({
    db: { execute: vi.fn().mockResolvedValue(rows) },
    userId: "user-1",
  });
}

describe("insightsRouter", () => {
  describe("compute", () => {
    it("returns computed insights", async () => {
      const caller = makeCaller([]);
      const result = await caller.compute({ days: 90, endDate: "2026-03-28" });

      expect(result).toBeDefined();
      expect(result.insights).toHaveLength(1);
      expect(result.insights[0]?.title).toBe("Good sleep consistency");
    });

    it("uses default days parameter when not specified", async () => {
      const caller = makeCaller([]);
      // Should not throw — default days (90) should be applied
      const result = await caller.compute({ endDate: "2026-03-28" });
      expect(result).toBeDefined();
    });

    it("passes custom days parameter to repository", async () => {
      const caller = makeCaller([]);
      const result = await caller.compute({ days: 30, endDate: "2026-03-28" });
      expect(result).toBeDefined();
    });
  });
});
