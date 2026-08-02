import { describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{
      db: unknown;
      userId: string | null;
      timezone?: string;
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

vi.mock("dofek/personalization/storage", () => ({
  loadPersonalizedParams: vi.fn(async () => null),
}));

import { todayPlanRouter } from "./today-plan.ts";

const createCaller = createTestCallerFactory(todayPlanRouter);

type SensorStore = import("../repositories/activity-repository.ts").ActivitySensorStore;

function makeSensorStore(queryImpl: SensorStore["query"]): SensorStore {
  return {
    query: queryImpl,
    getActivitySummaries: vi.fn().mockResolvedValue([]),
    getStream: vi.fn().mockResolvedValue([]),
    getHeartRateZoneSeconds: vi.fn().mockResolvedValue([]),
    getPowerZoneSeconds: vi.fn().mockResolvedValue([]),
    getPowerCurveSamples: vi.fn().mockResolvedValue([]),
    getNormalizedPowerSamples: vi.fn().mockResolvedValue([]),
    getVo2MaxEstimates: vi.fn().mockResolvedValue([]),
    getHeartRateCurveRows: vi.fn().mockResolvedValue([]),
    getPaceCurveRows: vi.fn().mockResolvedValue([]),
  };
}

describe("todayPlanRouter.get", () => {
  it("returns the insufficient_data contract when recovery is missing", async () => {
    const caller = createCaller({
      db: { execute: vi.fn() },
      userId: "00000000-0000-4000-8000-000000000001",
      sensorStore: makeSensorStore(vi.fn(async () => [])),
    });

    const result = await caller.get({ endDate: "2026-07-26" });
    expect(result.status).toBe("insufficient_data");
    expect(result.action).toBeNull();
    expect(result.supportingFacts).toEqual([]);
    expect(result.message).toContain("recovery");
  });

  it("returns the ready contract with action and supporting facts", async () => {
    const query = vi.fn(async (_schema: unknown, queryText: unknown) => {
      const sqlText = String(queryText);
      if (sqlText.includes("analytics.daily_recovery")) {
        return [
          {
            date: "2026-07-26",
            hrv_score: 80,
            resting_hr_score: 80,
            sleep_score: 80,
            respiratory_rate_score: 80,
          },
        ];
      }
      if (sqlText.includes("analytics.daily_strain")) {
        return [{ date: "2026-07-26", daily_load: 40 }];
      }
      if (sqlText.includes("analytics.daily_sleep")) {
        return [{ date: "2026-07-26", duration_minutes: 480, efficiency_pct: 90 }];
      }
      return [];
    });

    const caller = createCaller({
      db: { execute: vi.fn() },
      userId: "00000000-0000-4000-8000-000000000001",
      sensorStore: makeSensorStore(query),
    });

    const result = await caller.get({ endDate: "2026-07-26" });
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.action.zone).toMatch(/Push|Maintain|Recovery/);
    expect(result.supportingFacts).toHaveLength(2);
    expect(result.caveats).toEqual([]);
    expect(result.confidence).toBe("high");
  });
});
