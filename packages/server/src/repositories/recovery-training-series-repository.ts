import { z } from "zod";
import type { AnalyticalTrainingLoadRepository } from "./analytical-training-load-repository.ts";
import type { BodyRepository } from "./body-repository.ts";
import type { ClickHouseSleepNight } from "./clickhouse-sleep-repository.ts";
import type { DailyMetricsRepository, HealthTrendRow } from "./daily-metrics-repository.ts";
import type { FoodRepository } from "./food-repository.ts";
import type { DirectWeightObservation } from "./nearby-weight.ts";
import { selectNearbyWeight } from "./nearby-weight.ts";
import type {
  RecoveryActivityExposureFilters,
  RecoveryDailyActivityExposure,
} from "./recovery-activity-exposure-repository.ts";
import type { SleepRepository } from "./sleep-repository.ts";
import type { SubjectiveRepository } from "./subjective-repository.ts";

export const recoveryTrainingStreamSchema = z.enum([
  "health",
  "sleep",
  "body_weight",
  "training_load",
  "subjective",
  "activities",
  "nutrition",
]);
export type RecoveryTrainingStream = z.infer<typeof recoveryTrainingStreamSchema>;

export interface RecoveryTrainingSeriesSources {
  dailyMetrics?: Pick<DailyMetricsRepository, "listRange">;
  sleep?: Pick<SleepRepository, "listRange">;
  body?: Pick<BodyRepository, "listReconciledRange">;
  weightObservations?: {
    listRange(startDate: string, endDate: string): Promise<DirectWeightObservation[]>;
  };
  trainingLoad?: Pick<AnalyticalTrainingLoadRepository, "listRange">;
  subjective?: Pick<SubjectiveRepository, "timeline">;
  activities?: {
    listDailyExposureRange(
      startDate: string,
      endDate: string,
      filters: RecoveryActivityExposureFilters,
    ): Promise<RecoveryDailyActivityExposure[]>;
  };
  nutrition?: Pick<FoodRepository, "dailyTotalsRange">;
}

export interface RecoveryTrainingSeriesFilters extends RecoveryActivityExposureFilters {}

function requiredSource<T>(source: T | undefined, stream: RecoveryTrainingStream): T {
  if (!source) throw new Error(`Missing repository source for requested ${stream} stream`);
  return source;
}

function shiftDate(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function dates(startDate: string, endDate: string): string[] {
  const result: string[] = [];
  for (let date = startDate; date <= endDate; date = shiftDate(date, 1)) result.push(date);
  return result;
}

function healthValue(value: number | null, row: HealthTrendRow | undefined) {
  return {
    value,
    status: value === null ? ("missing" as const) : ("observed" as const),
    value_kind: "provider_supplied" as const,
    source_providers: row?.source_providers ?? [],
    provenance_scope: "daily_row" as const,
  };
}

function restingHeartRateValue(value: number | null) {
  return {
    value,
    status: value === null ? ("missing" as const) : ("observed" as const),
    value_kind: "calculated_from_deduped_samples" as const,
    source_providers: [],
    provenance_scope: "deduped_resting_hr_series" as const,
  };
}

function rollingWeightForDate(
  date: string,
  rows: ReadonlyArray<{ date: string; weightKg: number | null }>,
) {
  const day = Date.parse(`${date}T00:00:00.000Z`);
  const values = (days: number) =>
    rows.filter(
      (row): row is { date: string; weightKg: number } =>
        row.weightKg !== null &&
        row.weightKg > 0 &&
        Date.parse(`${row.date}T00:00:00.000Z`) <= day &&
        Date.parse(`${row.date}T00:00:00.000Z`) > day - days * 86_400_000,
    );
  const seven = values(7);
  const twentyEight = values(28);
  const mean = (items: Array<{ weightKg: number }>) =>
    items.length === 0
      ? null
      : Math.round((items.reduce((sum, item) => sum + item.weightKg, 0) / items.length) * 1000) /
        1000;
  return {
    average_7d_kg: mean(seven),
    average_28d_kg: mean(twentyEight),
    observed_days_7d: seven.length,
    observed_days_28d: twentyEight.length,
  };
}

function mapSleep(row: ClickHouseSleepNight | undefined) {
  if (!row) return { status: "missing" as const, reason: "No sleep record for this date." };
  return {
    status: "observed" as const,
    started_at: row.started_at,
    ended_at: row.ended_at,
    duration_minutes: row.duration_minutes,
    efficiency_pct: row.efficiency_pct,
    stages_minutes: {
      deep: row.deep_minutes,
      light: row.light_minutes,
      rem: row.rem_minutes,
      awake: row.awake_minutes,
    },
    staging_available: row.staging_available,
    missing_fields: [
      ...(row.duration_minutes === null ? (["duration_minutes"] as const) : []),
      ...(row.efficiency_pct === null ? (["efficiency_pct"] as const) : []),
      ...(!row.staging_available ? (["stages_minutes"] as const) : []),
      ...(row.ended_at === null ? (["ended_at"] as const) : []),
    ],
    source_providers: row.source_providers,
    selected_session_id: row.selected_session_id,
    local_time_context: {
      timezone: row.timezone,
      start_utc_offset_minutes: row.start_utc_offset_minutes,
      end_utc_offset_minutes: row.end_utc_offset_minutes,
      source: row.local_time_source,
    },
  };
}

function durationEvidence(exposure: RecoveryDailyActivityExposure | undefined) {
  if (!exposure) {
    return {
      value_minutes: 0,
      status: "observed" as const,
      reason: null,
      supported_activities: 0,
      total_activities: 0,
      missing_end_activities: 0,
      invalid_interval_activities: 0,
    };
  }
  const unsupported = exposure.activity_count - exposure.supported_duration_count;
  return {
    value_minutes: exposure.duration_minutes,
    status:
      unsupported === 0
        ? ("observed" as const)
        : exposure.supported_duration_count > 0
          ? ("partial" as const)
          : ("unavailable" as const),
    reason:
      unsupported === 0
        ? null
        : `${unsupported} of ${exposure.activity_count} activities lacked a valid positive duration.`,
    supported_activities: exposure.supported_duration_count,
    total_activities: exposure.activity_count,
    missing_end_activities: exposure.missing_end_count,
    invalid_interval_activities: exposure.invalid_interval_count,
  };
}

/** Builds one analysis-date spine without interpreting associations as causal. */
export class RecoveryTrainingSeriesRepository {
  readonly #sources: RecoveryTrainingSeriesSources;
  readonly #timezone: string;

  constructor(sources: RecoveryTrainingSeriesSources, timezone: string) {
    this.#sources = sources;
    this.#timezone = timezone;
  }

  async listRange(
    startDate: string,
    endDate: string,
    requestedStreams: readonly RecoveryTrainingStream[],
    filters: RecoveryTrainingSeriesFilters = { providers: [], modalities: [] },
  ) {
    const streams = new Set(requestedStreams);
    const priorDate = shiftDate(startDate, -1);
    const bodyLookback = shiftDate(startDate, -27);
    const [
      healthRows,
      sleepRows,
      bodyRows,
      weightObservations,
      load,
      subjective,
      activityRows,
      nutritionRows,
    ] = await Promise.all([
      streams.has("health")
        ? requiredSource(this.#sources.dailyMetrics, "health").listRange(startDate, endDate)
        : [],
      streams.has("sleep")
        ? requiredSource(this.#sources.sleep, "sleep").listRange(startDate, endDate)
        : [],
      streams.has("body_weight")
        ? requiredSource(this.#sources.body, "body_weight").listReconciledRange(
            bodyLookback,
            endDate,
          )
        : [],
      streams.has("body_weight")
        ? requiredSource(this.#sources.weightObservations, "body_weight").listRange(
            startDate,
            endDate,
          )
        : [],
      streams.has("training_load")
        ? requiredSource(this.#sources.trainingLoad, "training_load").listRange(
            priorDate,
            endDate,
            filters,
            "source_context",
          )
        : null,
      streams.has("subjective")
        ? requiredSource(this.#sources.subjective, "subjective").timeline(startDate, endDate)
        : null,
      streams.has("activities")
        ? requiredSource(this.#sources.activities, "activities").listDailyExposureRange(
            startDate,
            endDate,
            filters,
          )
        : [],
      streams.has("nutrition")
        ? requiredSource(this.#sources.nutrition, "nutrition").dailyTotalsRange(startDate, endDate)
        : [],
    ]);

    const healthByDate = new Map(healthRows.map((row) => [row.date, row]));
    const sleepByDate = new Map(sleepRows.map((row) => [row.date, row]));
    const bodyByDate = new Map(bodyRows.map((row) => [row.date, row]));
    const loadByDate = new Map(load?.rows.map((row) => [row.date, row]) ?? []);
    const checkInByDate = new Map(subjective?.checkIns.map((row) => [row.date, row]) ?? []);
    const nutritionByDate = new Map(nutritionRows.map((row) => [row.date, row]));
    const activitiesByDate = new Map(activityRows.map((row) => [row.date, row]));

    return {
      range: { start_date: startDate, end_date: endDate, timezone: this.#timezone },
      requested_streams: [...streams],
      filters: { providers: [...filters.providers], modalities: [...filters.modalities] },
      interpretation: {
        date_alignment:
          "Rows use local calendar dates. previous_day_training_load is the immediately preceding calendar day, including across DST transitions.",
        causality:
          "The series exposes aligned observations for analysis and does not claim that correlations are causal.",
        filter_scope:
          "Provider and modality filters apply to activity exposure and every training-load channel; recovery, sleep, body, subjective, and nutrition observations are unfiltered.",
      },
      rows: dates(startDate, endDate).map((date) => {
        const row: Record<string, unknown> = { date };
        if (streams.has("health")) {
          const health = healthByDate.get(date);
          row.health = {
            hrv: healthValue(health?.hrv ?? null, health),
            resting_hr: restingHeartRateValue(health?.resting_hr ?? null),
            respiratory_rate: healthValue(health?.respiratory_rate_avg ?? null, health),
            steps: healthValue(health?.steps ?? null, health),
          };
        }
        if (streams.has("sleep")) row.sleep = mapSleep(sleepByDate.get(date));
        if (streams.has("body_weight")) {
          const body = bodyByDate.get(date);
          row.body_weight = {
            direct_value_kg: body?.weightKg ?? null,
            direct_status: body?.weightKg == null ? "missing" : "observed",
            direct_measurement_kind: body?.weightMeasurementKind ?? "unavailable",
            direct_source_provider: body?.sourceProviderByMetric.weightKg ?? null,
            nearby_evidence: selectNearbyWeight(date, weightObservations),
            rolling: rollingWeightForDate(date, bodyRows),
          };
        }
        if (streams.has("training_load")) {
          row.training_load = loadByDate.get(date)?.channels ?? null;
          row.previous_day_training_load = loadByDate.get(shiftDate(date, -1))?.channels ?? null;
        }
        if (streams.has("subjective")) {
          const checkIn = checkInByDate.get(date);
          row.subjective = {
            status: checkIn ? "observed" : "not_observed",
            fatigue: {
              value: null,
              status: "unavailable",
              reason: "The canonical subjective schema does not record daily fatigue.",
            },
            symptoms: checkIn?.symptoms ?? [],
            active_injuries:
              subjective?.injuries.filter(
                (injury) =>
                  injury.onset_date <= date &&
                  (injury.resolved_date === null || injury.resolved_date >= date),
              ) ?? [],
          };
        }
        if (streams.has("activities")) {
          const exposure = activitiesByDate.get(date);
          row.activity_exposure = exposure
            ? {
                activity_count: exposure.activity_count,
                duration: durationEvidence(exposure),
                canonical_types: exposure.canonical_types,
                modalities: exposure.modalities,
                source_providers: exposure.source_providers,
                source_activity_ids: exposure.source_activity_ids,
                source_activity_count: exposure.activity_count,
                source_activity_ids_truncated: exposure.source_activity_ids_truncated,
                date_attribution: {
                  authoritative_records: exposure.authoritative_date_count,
                  analysis_timezone_assumptions: exposure.assumed_date_count,
                },
              }
            : {
                activity_count: 0,
                duration: durationEvidence(undefined),
                canonical_types: [],
                modalities: [],
                source_providers: [],
                source_activity_ids: [],
                source_activity_count: 0,
                source_activity_ids_truncated: false,
                date_attribution: {
                  authoritative_records: 0,
                  analysis_timezone_assumptions: 0,
                },
              };
        }
        if (streams.has("nutrition")) {
          const nutrition = nutritionByDate.get(date);
          row.nutrition = nutrition
            ? {
                date: nutrition.date,
                total_calories: nutrition.calories,
                protein_g: nutrition.proteinGrams,
                carbs_g: nutrition.carbsGrams,
                fat_g: nutrition.fatGrams,
                fiber_g: nutrition.fiberGrams,
                meal_count: nutrition.mealCount,
                logging_completeness: nutrition.loggingCompleteness,
                logging_completeness_reason: nutrition.loggingCompletenessReason,
                resolution_status: nutrition.resolutionStatus,
                resolution_message: nutrition.resolutionMessage,
                source_provider:
                  nutrition.contributingProviders.length === 1
                    ? nutrition.contributingProviders[0]
                    : null,
                source_providers: nutrition.sourceProviders,
                contributing_providers: nutrition.contributingProviders,
                excluded_providers: nutrition.excludedProviders,
              }
            : null;
        }
        return row;
      }),
    };
  }
}
