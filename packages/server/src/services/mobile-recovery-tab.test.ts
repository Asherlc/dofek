import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { loadMobileRecoveryTab } from "./mobile-recovery-tab.ts";

vi.mock("dofek/personalization/storage", () => ({
  loadPersonalizedParams: vi.fn(async () => null),
}));

vi.mock("../routers/healthspan-query.ts", () => ({
  fetchHealthspanRawData: vi.fn(async () => null),
}));

vi.mock("../repositories/resting-heart-rate-query.ts", () => ({
  fetchRestingHeartRateValuesCte: vi.fn(async () => sql`SELECT 1`),
}));

describe("loadMobileRecoveryTab", () => {
  it("uses one daily_recovery query for readiness and stress", async () => {
    const query = vi.fn(async (_schema: unknown, sqlText: unknown) => {
      const sql = String(sqlText);
      if (sql.includes("analytics.daily_recovery")) {
        return [
          {
            date: "2026-03-28",
            hrv: 55,
            resting_hr: 52,
            respiratory_rate: 14,
            hrv_mean_30d: 50,
            hrv_sd_30d: 5,
            rhr_mean_30d: 54,
            rhr_sd_30d: 2,
            rr_mean_30d: 14,
            rr_sd_30d: 1,
            hrv_mean_60d: 50,
            hrv_sd_60d: 5,
            rhr_mean_60d: 54,
            rhr_sd_60d: 2,
            efficiency_pct: 90,
          },
        ];
      }
      return [];
    });

    const execute = vi.fn(async () => []);
    const ctx = {
      db: { execute, transaction: vi.fn() },
      userId: "user-1",
      timezone: "UTC",
      accessWindow: { kind: "full" as const, paid: true as const, reason: "paid_grant" as const },
      sensorStore: { query },
    };

    const metricsRepoList = vi
      .spyOn(
        (await import("../repositories/daily-metrics-repository.ts")).DailyMetricsRepository
          .prototype,
        "list",
      )
      .mockResolvedValue([]);
    const metricsRepoBaseline = vi
      .spyOn(
        (await import("../repositories/daily-metrics-repository.ts")).DailyMetricsRepository
          .prototype,
        "getHrvBaseline",
      )
      .mockResolvedValue([]);
    const bodyRepoWeight = vi
      .spyOn(
        (await import("../repositories/body-analytics-repository.ts")).BodyAnalyticsRepository
          .prototype,
        "getSmoothedWeight",
      )
      .mockResolvedValue([]);
    const bodyRepoPrediction = vi
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
    vi.spyOn(
      (await import("../repositories/settings-repository.ts")).SettingsRepository.prototype,
      "get",
    ).mockResolvedValue(null);

    const result = await loadMobileRecoveryTab(ctx, 30, "2026-03-28");

    const recoveryQueries = query.mock.calls.filter((call) =>
      String(call[1]).includes("analytics.daily_recovery"),
    );
    expect(recoveryQueries).toHaveLength(1);
    expect(result.readinessScore).toHaveLength(1);
    expect(result.stress.daily).toHaveLength(1);

    metricsRepoList.mockRestore();
    metricsRepoBaseline.mockRestore();
    bodyRepoWeight.mockRestore();
    bodyRepoPrediction.mockRestore();
  });
});
