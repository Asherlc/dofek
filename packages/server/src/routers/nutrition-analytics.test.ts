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
  const execute = vi.fn().mockImplementation(async (query: unknown) => {
    if (collectSqlText(query).includes("has_medication_records")) {
      return [{ has_medication_records: false, has_supplements: false }];
    }
    return [];
  });
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

    expect(collectSqlText(execute.mock.calls[0]?.[0])).toContain("AND fen.date > CURRENT_DATE -");
  });

  it("micronutrientAdequacy omits the lower date bound when days is null", async () => {
    const { caller, execute } = makeCaller();

    await caller.micronutrientAdequacy({ days: null });

    const queryText = collectSqlText(execute.mock.calls[0]?.[0]);
    expect(queryText).toContain("WHERE fen.user_id =");
    expect(queryText).toContain("fitness.v_nutrition_canonical_nutrient");
    expect(queryText).not.toContain("CURRENT_DATE -");
  });

  it("micronutrientAdequacyV2 applies the selected range to canonical contributions", async () => {
    const { caller, execute } = makeCaller();

    const result = await caller.micronutrientAdequacyV2({ days: 30 });

    expect(result).toMatchObject({
      nutrients: [],
      professionalReview: { status: "no_supplements" },
      dataQuality: {
        selectedWindowDays: 30,
        daysWithData: 0,
        usableDays: 0,
        overlapDays: 0,
        conflictDays: 0,
        completenessPercent: 0,
        sourceLabels: [],
        contributingSourceLabels: [],
        excludedSourceLabels: [],
      },
    });
    const queryText = execute.mock.calls
      .map((call) => collectSqlText(call[0]))
      .find((text) => text.includes("fitness.v_nutrition_canonical_nutrient"));
    expect(queryText).toContain("AND fen.date > CURRENT_DATE -");
  });

  it("adaptiveTdee uses one user-local end date for both data stores", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T15:30:00.000Z"));
    const { execute, sensorStore } = makeCaller();

    try {
      await createCaller({
        db: { execute },
        sensorStore,
        userId: "user-1",
        timezone: "Asia/Tokyo",
      }).adaptiveTdee({ days: 90 });

      const nutritionQuery = collectSqlText(execute.mock.calls[0]?.[0]);
      expect(nutritionQuery).toContain("AND date >");
      expect(nutritionQuery).toContain("2026-07-30");
      expect(nutritionQuery).toContain("AND date <=");
      expect(nutritionQuery).not.toContain("CURRENT_DATE");
      const bodyQueryText = vi.mocked(sensorStore.query).mock.calls[0]?.[1];
      const bodyQueryParams = vi.mocked(sensorStore.query).mock.calls[0]?.[2];
      expect(bodyQueryText).toContain("subtractDays(toDate({endDate:String}), {days:UInt32})");
      expect(bodyQueryParams).toMatchObject({ days: 90, endDate: "2026-07-30" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("adaptiveTdee bounds an all-time selection to the largest supported fit history", async () => {
    const { caller, execute, sensorStore } = makeCaller();

    await caller.adaptiveTdee({ days: null });

    expect(collectSqlText(execute.mock.calls[0]?.[0])).toContain("AND date >");
    const bodyQueryText = vi.mocked(sensorStore.query).mock.calls[0]?.[1];
    const bodyQueryParams = vi.mocked(sensorStore.query).mock.calls[0]?.[2];
    expect(bodyQueryText).toContain("WHERE user_id = {userId:UUID}");
    expect(bodyQueryText).toContain("subtractDays");
    expect(bodyQueryParams).toMatchObject({ days: 365 });
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
