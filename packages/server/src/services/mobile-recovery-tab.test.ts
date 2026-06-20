import { sql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import type { DailyMetricsViewRow } from "../repositories/daily-metrics-repository.ts";
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

function metricRow(
  date: string,
  hrv: number | null = 50,
  overrides: Partial<DailyMetricsViewRow> = {},
): DailyMetricsViewRow {
  return {
    date,
    user_id: "user-1",
    hrv,
    spo2_avg: null,
    respiratory_rate_avg: null,
    skin_temp_c: null,
    steps: null,
    active_energy_kcal: null,
    basal_energy_kcal: null,
    distance_km: null,
    flights_climbed: null,
    exercise_minutes: null,
    stand_hours: null,
    walking_speed: null,
    source_providers: ["apple_health"],
    ...overrides,
  };
}

function recoveryRow(overrides: Record<string, unknown> = {}) {
  return {
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
    ...overrides,
  };
}

async function runRecoveryTab(
  recoveryRows: ReturnType<typeof recoveryRow>[],
  options: {
    metrics?: DailyMetricsViewRow[];
    goalWeight?: string | null;
    days?: number;
    endDate?: string;
  } = {},
) {
  const query = vi.fn(async (_schema: unknown, sqlText: unknown) => {
    if (String(sqlText).includes("analytics.daily_recovery")) {
      return recoveryRows;
    }
    return [];
  });
  const ctx = {
    db: { execute: vi.fn(async () => []), transaction: vi.fn() },
    userId: "user-1",
    timezone: "UTC",
    accessWindow: { kind: "full" as const, paid: true as const, reason: "paid_grant" as const },
    sensorStore: { query },
  };

  vi.spyOn(
    (await import("../repositories/daily-metrics-repository.ts")).DailyMetricsRepository.prototype,
    "list",
  ).mockResolvedValue(options.metrics ?? []);
  vi.spyOn(
    (await import("../repositories/daily-metrics-repository.ts")).DailyMetricsRepository.prototype,
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
  ).mockResolvedValue(options.goalWeight != null ? { value: options.goalWeight } : null);

  return loadMobileRecoveryTab(ctx, options.days ?? 30, options.endDate ?? "2026-03-28");
}

describe("loadMobileRecoveryTab", () => {
  it("uses one daily_recovery query for readiness and stress", async () => {
    const query = vi.fn(async (_schema: unknown, sqlText: unknown) => {
      const sql = String(sqlText);
      if (sql.includes("analytics.daily_recovery")) {
        return [recoveryRow()];
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

  it("passes limited access windows to recovery queries", async () => {
    const query = vi.fn(async (_schema: unknown, sqlText: unknown) => {
      if (String(sqlText).includes("analytics.daily_recovery")) {
        return [recoveryRow()];
      }
      return [];
    });
    const execute = vi.fn(async () => []);
    const ctx = {
      db: { execute, transaction: vi.fn() },
      userId: "user-1",
      timezone: "UTC",
      accessWindow: {
        kind: "limited" as const,
        paid: false as const,
        reason: "free_signup_week" as const,
        startDate: "2026-03-10",
        endDateExclusive: "2026-03-20",
      },
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

    await loadMobileRecoveryTab(ctx, 30, "2026-03-28");

    const recoveryQuery = query.mock.calls.find((call) =>
      String(call[1]).includes("analytics.daily_recovery"),
    );
    expect(String(recoveryQuery?.[1])).toContain(
      "recovery_inputs.date >= toDate({accessStartDate:String})",
    );
    expect(String(recoveryQuery?.[1])).toContain(
      "recovery_inputs.date < toDate({accessEndDateExclusive:String})",
    );
    expect(recoveryQuery?.[2]).toMatchObject({
      accessStartDate: "2026-03-10",
      accessEndDateExclusive: "2026-03-20",
    });
  });

  it("computes resting heart rate deviation and rounded sleep efficiency in stress", async () => {
    const query = vi.fn(async (_schema: unknown, sqlText: unknown) => {
      if (String(sqlText).includes("analytics.daily_recovery")) {
        return [
          recoveryRow({
            date: "2026-03-28",
            resting_hr: 50,
            rhr_mean_60d: 54,
            rhr_sd_60d: 2,
            efficiency_pct: 92.34,
          }),
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

    const result = await loadMobileRecoveryTab(ctx, 30, "2026-03-28");

    expect(result.stress.daily[0]?.restingHrDeviation).toBe(-2);
    expect(result.stress.daily[0]?.sleepEfficiency).toBe(92.3);
  });

  it("computes HRV variability after seven consecutive HRV days", async () => {
    const query = vi.fn(async (_schema: unknown, sqlText: unknown) => {
      if (String(sqlText).includes("analytics.daily_recovery")) {
        return [];
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
    const hrvDays = Array.from({ length: 7 }, (_, index) =>
      metricRow(`2026-03-${String(22 + index).padStart(2, "0")}`, 50 + index),
    );

    vi.spyOn(
      (await import("../repositories/daily-metrics-repository.ts")).DailyMetricsRepository
        .prototype,
      "list",
    ).mockResolvedValue(hrvDays);
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

    const result = await loadMobileRecoveryTab(ctx, 30, "2026-03-28");

    expect(result.hrvVariability).toHaveLength(1);
    expect(result.hrvVariability[0]?.date).toBe("2026-03-28");
    expect(result.hrvVariability[0]?.hrv).toBe(56);
    expect(result.hrvVariability[0]?.rollingMean).toBe(53);
    expect(result.hrvVariability[0]?.rollingCoefficientOfVariation).toBeGreaterThan(0);
  });

  it("derives latest SpO2 and skin temperature trends from daily metrics", async () => {
    const query = vi.fn(async () => []);
    const execute = vi.fn(async () => []);
    const ctx = {
      db: { execute, transaction: vi.fn() },
      userId: "user-1",
      timezone: "UTC",
      accessWindow: { kind: "full" as const, paid: true as const, reason: "paid_grant" as const },
      sensorStore: { query },
    };

    vi.spyOn(
      (await import("../repositories/daily-metrics-repository.ts")).DailyMetricsRepository
        .prototype,
      "list",
    ).mockResolvedValue([
      metricRow("2026-03-27", 50, { spo2_avg: 97.5, skin_temp_c: 33.1 }),
      metricRow("2026-03-28", 52, { spo2_avg: 98.2, skin_temp_c: 33.4 }),
    ]);
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
    vi.spyOn(
      (await import("../repositories/settings-repository.ts")).SettingsRepository.prototype,
      "get",
    ).mockResolvedValue({ value: "75.5" });

    const result = await loadMobileRecoveryTab(ctx, 30, "2026-03-28");

    expect(result.trends).toEqual({
      latest_spo2: 98.2,
      latest_skin_temp: 33.4,
    });
    expect(predictionSpy).toHaveBeenCalledWith(90, "2026-03-28", 75.5);
  });

  describe("mutation killers", () => {
    it("rounds HRV deviation to 2 decimal places", async () => {
      const result = await runRecoveryTab([
        recoveryRow({ hrv: 45, hrv_mean_60d: 60, hrv_sd_60d: 7 }),
      ]);
      expect(result.stress.daily[0]?.hrvDeviation).toBe(-2.14);
    });

    it("returns null HRV deviation when hrv_sd_60d is zero", async () => {
      const result = await runRecoveryTab([
        recoveryRow({ hrv: 45, hrv_mean_60d: 60, hrv_sd_60d: 0 }),
      ]);
      expect(result.stress.daily[0]?.hrvDeviation).toBeNull();
    });

    it("returns null resting HR deviation when rhr_sd_60d is zero", async () => {
      const result = await runRecoveryTab([
        recoveryRow({ resting_hr: 70, rhr_mean_60d: 60, rhr_sd_60d: 0 }),
      ]);
      expect(result.stress.daily[0]?.restingHrDeviation).toBeNull();
    });

    it("returns null sleep efficiency when efficiency_pct is null", async () => {
      const result = await runRecoveryTab([recoveryRow({ efficiency_pct: null })]);
      expect(result.stress.daily[0]?.sleepEfficiency).toBeNull();
    });

    it("returns latest stress score from the last daily entry", async () => {
      const result = await runRecoveryTab([
        recoveryRow({ date: "2026-03-27", hrv: 40, hrv_mean_60d: 60, hrv_sd_60d: 10 }),
        recoveryRow({ date: "2026-03-28", hrv: 55, hrv_mean_60d: 60, hrv_sd_60d: 10 }),
      ]);
      expect(result.stress.latestScore).toBe(result.stress.daily.at(-1)?.stressScore ?? null);
      expect(result.stress.latestScore).not.toBeNull();
    });

    it("returns null latest stress score when no daily rows exist", async () => {
      const result = await runRecoveryTab([]);
      expect(result.stress.latestScore).toBeNull();
    });

    it("computes readiness components from recovery metrics", async () => {
      const result = await runRecoveryTab([
        recoveryRow({
          hrv: 60,
          resting_hr: 50,
          respiratory_rate: 13,
          efficiency_pct: 88,
        }),
      ]);
      expect(result.readinessScore[0]?.components.hrvScore).toBeGreaterThan(62);
      expect(result.readinessScore[0]?.components.restingHrScore).toBeGreaterThan(62);
      expect(result.readinessScore[0]?.components.sleepScore).toBe(88);
      expect(result.readinessScore[0]?.components.respiratoryRateScore).toBeGreaterThan(62);
    });

    it("rounds HRV variability values to expected precision", async () => {
      const metrics = Array.from({ length: 7 }, (_, index) =>
        metricRow(`2026-03-${String(22 + index).padStart(2, "0")}`, 52.67 + index * 0.1),
      );
      const result = await runRecoveryTab([], { metrics });
      const latest = result.hrvVariability.at(-1);
      expect(latest?.hrv).toBe(53.3);
      expect(latest?.rollingMean).toBeCloseTo(53, 1);
      expect(latest?.rollingCoefficientOfVariation).not.toBeNull();
    });

    it("returns null trends when daily metrics are empty", async () => {
      const result = await runRecoveryTab([]);
      expect(result.trends).toBeNull();
    });

    it("ignores invalid goal weight values", async () => {
      await expect(runRecoveryTab([], { goalWeight: "not-a-number" })).resolves.toMatchObject({
        weightPrediction: expect.any(Object),
      });
    });
  });
});
