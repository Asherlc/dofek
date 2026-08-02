import { describe, expect, it, vi } from "vitest";

const cachedQueryOptions = vi.hoisted((): Array<{ maxAge: number; keyVersion?: string }> => []);

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
    cachedProtectedQuery: (options: { maxAge: number; keyVersion?: string }) => {
      cachedQueryOptions.push(options);
      return trpc.procedure;
    },
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
  it("versions the performance cache contract", () => {
    expect(cachedQueryOptions).toContainEqual({
      maxAge: 3_600_000,
      keyVersion: "cycling-performance-v2",
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
          data: [],
          model: { type: "generic", pairedActivities: 0, r2: null, ftp: null },
        },
        eftpTrend: { trend: [], currentEftp: null, model: null },
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
          eftp: {
            method: "Normalized power × 0.95 for each cycling workout",
            confidence: "not_available",
            confidenceLabel: "Not available",
            confidenceDetail: "No normalized-power workouts.",
            sourceWorkouts: [],
            pacingGuidance: "Do not use this estimate for pacing.",
          },
        },
      });
    const caller = createCaller(makeContext());

    await expect(caller.performance({ days: 90 })).resolves.toMatchObject({
      powerCurve: { recent: { points: [] }, season: { points: [] } },
    });
    expect(getPerformance).toHaveBeenCalledWith(expect.objectContaining({ days: 90 }));
  });
});
