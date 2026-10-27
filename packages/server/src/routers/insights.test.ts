import { describe, expect, it, vi } from "vitest";
import { collectSqlText, createTestCallerFactory, makeMockSensorStore } from "./test-helpers.ts";

const cachedQueryOptions = vi.hoisted((): Array<{ maxAge: number; keyVersion?: string }> => []);

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{
      db: unknown;
      userId: string | null;
      timezone: string;
      sensorStore?: import("../repositories/activity-repository.ts").ActivitySensorStore;
    }>()
    .create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
    cachedProtectedQuery: (options: { maxAge: number; keyVersion?: string }) => {
      cachedQueryOptions.push(options);
      return trpc.procedure;
    },
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
    timezone: "UTC",
    sensorStore: makeMockSensorStore([]),
  });
}

describe("insightsRouter", () => {
  describe("compute", () => {
    it("versions the server-authored evidence cache contract", () => {
      expect(cachedQueryOptions).toContainEqual({
        maxAge: 600_000,
        keyVersion: "insights-evidence-v1",
      });
    });

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

    it("uses lower bounds for finite selected ranges", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      const sensorStore = makeMockSensorStore([]);
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
        sensorStore,
      });

      await caller.compute({ days: 90, endDate: "2026-03-28" });

      const dailyMetricsQueryText = vi.mocked(sensorStore.query).mock.calls[0]?.[1];
      const dailyMetricsQueryParams = vi.mocked(sensorStore.query).mock.calls[0]?.[2];
      const restingHeartRateParams = vi.mocked(sensorStore.query).mock.calls[1]?.[2];
      const sleepQueryText = vi.mocked(sensorStore.query).mock.calls[2]?.[1];
      const bodyQueryText = vi.mocked(sensorStore.query).mock.calls[3]?.[1];
      expect(dailyMetricsQueryText).toContain("daily_metrics.date > toDate({windowStart:String})");
      expect(dailyMetricsQueryParams).toMatchObject({ windowStart: "2025-12-28" });
      expect(restingHeartRateParams).toHaveProperty("rhrWindowStart");
      expect(sleepQueryText).toContain("subtractDays(toDate({endDate:String}), {days:UInt32})");
      expect(bodyQueryText).toContain("subtractDays(");
      expect(bodyQueryText).toContain("{days:UInt32}");

      const activityQueryText = collectSqlText(execute.mock.calls[0]?.[0]);
      const nutritionQueryText = collectSqlText(execute.mock.calls[1]?.[0]);
      expect(activityQueryText).toContain("AND started_at >");
      expect(nutritionQueryText).toContain("AND date >");
    });

    it("omits lower bounds when days is null", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      const sensorStore = makeMockSensorStore([]);
      const caller = createCaller({
        db: { execute },
        userId: "user-1",
        timezone: "UTC",
        sensorStore,
      });

      await caller.compute({ days: null, endDate: "2026-03-28" });

      const dailyMetricsQueryText = vi.mocked(sensorStore.query).mock.calls[0]?.[1];
      const dailyMetricsQueryParams = vi.mocked(sensorStore.query).mock.calls[0]?.[2];
      const restingHeartRateQueryText = vi.mocked(sensorStore.query).mock.calls[1]?.[1];
      const restingHeartRateParams = vi.mocked(sensorStore.query).mock.calls[1]?.[2];
      const sleepQueryText = vi.mocked(sensorStore.query).mock.calls[2]?.[1];
      const sleepQueryParams = vi.mocked(sensorStore.query).mock.calls[2]?.[2];
      const bodyQueryText = vi.mocked(sensorStore.query).mock.calls[3]?.[1];
      const bodyQueryParams = vi.mocked(sensorStore.query).mock.calls[3]?.[2];
      expect(dailyMetricsQueryText).toContain("WHERE daily_metrics.user_id = {userId:UUID}");
      expect(dailyMetricsQueryText).not.toContain("windowStart");
      expect(dailyMetricsQueryParams).not.toHaveProperty("windowStart");
      expect(restingHeartRateQueryText).not.toContain("rhrWindowStart");
      expect(restingHeartRateParams).not.toHaveProperty("rhrWindowStart");
      expect(sleepQueryText).not.toContain("subtractDays");
      expect(sleepQueryParams).not.toHaveProperty("days");
      expect(bodyQueryText).not.toContain("subtractDays");
      expect(bodyQueryParams).not.toHaveProperty("days");

      const activityQueryText = collectSqlText(execute.mock.calls[0]?.[0]);
      const nutritionQueryText = collectSqlText(execute.mock.calls[1]?.[0]);
      expect(activityQueryText).toContain("WHERE user_id =");
      expect(activityQueryText).not.toContain("started_at >");
      expect(nutritionQueryText).toContain("WHERE user_id =");
      expect(nutritionQueryText).not.toContain("date >");
    });
  });
});
