import { describe, expect, it, vi } from "vitest";

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

import { sleepRouter } from "./sleep.ts";
import { createTestCallerFactory } from "./test-helpers.ts";

const createCaller = createTestCallerFactory(sleepRouter);

describe("sleepRouter access window", () => {
  it("list passes accessWindow to repository (limited window returns empty)", async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const caller = createCaller({
      db: { execute },
      userId: "user-1",
      timezone: "UTC",
      sensorStore: {
        query: vi.fn().mockResolvedValue([]),
        getActivitySummaries: vi.fn().mockResolvedValue([]),
        getStream: vi.fn().mockResolvedValue([]),
        getHeartRateZoneSeconds: vi.fn().mockResolvedValue([]),
        getPowerZoneSeconds: vi.fn().mockResolvedValue([]),
        getPowerCurveSamples: vi.fn().mockResolvedValue([]),
        getNormalizedPowerSamples: vi.fn().mockResolvedValue([]),
        getVo2MaxEstimates: vi.fn().mockResolvedValue([]),
        getHeartRateCurveRows: vi.fn().mockResolvedValue([]),
        getPaceCurveRows: vi.fn().mockResolvedValue([]),
      },
      accessWindow: {
        kind: "limited",
        paid: false,
        reason: "free_recent_week",
        startDate: "2026-04-10",
        endDateExclusive: "2026-04-17",
      },
    });
    const result = await caller.list({ days: 30, endDate: "2026-04-26" });
    expect(result).toEqual([]);
  });

  it("list uses a lower date bound for finite selected ranges", async () => {
    const query = vi.fn().mockResolvedValue([]);
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      timezone: "UTC",
      sensorStore: {
        query,
        getActivitySummaries: vi.fn().mockResolvedValue([]),
        getStream: vi.fn().mockResolvedValue([]),
        getHeartRateZoneSeconds: vi.fn().mockResolvedValue([]),
        getPowerZoneSeconds: vi.fn().mockResolvedValue([]),
        getPowerCurveSamples: vi.fn().mockResolvedValue([]),
        getNormalizedPowerSamples: vi.fn().mockResolvedValue([]),
        getVo2MaxEstimates: vi.fn().mockResolvedValue([]),
        getHeartRateCurveRows: vi.fn().mockResolvedValue([]),
        getPaceCurveRows: vi.fn().mockResolvedValue([]),
      },
    });

    await caller.list({ days: 30, endDate: "2026-04-26" });

    const queryText = query.mock.calls[0]?.[1];
    const queryParams = query.mock.calls[0]?.[2];
    expect(queryText).toContain("subtractDays(toDate({endDate:String}), {days:UInt32})");
    expect(queryParams).toMatchObject({ endDate: "2026-04-26", days: 30 });
  });

  it("list omits the lower date bound when days is null", async () => {
    const query = vi.fn().mockResolvedValue([]);
    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      timezone: "UTC",
      sensorStore: {
        query,
        getActivitySummaries: vi.fn().mockResolvedValue([]),
        getStream: vi.fn().mockResolvedValue([]),
        getHeartRateZoneSeconds: vi.fn().mockResolvedValue([]),
        getPowerZoneSeconds: vi.fn().mockResolvedValue([]),
        getPowerCurveSamples: vi.fn().mockResolvedValue([]),
        getNormalizedPowerSamples: vi.fn().mockResolvedValue([]),
        getVo2MaxEstimates: vi.fn().mockResolvedValue([]),
        getHeartRateCurveRows: vi.fn().mockResolvedValue([]),
        getPaceCurveRows: vi.fn().mockResolvedValue([]),
      },
    });

    await caller.list({ days: null, endDate: "2026-04-26" });

    const queryText = query.mock.calls[0]?.[1];
    const queryParams = query.mock.calls[0]?.[2];
    expect(queryText).toContain("WHERE sleep.user_id = {userId:UUID}");
    expect(queryText).toContain("<= toDate({endDate:String})");
    expect(queryText).not.toContain("subtractDays");
    expect(queryParams).toMatchObject({ userId: "user-1", endDate: "2026-04-26" });
    expect(queryParams).not.toHaveProperty("days");
  });
});
