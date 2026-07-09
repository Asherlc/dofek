import { describe, expect, it, vi } from "vitest";
import { collectSqlText, createTestCallerFactory, makeMockSensorStore } from "./test-helpers.ts";

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

import { correlationRouter } from "./correlation.ts";

const createCaller = createTestCallerFactory(correlationRouter);

function makeCaller() {
  const execute = vi.fn().mockResolvedValue([]);
  const sensorStore = makeMockSensorStore([]);
  return {
    caller: createCaller({
      db: { execute },
      sensorStore,
      userId: "user-1",
      timezone: "UTC",
    }),
    execute,
    sensorStore,
  };
}

describe("correlation.compute selected ranges", () => {
  it("uses lower date bounds for finite selected ranges", async () => {
    const { caller, execute, sensorStore } = makeCaller();

    await caller.compute({ metricX: "protein", metricY: "hrv", days: 365, lag: 0 });

    const restingHeartRateParams = vi.mocked(sensorStore.query).mock.calls[0]?.[2];
    const sleepQueryText = vi.mocked(sensorStore.query).mock.calls[1]?.[1];
    const bodyQueryText = vi.mocked(sensorStore.query).mock.calls[2]?.[1];
    expect(restingHeartRateParams).toHaveProperty("rhrWindowStart");
    expect(sleepQueryText).toContain("subtractDays(toDate({endDate:String}), {days:UInt32})");
    expect(bodyQueryText).toContain("subtractDays(");
    expect(bodyQueryText).toContain("{days:UInt32}");

    const metricQueryText = collectSqlText(execute.mock.calls[0]?.[0]);
    const activityQueryText = collectSqlText(execute.mock.calls[1]?.[0]);
    const nutritionQueryText = collectSqlText(execute.mock.calls[2]?.[0]);
    expect(metricQueryText).toContain("AND dm.date >");
    expect(activityQueryText).toContain("AND started_at >");
    expect(nutritionQueryText).toContain("AND date >");
  });

  it("omits lower date bounds when days is null", async () => {
    const { caller, execute, sensorStore } = makeCaller();

    await caller.compute({ metricX: "protein", metricY: "hrv", days: null, lag: 0 });

    const restingHeartRateQueryText = vi.mocked(sensorStore.query).mock.calls[0]?.[1];
    const restingHeartRateParams = vi.mocked(sensorStore.query).mock.calls[0]?.[2];
    const sleepQueryText = vi.mocked(sensorStore.query).mock.calls[1]?.[1];
    const sleepQueryParams = vi.mocked(sensorStore.query).mock.calls[1]?.[2];
    const bodyQueryText = vi.mocked(sensorStore.query).mock.calls[2]?.[1];
    const bodyQueryParams = vi.mocked(sensorStore.query).mock.calls[2]?.[2];
    expect(restingHeartRateQueryText).not.toContain("rhrWindowStart");
    expect(restingHeartRateParams).not.toHaveProperty("rhrWindowStart");
    expect(sleepQueryText).not.toContain("subtractDays");
    expect(sleepQueryParams).not.toHaveProperty("days");
    expect(bodyQueryText).not.toContain("subtractDays");
    expect(bodyQueryParams).not.toHaveProperty("days");

    const metricQueryText = collectSqlText(execute.mock.calls[0]?.[0]);
    const activityQueryText = collectSqlText(execute.mock.calls[1]?.[0]);
    const nutritionQueryText = collectSqlText(execute.mock.calls[2]?.[0]);
    expect(metricQueryText).toContain("WHERE dm.user_id =");
    expect(metricQueryText).not.toContain("dm.date >");
    expect(activityQueryText).toContain("WHERE user_id =");
    expect(activityQueryText).not.toContain("started_at >");
    expect(nutritionQueryText).toContain("WHERE user_id =");
    expect(nutritionQueryText).not.toContain("date >");
  });
});
