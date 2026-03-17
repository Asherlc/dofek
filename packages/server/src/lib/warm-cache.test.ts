import { describe, expect, it, vi } from "vitest";

vi.mock("../router.ts", () => ({
  appRouter: {
    createCaller: vi.fn(() => {
      const mockFn = vi.fn().mockResolvedValue([]);
      const failingFn = vi.fn().mockRejectedValue(new Error("db error"));
      return {
        dailyMetrics: {
          list: mockFn,
          trends: mockFn,
          latest: mockFn,
        },
        sleep: { list: mockFn },
        sync: { providers: mockFn, providerStats: mockFn },
        insights: { compute: mockFn },
        training: { weeklyVolume: mockFn, hrZones: mockFn },
        pmc: { chart: mockFn },
        power: { powerCurve: mockFn, eftpTrend: mockFn },
        efficiency: {
          aerobicEfficiency: mockFn,
          polarizationTrend: mockFn,
        },
        cyclingAdvanced: {
          rampRate: failingFn,
          trainingMonotony: mockFn,
          activityVariability: mockFn,
          verticalAscentRate: mockFn,
        },
      };
    }),
  },
}));

vi.mock("../logger.ts", () => ({
  logger: {
    info: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("dofek/db", () => ({
  createDatabaseFromEnv: vi.fn(() => ({})),
}));

import { createDatabaseFromEnv } from "dofek/db";
import { logger } from "../logger.ts";
import { warmCache } from "./warm-cache.ts";

describe("warmCache", () => {
  it("calls all queries and logs success count", async () => {
    const fakeDb = createDatabaseFromEnv();
    await warmCache(fakeDb);

    // Should log the final warm count
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringMatching(/\[cache\] Warmed \d+\/\d+ queries/),
    );
  });

  it("logs errors for failed queries without throwing", async () => {
    const fakeDb = createDatabaseFromEnv();
    await warmCache(fakeDb);

    // rampRate is mocked to fail
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining("[cache] Failed to warm cyclingAdvanced.rampRate(90)"),
    );
  });
});
