import { describe, expect, it, vi } from "vitest";
import { collectSqlText, createTestCallerFactory } from "./test-helpers.ts";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{
      db: unknown;
      userId: string | null;
      timezone?: string;
      sensorStore?: { query: (...args: unknown[]) => Promise<unknown[]> };
    }>()
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

import { behaviorImpactRouter } from "./behavior-impact.ts";

const createCaller = createTestCallerFactory(behaviorImpactRouter);

function makeSensorStore() {
  return {
    query: vi.fn().mockResolvedValue([{ date: "2024-01-01", resting_hr: 52 }]),
  };
}

describe("behaviorImpactRouter", () => {
  describe("impactSummary", () => {
    it("returns empty array when no data", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeSensorStore(),
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
          provider_ids: ["manual_review"],
        },
        {
          question_slug: "meditation",
          display_name: "Meditation",
          category: "wellness",
          avg_readiness_yes: 75,
          avg_readiness_no: 60,
          yes_count: 15,
          no_count: 12,
          provider_ids: ["whoop", "manual_review"],
        },
      ];

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeSensorStore(),
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
      expect(alcohol?.sources).toEqual([{ providerId: "manual_review", label: "Manual review" }]);
      expect(alcohol?.association).toEqual({
        relationship: "descriptive_association",
        direction: "lower",
        estimateLabel: "21.4% lower",
        method: "Relative difference in mean next-day readiness after Yes versus No.",
        interpretation:
          "This observational association does not establish that the behavior caused the readiness difference or prescribe a behavior change.",
        uncertainty: "Uncertainty interval is unavailable for this descriptive comparison.",
        observationWindow: "90 days",
      });

      const meditation = result.find((r) => r.questionSlug === "meditation");
      expect(meditation).toBeDefined();
      // Impact: ((75 - 60) / 60) * 100 = 25%
      expect(meditation?.impactPercent).toBeCloseTo(25, 0);
      expect(meditation?.sources).toEqual([
        { providerId: "manual_review", label: "Manual review" },
        { providerId: "whoop", label: "WHOOP (Cloud)" },
      ]);
    });

    it("returns unavailable association semantics for a zero No-group baseline", async () => {
      const caller = createCaller({
        db: {
          execute: vi.fn().mockResolvedValue([
            {
              question_slug: "zero-baseline",
              display_name: "Zero baseline",
              category: "test",
              avg_readiness_yes: 65,
              avg_readiness_no: 0,
              yes_count: 8,
              no_count: 7,
              provider_ids: ["manual_review"],
            },
          ]),
        },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeSensorStore(),
      });

      const [result] = await caller.impactSummary({ days: 90 });

      expect(result?.impactPercent).toBeNull();
      expect(result?.association).toMatchObject({
        direction: "unavailable",
        estimateLabel: "Estimate unavailable",
        observationWindow: "90 days",
      });
    });

    it("uses default days of 90", async () => {
      const executeMock = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        db: { execute: executeMock },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeSensorStore(),
      });
      await caller.impactSummary({});

      expect(executeMock).toHaveBeenCalled();
    });

    it("uses lower date bounds for finite selected ranges", async () => {
      const executeMock = vi.fn().mockResolvedValue([]);
      const sensorStore = makeSensorStore();
      const caller = createCaller({
        db: { execute: executeMock },
        userId: "user-1",
        timezone: "UTC",
        sensorStore,
      });

      await caller.impactSummary({ days: 90 });

      const restingHeartRateParams = vi.mocked(sensorStore.query).mock.calls[0]?.[2];
      expect(restingHeartRateParams).toHaveProperty("rhrWindowStart");
      const queryText = collectSqlText(executeMock.mock.calls[0]?.[0]);
      expect(queryText).toContain("je.user_id =");
      expect(queryText).toContain("je.date >=");
      expect(queryText).toContain("dm.date >=");
    });

    it("omits lower date bounds when days is null", async () => {
      const executeMock = vi.fn().mockResolvedValue([]);
      const sensorStore = makeSensorStore();
      const caller = createCaller({
        db: { execute: executeMock },
        userId: "user-1",
        timezone: "UTC",
        sensorStore,
      });

      await caller.impactSummary({ days: null });

      const restingHeartRateQueryText = vi.mocked(sensorStore.query).mock.calls[0]?.[1];
      const restingHeartRateParams = vi.mocked(sensorStore.query).mock.calls[0]?.[2];
      expect(restingHeartRateQueryText).not.toContain("rhrWindowStart");
      expect(restingHeartRateParams).not.toHaveProperty("rhrWindowStart");
      const queryText = collectSqlText(executeMock.mock.calls[0]?.[0]);
      expect(queryText).toContain("je.user_id =");
      expect(queryText).toContain("dm.user_id =");
      expect(queryText).not.toContain("je.date >=");
      expect(queryText).not.toContain("dm.date >=");
    });
  });
});
