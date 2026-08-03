import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { fetchHealthspanRawData } from "../routers/healthspan-query.ts";
import { loadMobileRecoveryTab } from "./mobile-recovery-tab.ts";

vi.mock("dofek/personalization/storage", () => ({
  loadPersonalizedParams: vi.fn(async () => null),
}));

vi.mock("dofek/lib/error-reporting", () => ({
  captureException: vi.fn(),
}));

vi.mock("../routers/healthspan-query.ts", () => ({
  fetchHealthspanRawData: vi.fn(async () => null),
}));

vi.mock("../repositories/resting-heart-rate-query.ts", () => ({
  fetchRestingHeartRateValuesCte: vi.fn(async () => sql`SELECT 1`),
}));

describe("loadMobileRecoveryTab dependent query context", () => {
  it("passes healthspan context through to the healthspan query", async () => {
    const query = vi.fn(async () => []);
    const accessWindow = {
      kind: "full" as const,
      paid: true as const,
      reason: "paid_grant" as const,
    };
    const sensorStore = { query };
    const ctx = {
      db: { execute: vi.fn(async () => []), transaction: vi.fn() },
      userId: "user-abc",
      timezone: "Europe/London",
      accessWindow,
      sensorStore,
    };

    vi.spyOn(
      (await import("../repositories/daily-metrics-repository.ts")).DailyMetricsRepository
        .prototype,
      "list",
    ).mockResolvedValue([]);
    vi.spyOn(
      (await import("../repositories/daily-metrics-repository.ts")).DailyMetricsRepository
        .prototype,
      "getHrvBaseline",
    ).mockResolvedValue([]);
    vi.spyOn(
      (await import("../repositories/body-analytics-repository.ts")).BodyAnalyticsRepository
        .prototype,
      "getSmoothedWeight",
    ).mockResolvedValue([]);
    vi.spyOn(
      (await import("../repositories/body-analytics-repository.ts")).BodyAnalyticsRepository
        .prototype,
      "getWeightPrediction",
    ).mockResolvedValue({
      ratePerWeek: null,
      rateConfidence: null,
      impliedDailyCalories: null,
      periodDeltas: { days7: null, days14: null, days30: null },
      goal: null,
      projectionLine: [],
    });
    vi.spyOn(
      (await import("../repositories/settings-repository.ts")).SettingsRepository.prototype,
      "get",
    ).mockResolvedValue(null);

    vi.mocked(fetchHealthspanRawData).mockClear();
    await loadMobileRecoveryTab(ctx, 30, "2026-03-28");

    expect(vi.mocked(fetchHealthspanRawData)).toHaveBeenCalledWith(
      {
        userId: "user-abc",
        timezone: "Europe/London",
        accessWindow,
        sensorStore,
      },
      "2026-03-28",
      35,
    );
  });

  it("passes parsed goal weight to weight prediction", async () => {
    const predictionSpy = vi
      .spyOn(
        (await import("../repositories/body-analytics-repository.ts")).BodyAnalyticsRepository
          .prototype,
        "getWeightPrediction",
      )
      .mockResolvedValue({
        ratePerWeek: null,
        rateConfidence: null,
        impliedDailyCalories: null,
        periodDeltas: { days7: null, days14: null, days30: null },
        goal: null,
        projectionLine: [],
      });
    const query = vi.fn(async () => []);
    const ctx = {
      db: { execute: vi.fn(async () => []), transaction: vi.fn() },
      userId: "user-1",
      timezone: "UTC",
      accessWindow: { kind: "full" as const, paid: true as const, reason: "paid_grant" as const },
      sensorStore: { query },
    };

    vi.spyOn(
      (await import("../repositories/daily-metrics-repository.ts")).DailyMetricsRepository
        .prototype,
      "list",
    ).mockResolvedValue([]);
    vi.spyOn(
      (await import("../repositories/daily-metrics-repository.ts")).DailyMetricsRepository
        .prototype,
      "getHrvBaseline",
    ).mockResolvedValue([]);
    vi.spyOn(
      (await import("../repositories/body-analytics-repository.ts")).BodyAnalyticsRepository
        .prototype,
      "getSmoothedWeight",
    ).mockResolvedValue([]);
    vi.spyOn(
      (await import("../repositories/settings-repository.ts")).SettingsRepository.prototype,
      "get",
    ).mockResolvedValue({ value: "72.4" });

    await loadMobileRecoveryTab(ctx, 30, "2026-03-28");

    expect(predictionSpy).toHaveBeenCalledWith(90, "2026-03-28", 72.4);
    predictionSpy.mockRestore();
  });
});
