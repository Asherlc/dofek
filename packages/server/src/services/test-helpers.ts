import { vi } from "vitest";
import { z } from "zod";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import type {
  BodyFatPrediction,
  SmoothedBodyFatRow,
  SmoothedWeightRow,
} from "../repositories/body-analytics-repository.ts";
import type {
  DailyMetricsViewRow,
  HrvBaselineRow,
} from "../repositories/daily-metrics-repository.ts";
import type { BodyDecisionContext } from "./body-decision-context.ts";
import type { loadMobileRecoveryTab } from "./mobile-recovery-tab.ts";

export function metricRow(
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
    distance_km: null,
    flights_climbed: null,
    exercise_minutes: null,
    stand_hours: null,
    walking_speed: null,
    source_providers: ["apple_health"],
    ...overrides,
  };
}

export function recoveryRow(overrides: Record<string, unknown> = {}) {
  return {
    date: "2026-03-28",
    hrv: 55,
    resting_hr: 52,
    respiratory_rate: 14,
    hrv_mean_30d: 50,
    hrv_sd_30d: 5,
    hrv_z_score: 1,
    hrv_baseline_sample_count: 30,
    hrv_baseline_coverage: 1,
    hrv_mean_7d: 55,
    hrv_mean_previous_28d: 50,
    rhr_mean_30d: 54,
    rhr_sd_30d: 2,
    resting_hr_z_score: -1,
    rhr_baseline_sample_count: 30,
    rhr_baseline_coverage: 1,
    rhr_mean_7d: 52,
    rhr_mean_previous_28d: 54,
    rr_mean_30d: 14,
    rr_sd_30d: 1,
    respiratory_rate_z_score: -1,
    rr_baseline_sample_count: 30,
    rr_baseline_coverage: 1,
    rr_mean_7d: 13.5,
    rr_mean_previous_28d: 14,
    efficiency_pct: 90,
    efficiency_mean_30d: 85,
    efficiency_sd_30d: 5,
    efficiency_z_score: 1,
    efficiency_baseline_sample_count: 30,
    efficiency_baseline_coverage: 1,
    efficiency_mean_7d: 90,
    efficiency_mean_previous_28d: 85,
    ...overrides,
  };
}

function bodyDecisionContextFixture(): BodyDecisionContext {
  return {
    latestMeasurement: null,
    trendWeight: {
      smoothing: "ewma",
      alpha: 0.1,
      gapHandling: "linear_interpolation",
      invalidWeightHandling: "exclude_non_positive",
      outlierHandling: "retain",
    },
    variation: {
      status: "insufficient_data",
      observations: 0,
      minimumObservations: 8,
      maximumObservations: 30,
      method: "tukey_inner_fence",
      lowerResidualKg: null,
      upperResidualKg: null,
      outliersIncluded: true,
    },
  };
}

type LoadMobileRecoveryTab = typeof loadMobileRecoveryTab;

export async function runRecoveryTab(
  loadRecoveryTab: LoadMobileRecoveryTab,
  recoveryRows: ReturnType<typeof recoveryRow>[],
  options: {
    metrics?: DailyMetricsViewRow[];
    hrvBaseline?: HrvBaselineRow[];
    weight?: SmoothedWeightRow[];
    bodyFatTrend?: SmoothedBodyFatRow[];
    bodyFatPrediction?: BodyFatPrediction;
    goalWeight?: string | null;
    days?: number;
    endDate?: string;
    decisionContext?: BodyDecisionContext | null;
    decisionContextError?: Error;
  } = {},
) {
  const query: ActivitySensorStore["query"] = async <TSchema extends z.ZodType>(
    schema: TSchema,
    sqlText: string,
  ): Promise<z.infer<TSchema>[]> => {
    if (sqlText.includes("analytics.daily_recovery")) {
      return z.array(schema).parse(recoveryRows);
    }
    return [];
  };
  const sensorStore: ActivitySensorStore = {
    query,
    getActivitySummaries: vi.fn().mockResolvedValue([]),
    getPowerCurveSamples: vi.fn().mockResolvedValue([]),
    getNormalizedPowerSamples: vi.fn().mockResolvedValue([]),
    getVo2MaxEstimates: vi.fn().mockResolvedValue([]),
    getHeartRateCurveRows: vi.fn().mockResolvedValue([]),
    getPaceCurveRows: vi.fn().mockResolvedValue([]),
    getStream: vi.fn().mockResolvedValue([]),
    getHeartRateZoneSeconds: vi.fn().mockResolvedValue([]),
    getPowerZoneSeconds: vi.fn().mockResolvedValue([]),
    refreshBodyMeasurements: vi.fn().mockResolvedValue(undefined),
  };
  const ctx = {
    db: { execute: vi.fn(async () => []), transaction: vi.fn() },
    userId: "user-1",
    timezone: "UTC",
    accessWindow: { kind: "full" as const, paid: true as const, reason: "paid_grant" as const },
    sensorStore,
  };

  vi.spyOn(
    (await import("../repositories/daily-metrics-repository.ts")).DailyMetricsRepository.prototype,
    "list",
  ).mockResolvedValue(options.metrics ?? []);
  vi.spyOn(
    (await import("../repositories/daily-metrics-repository.ts")).DailyMetricsRepository.prototype,
    "getHrvBaseline",
  ).mockResolvedValue(options.hrvBaseline ?? []);
  vi.spyOn(
    (await import("../repositories/body-analytics-repository.ts")).BodyAnalyticsRepository
      .prototype,
    "getSmoothedWeight",
  ).mockResolvedValue(options.weight ?? []);
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
    (await import("../repositories/body-analytics-repository.ts")).BodyAnalyticsRepository
      .prototype,
    "getSmoothedBodyFat",
  ).mockResolvedValue(options.bodyFatTrend ?? []);
  vi.spyOn(
    (await import("../repositories/body-analytics-repository.ts")).BodyAnalyticsRepository
      .prototype,
    "getBodyFatPrediction",
  ).mockResolvedValue(
    options.bodyFatPrediction ?? {
      ratePerWeek: null,
      rateConfidence: null,
      periodDeltas: { days7: null, days14: null, days30: null },
      projectionLine: [],
    },
  );
  const decisionContextSpy = vi.spyOn(
    (await import("../repositories/body-analytics-repository.ts")).BodyAnalyticsRepository
      .prototype,
    "getBodyDecisionContext",
  );
  if (options.decisionContextError) {
    decisionContextSpy.mockRejectedValue(options.decisionContextError);
  } else {
    decisionContextSpy.mockResolvedValue(options.decisionContext ?? bodyDecisionContextFixture());
  }
  vi.spyOn(
    (await import("../repositories/settings-repository.ts")).SettingsRepository.prototype,
    "get",
  ).mockResolvedValue(
    options.goalWeight != null ? { key: "goalWeight", value: options.goalWeight } : null,
  );

  return loadRecoveryTab(ctx, options.days ?? 30, options.endDate ?? "2026-03-28");
}
