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

vi.mock("../lib/ai-coach.ts", () => ({
  generateDailyOutlook: vi.fn().mockResolvedValue({
    outlook: {
      summary: "You are well-recovered today.",
      recommendations: ["Go for a moderate run", "Stay hydrated"],
      focusArea: "training",
    },
    provider: "gemini",
  }),
  chatWithCoach: vi.fn().mockResolvedValue({
    response: "Based on your HRV, you can push harder today.",
    provider: "gemini",
  }),
}));

import { aiCoachRouter } from "./ai-coach.ts";

const createCaller = createTestCallerFactory(aiCoachRouter);

describe("aiCoachRouter", () => {
  describe("dailyOutlook", () => {
    it("returns daily outlook with context from SQL data", async () => {
      // Mock SQL returning recent metrics
      const metricsRow = {
        sleep_hours: 7.5,
        resting_hr: 55,
        hrv: 48,
        readiness: 72,
      };

      const activitiesRows = [
        { name: "Running", duration_min: 45 },
        { name: "Cycling", duration_min: 60 },
      ];

      const executeMock = vi.fn();
      // First call returns metrics, second returns activities
      executeMock.mockResolvedValueOnce([metricsRow]).mockResolvedValueOnce(activitiesRows);

      const caller = createCaller({
        db: { execute: executeMock },
        userId: "user-1",
      });
      const result = await caller.dailyOutlook();

      expect(result.summary).toBeTruthy();
      expect(result.recommendations).toBeDefined();
      expect(result.focusArea).toBeTruthy();
    });
  });

  describe("chat", () => {
    it("returns a response from the AI coach", async () => {
      const metricsRow = {
        sleep_hours: 7,
        resting_hr: 58,
        hrv: 45,
        readiness: 65,
      };

      const executeMock = vi.fn();
      executeMock.mockResolvedValueOnce([metricsRow]).mockResolvedValueOnce([]);

      const caller = createCaller({
        db: { execute: executeMock },
        userId: "user-1",
      });
      const result = await caller.chat({
        messages: [{ role: "user", content: "Should I work out today?" }],
      });

      expect(result.response).toBeTruthy();
      expect(typeof result.response).toBe("string");
    });
  });
});
