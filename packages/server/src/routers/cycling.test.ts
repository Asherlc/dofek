import { describe, expect, it, vi } from "vitest";

const cachedQueryOptions = vi.hoisted(
  (): Array<{
    maxAge: number;
    expiresAt?: string;
    keyVersion?: string;
    scopeByAccessWindow?: boolean;
  }> => [],
);

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
    cachedProtectedQuery: (options: {
      maxAge: number;
      expiresAt?: string;
      keyVersion?: string;
      scopeByAccessWindow?: boolean;
    }) => {
      cachedQueryOptions.push(options);
      return trpc.procedure.meta(options);
    },
    CacheTTL: { LONG: 3_600_000 },
  };
});

import { CyclingAnalyticsRepository } from "../repositories/cycling-analytics-repository.ts";
import { CyclingDecouplingRepository } from "../repositories/cycling-decoupling-repository.ts";
import { CyclingDurabilityRepository } from "../repositories/cycling-durability-repository.ts";
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
  it("passes the selected decoupling range to the repository", async () => {
    const getTrend = vi
      .spyOn(CyclingDecouplingRepository.prototype, "getTrend")
      .mockResolvedValue({ workoutName: null, rides: [] });
    try {
      const caller = createCaller(makeContext());
      await expect(caller.decoupling({ days: 30 })).resolves.toEqual({
        workoutName: null,
        rides: [],
      });
      expect(getTrend.mock.calls[0]?.[0].days).toBe(30);
    } finally {
      getTrend.mockRestore();
    }
  });

  it("uses the selected number of local dates for the power profile", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-01T00:30:00Z"));
    try {
      const caller = createCaller(makeContext());
      await expect(caller.powerProfile({ days: 7 })).resolves.toMatchObject({
        range: {
          start_date: "2026-10-25",
          end_date: "2026-10-31",
          timezone: "America/Los_Angeles",
        },
        efforts: [
          { duration_seconds: 5, effort: null },
          { duration_seconds: 60, effort: null },
          { duration_seconds: 300, effort: null },
        ],
        threshold: { watts: null },
      });
      await expect(caller.powerProfile({ days: null })).resolves.toMatchObject({
        range: { start_date: null, end_date: "2026-10-31" },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("scopes the power profile cache to the access window", () => {
    expect(cyclingRouter._def.procedures.powerProfile._def.meta).toEqual({
      maxAge: 3_600_000,
      expiresAt: "localDayBoundary",
      scopeByAccessWindow: true,
    });
  });

  it("serves the approved selections on the selected chart range", async () => {
    const comparison = {
      status: "no_eligible_power_and_weight" as const,
      range: { startDate: "2026-10-19", endDate: "2026-11-15" },
      selection: { durationSeconds: 300, minimumWorkKilojoulesPerKg: 30 } as const,
      presentation: { unit: "watts" as const, difference: 0, absoluteWorkCutoffKilojoules: null },
      baseline: null,
      afterWork: null,
      sameEffort: false,
    };
    const getComparison = vi
      .spyOn(CyclingDurabilityRepository.prototype, "getComparison")
      .mockResolvedValue(comparison);
    try {
      const caller = createCaller(makeContext());
      await expect(caller.durability({ days: 28, ...comparison.selection })).resolves.toEqual(
        comparison,
      );
      expect(getComparison.mock.calls[0]?.[0].days).toBe(28);
      expect(getComparison.mock.calls[0]?.[1]).toMatchObject(comparison.selection);
      expect(getComparison.mock.calls[0]?.[2]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    } finally {
      getComparison.mockRestore();
    }
  });

  it("scopes the decoupling cache by the caller's access window", () => {
    expect(cyclingRouter._def.procedures.decoupling._def.meta).toEqual({
      maxAge: 3_600_000,
      expiresAt: "localDayBoundary",
      scopeByAccessWindow: true,
    });
  });

  it("versions the performance cache contract", () => {
    expect(cachedQueryOptions).toContainEqual({
      maxAge: 3_600_000,
      expiresAt: "localDayBoundary",
      keyVersion: "manual-ftp-power-stress-v6",
    });
  });

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
          unavailableReason: "No computed cycling training stress is available.",
          data: [],
          model: { ftp: null },
        },
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
        },
        estimateEvidence: {
          recent: {
            threshold: {
              method: "Critical Power model",
              confidence: "not_available",
              confidenceLabel: "Not available",
              confidenceDetail: "No power durations.",
              sourceWorkouts: [],
              pacingGuidance: "Do not use this estimate for pacing.",
            },
            vo2Max: {
              method: "Indirect estimate",
              confidence: "not_available",
              confidenceLabel: "Not available",
              confidenceDetail: "No five-minute power effort.",
              sourceWorkouts: [],
              pacingGuidance: "Do not use this estimate for pacing.",
            },
          },
          season: {
            threshold: {
              method: "Critical Power model",
              confidence: "not_available",
              confidenceLabel: "Not available",
              confidenceDetail: "No power durations.",
              sourceWorkouts: [],
              pacingGuidance: "Do not use this estimate for pacing.",
            },
            vo2Max: {
              method: "Indirect estimate",
              confidence: "not_available",
              confidenceLabel: "Not available",
              confidenceDetail: "No five-minute power effort.",
              sourceWorkouts: [],
              pacingGuidance: "Do not use this estimate for pacing.",
            },
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
