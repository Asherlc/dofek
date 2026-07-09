import { describe, expect, it, vi } from "vitest";
import { collectSqlText, createTestCallerFactory, makeMockSensorStore } from "./test-helpers.ts";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{
      db: unknown;
      userId: string | null;
      timezone: string;
      accessWindow?: import("../billing/entitlement.ts").AccessWindow;
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

import { nutritionAnalyticsRouter } from "./nutrition-analytics.ts";

const createCaller = createTestCallerFactory(nutritionAnalyticsRouter);

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

describe("nutritionAnalyticsRouter selected ranges", () => {
  it("micronutrientAdequacy uses a lower date bound for finite ranges", async () => {
    const { caller, execute } = makeCaller();

    await caller.micronutrientAdequacy({ days: 30 });

    expect(collectSqlText(execute.mock.calls[0]?.[0])).toContain("AND fe.date > CURRENT_DATE -");
  });

  it("micronutrientAdequacy omits the lower date bound when days is null", async () => {
    const { caller, execute } = makeCaller();

    await caller.micronutrientAdequacy({ days: null });

    const queryText = collectSqlText(execute.mock.calls[0]?.[0]);
    expect(queryText).toContain("WHERE fe.user_id =");
    expect(queryText).toContain("AND fe.confirmed = true");
    expect(queryText).not.toContain("CURRENT_DATE -");
  });

  it("caloricBalance uses lower date bounds for finite ranges", async () => {
    const { caller, execute } = makeCaller();

    await caller.caloricBalance({ days: 30 });

    const queryText = collectSqlText(execute.mock.calls[0]?.[0]);
    expect(queryText).toContain("AND date > CURRENT_DATE -");
    expect(queryText).toContain("FROM combined");
  });

  it("caloricBalance omits lower date bounds when days is null", async () => {
    const { caller, execute } = makeCaller();

    await caller.caloricBalance({ days: null });

    const queryText = collectSqlText(execute.mock.calls[0]?.[0]);
    expect(queryText).toContain("WHERE user_id =");
    expect(queryText).not.toContain("CURRENT_DATE -");
  });

  it("adaptiveTdee uses lower date bounds for finite ranges", async () => {
    const { caller, execute, sensorStore } = makeCaller();

    await caller.adaptiveTdee({ days: 90 });

    expect(collectSqlText(execute.mock.calls[0]?.[0])).toContain("AND date > CURRENT_DATE -");
    const bodyQueryText = vi.mocked(sensorStore.query).mock.calls[0]?.[1];
    const bodyQueryParams = vi.mocked(sensorStore.query).mock.calls[0]?.[2];
    expect(bodyQueryText).toContain("subtractDays(today(), {days:UInt32})");
    expect(bodyQueryParams).toMatchObject({ days: 90 });
  });

  it("adaptiveTdee omits lower date bounds when days is null", async () => {
    const { caller, execute, sensorStore } = makeCaller();

    await caller.adaptiveTdee({ days: null });

    expect(collectSqlText(execute.mock.calls[0]?.[0])).not.toContain("CURRENT_DATE -");
    const bodyQueryText = vi.mocked(sensorStore.query).mock.calls[0]?.[1];
    const bodyQueryParams = vi.mocked(sensorStore.query).mock.calls[0]?.[2];
    expect(bodyQueryText).toContain("WHERE user_id = {userId:UUID}");
    expect(bodyQueryText).not.toContain("subtractDays");
    expect(bodyQueryParams).not.toHaveProperty("days");
  });

  it("macroRatios uses a lower date bound for finite ranges", async () => {
    const { caller, execute } = makeCaller();

    await caller.macroRatios({ days: 30 });

    expect(collectSqlText(execute.mock.calls[0]?.[0])).toContain("AND nd.date > CURRENT_DATE -");
  });

  it("macroRatios omits the lower date bound when days is null", async () => {
    const { caller, execute } = makeCaller();

    await caller.macroRatios({ days: null });

    const queryText = collectSqlText(execute.mock.calls[0]?.[0]);
    expect(queryText).toContain("WHERE nd.user_id =");
    expect(queryText).not.toContain("CURRENT_DATE -");
  });
});
