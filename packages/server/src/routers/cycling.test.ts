import { describe, expect, it, vi } from "vitest";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{
      db: unknown;
      userId: string | null;
      timezone: string;
      sensorStore?: unknown;
      accessWindow?: unknown;
    }>()
    .create();
  return {
    router: trpc.router,
    cachedProtectedQuery: () => trpc.procedure,
    CacheTTL: { LONG: 3_600_000 },
  };
});

import { CyclingAnalyticsRepository } from "../repositories/cycling-analytics-repository.ts";
import { cyclingRouter } from "./cycling.ts";
import { createTestCallerFactory, makeMockSensorStore } from "./test-helpers.ts";

const createCaller = createTestCallerFactory(cyclingRouter);
const fullAccessWindow = { kind: "full", paid: true, reason: "paid_grant" } as const;

function makeContext() {
  return {
    db: { execute: vi.fn().mockResolvedValue([]) },
    userId: "user-1",
    timezone: "America/Los_Angeles",
    sensorStore: makeMockSensorStore(),
    accessWindow: fullAccessWindow,
  };
}

describe("cyclingRouter", () => {
  it("requires the ClickHouse activity analytics store", async () => {
    const context = makeContext();
    Reflect.deleteProperty(context, "sensorStore");
    const caller = createCaller(context);

    await expect(caller.performance({ days: 30 })).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      message:
        "ClickHouse activity analytics store is required for cycling analytics. Set CLICKHOUSE_URL and retry.",
    });
  });

  it("loads performance analytics through the repository for the selected range", async () => {
    const getPerformance = vi
      .spyOn(CyclingAnalyticsRepository.prototype, "getPerformance")
      .mockResolvedValue({
        powerCurve: {
          recent: { points: [], model: null },
          season: { points: [], model: null },
        },
        powerSummary: {
          weightKg: null,
          recent: {
            efforts: [],
            maximalAerobicPower: null,
            vo2Max: null,
            timeToExhaustionSeconds: null,
          },
          season: {
            efforts: [],
            maximalAerobicPower: null,
            vo2Max: null,
            timeToExhaustionSeconds: null,
          },
        },
        pmc: {
          data: [],
          model: { type: "generic", pairedActivities: 0, r2: null, ftp: null },
        },
        eftpTrend: { trend: [], currentEftp: null, model: null },
        availability: {
          powerCurve: {
            status: "insufficient_data",
            sourceLabel: "Cycling power-curve read model",
            observedCount: 0,
            minimumCount: 1,
            message: "No cycling power-curve data is available.",
          },
          pmc: {
            status: "insufficient_data",
            sourceLabel: "Cycling training-load model",
            observedCount: 0,
            minimumCount: 1,
            message: "No training-load data is available.",
          },
          eftpTrend: {
            status: "insufficient_data",
            sourceLabel: "Cycling activity power summaries",
            observedCount: 0,
            minimumCount: 1,
            message: "No threshold power data is available.",
          },
        },
      });
    const caller = createCaller(makeContext());

    await expect(caller.performance({ days: 90 })).resolves.toMatchObject({
      powerCurve: { recent: { points: [] }, season: { points: [] } },
    });
    expect(getPerformance).toHaveBeenCalledWith(expect.objectContaining({ days: 90 }));
  });

  it("returns activity chart availability through the public contract", async () => {
    const getActivities = vi
      .spyOn(CyclingAnalyticsRepository.prototype, "getActivities")
      .mockResolvedValue({
        activities: { items: [], totalCount: 0 },
        variability: { rows: [], totalCount: 0, emptyReason: "no_cycling_activities" },
        verticalAscent: [],
        aerobicEfficiency: { maxHr: null, activities: [] },
        availability: {
          verticalAscent: {
            status: "insufficient_data",
            sourceLabel: "Cycling activity altitude sensor summaries",
            observedCount: 0,
            minimumCount: 1,
            message: "No vertical ascent data is available.",
          },
          aerobicEfficiency: {
            status: "insufficient_data",
            sourceLabel: "Cycling Zone 2 power and heart-rate summaries",
            observedCount: 0,
            minimumCount: 1,
            message: "No aerobic efficiency data is available.",
          },
        },
      });
    const caller = createCaller(makeContext());

    await expect(caller.activities({ days: 30 })).resolves.toMatchObject({
      activities: { totalCount: 0 },
      availability: {
        verticalAscent: { status: "insufficient_data", observedCount: 0 },
        aerobicEfficiency: { status: "insufficient_data", observedCount: 0 },
      },
    });

    expect(getActivities).toHaveBeenCalledWith(
      expect.objectContaining({}),
      expect.objectContaining({
        activityLimit: 20,
        activityOffset: 0,
        variabilityLimit: 20,
        variabilityOffset: 0,
      }),
    );
    getActivities.mockRestore();
  });
});
