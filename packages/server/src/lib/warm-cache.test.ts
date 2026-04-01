import { beforeEach, describe, expect, it, vi } from "vitest";

const { createCallerMock, infoMock, warnMock, errorMock } = vi.hoisted(() => ({
  createCallerMock: vi.fn(),
  infoMock: vi.fn(),
  warnMock: vi.fn(),
  errorMock: vi.fn(),
}));

vi.mock("../router.ts", () => ({
  appRouter: {
    createCaller: createCallerMock,
  },
}));

vi.mock("../logger.ts", () => ({
  logger: {
    info: infoMock,
    warn: warnMock,
    error: errorMock,
  },
}));

import { logger } from "../logger.ts";
import { appRouter } from "../router.ts";
import { warmCache } from "./warm-cache.ts";

function buildCaller() {
  const dailyMetricsList = vi.fn().mockResolvedValue([]);
  const dailyMetricsTrends = vi.fn().mockResolvedValue([]);
  const dailyMetricsLatest = vi.fn().mockResolvedValue({});
  const sleepList = vi.fn().mockResolvedValue([]);
  const syncProviders = vi.fn().mockResolvedValue([]);
  const syncProviderStats = vi.fn().mockResolvedValue([]);
  const insightsCompute = vi.fn().mockResolvedValue({});
  const trainingWeeklyVolume = vi.fn().mockResolvedValue([]);
  const trainingHrZones = vi.fn().mockResolvedValue([]);
  const trainingNextWorkout = vi.fn().mockResolvedValue(null);
  const pmcChart = vi.fn().mockResolvedValue([]);
  const powerCurve = vi.fn().mockResolvedValue([]);
  const eftpTrend = vi.fn().mockResolvedValue([]);
  const aerobicEfficiency = vi.fn().mockResolvedValue([]);
  const polarizationTrend = vi.fn().mockResolvedValue([]);
  const rampRate = vi.fn().mockRejectedValue(new Error("db error"));
  const trainingMonotony = vi.fn().mockResolvedValue([]);
  const activityVariability = vi.fn().mockResolvedValue([]);
  const verticalAscentRate = vi.fn().mockResolvedValue([]);
  const runningDynamics = vi.fn().mockResolvedValue([]);
  const runningPaceTrend = vi.fn().mockResolvedValue([]);

  const caller = {
    dailyMetrics: {
      list: dailyMetricsList,
      trends: dailyMetricsTrends,
      latest: dailyMetricsLatest,
    },
    sleep: { list: sleepList },
    sync: { providers: syncProviders, providerStats: syncProviderStats },
    insights: { compute: insightsCompute },
    training: {
      weeklyVolume: trainingWeeklyVolume,
      hrZones: trainingHrZones,
      nextWorkout: trainingNextWorkout,
    },
    pmc: { chart: pmcChart },
    power: { powerCurve, eftpTrend },
    efficiency: {
      aerobicEfficiency,
      polarizationTrend,
    },
    cyclingAdvanced: {
      rampRate,
      trainingMonotony,
      activityVariability,
      verticalAscentRate,
    },
    running: {
      dynamics: runningDynamics,
      paceTrend: runningPaceTrend,
    },
  };

  return {
    caller,
    spies: {
      dailyMetricsList,
      dailyMetricsTrends,
      dailyMetricsLatest,
      sleepList,
      syncProviders,
      syncProviderStats,
      insightsCompute,
      trainingWeeklyVolume,
      trainingHrZones,
      trainingNextWorkout,
      pmcChart,
      powerCurve,
      eftpTrend,
      aerobicEfficiency,
      polarizationTrend,
      rampRate,
      trainingMonotony,
      activityVariability,
      verticalAscentRate,
      runningDynamics,
      runningPaceTrend,
    },
  };
}

describe("warmCache", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("warms every configured query with expected payloads and logs final count", async () => {
    const dbExecute = vi.fn().mockResolvedValue([{ id: "test-user" }]);
    const { caller, spies } = buildCaller();
    createCallerMock.mockReturnValue(caller);

    await warmCache({ execute: dbExecute });

    const endDate = new Date().toISOString().slice(0, 10);
    expect(appRouter.createCaller).toHaveBeenCalledTimes(1);
    expect(appRouter.createCaller).toHaveBeenCalledWith({
      db: { execute: dbExecute },
      userId: "test-user",
      timezone: "UTC",
    });

    expect(spies.dailyMetricsList).toHaveBeenNthCalledWith(1, { days: 30, endDate });
    expect(spies.dailyMetricsList).toHaveBeenNthCalledWith(2, { days: 90, endDate });
    expect(spies.dailyMetricsTrends).toHaveBeenCalledWith({ days: 30, endDate });
    expect(spies.trainingNextWorkout).toHaveBeenCalledWith({ endDate });
    expect(spies.dailyMetricsLatest).toHaveBeenCalledWith();
    expect(spies.sleepList).toHaveBeenCalledWith({ days: 30, endDate });
    expect(spies.syncProviders).toHaveBeenCalledWith();
    expect(spies.syncProviderStats).toHaveBeenCalledWith();
    expect(spies.insightsCompute).toHaveBeenCalledWith({ days: 90, endDate });
    expect(spies.trainingWeeklyVolume).toHaveBeenCalledWith({ days: 90 });
    expect(spies.trainingHrZones).toHaveBeenCalledWith({ days: 90 });
    expect(spies.pmcChart).toHaveBeenCalledWith({ days: 90 });
    expect(spies.powerCurve).toHaveBeenCalledWith({ days: 90 });
    expect(spies.eftpTrend).toHaveBeenCalledWith({ days: 90 });
    expect(spies.aerobicEfficiency).toHaveBeenCalledWith({ days: 180 });
    expect(spies.polarizationTrend).toHaveBeenCalledWith({ days: 180 });
    expect(spies.rampRate).toHaveBeenCalledWith({ days: 90 });
    expect(spies.trainingMonotony).toHaveBeenCalledWith({ days: 90 });
    expect(spies.activityVariability).toHaveBeenCalledWith({ days: 90, limit: 20, offset: 0 });
    expect(spies.verticalAscentRate).toHaveBeenCalledWith({ days: 90 });
    expect(spies.runningDynamics).toHaveBeenCalledWith({ days: 90 });
    expect(spies.runningPaceTrend).toHaveBeenCalledWith({ days: 90 });

    expect(logger.info).toHaveBeenCalledWith("[cache] Warmed 21/22 queries");
  });

  it("logs query failures and continues warming remaining queries", async () => {
    const dbExecute = vi.fn().mockResolvedValue([{ id: "test-user" }]);
    const { caller, spies } = buildCaller();
    createCallerMock.mockReturnValue(caller);

    await warmCache({ execute: dbExecute });

    expect(spies.runningDynamics).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "[cache] Failed to warm cyclingAdvanced.rampRate(90): Error: db error",
      ),
    );
  });

  it("skips warmup when no user rows exist", async () => {
    const dbExecute = vi.fn().mockResolvedValue([]);
    const { caller } = buildCaller();
    createCallerMock.mockReturnValue(caller);

    await warmCache({ execute: dbExecute });

    expect(appRouter.createCaller).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith("[cache] Skipping warmup: no user_profile rows found");
    expect(logger.info).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });
});
