import { describe, expect, it, vi } from "vitest";
import {
  RecoveryTrainingSeriesRepository,
  type RecoveryTrainingSeriesSources,
} from "./recovery-training-series-repository.ts";

function sources(
  overrides: Partial<RecoveryTrainingSeriesSources> = {},
): RecoveryTrainingSeriesSources {
  return {
    dailyMetrics: { listRange: vi.fn().mockResolvedValue([]) },
    sleep: { listRange: vi.fn().mockResolvedValue([]) },
    body: { listReconciledRange: vi.fn().mockResolvedValue([]) },
    weightObservations: { listRange: vi.fn().mockResolvedValue([]) },
    trainingLoad: { listRange: vi.fn().mockResolvedValue({ rows: [] }) },
    subjective: { timeline: vi.fn().mockResolvedValue({ checkIns: [], injuries: [] }) },
    activities: { listDailyExposureRange: vi.fn().mockResolvedValue([]) },
    nutrition: { dailyTotalsRange: vi.fn().mockResolvedValue([]) },
    ...overrides,
  };
}

describe("RecoveryTrainingSeriesRepository", () => {
  it("aligns selected observations on a dense date spine without changing missing values to zero", async () => {
    const input = sources({
      dailyMetrics: {
        listRange: vi.fn().mockResolvedValue([
          {
            date: "2026-03-08",
            user_id: "user-1",
            hrv: 52,
            resting_hr: 48,
            respiratory_rate_avg: 14,
            steps: 8_000,
            spo2_avg: null,
            skin_temp_c: null,
            distance_km: null,
            flights_climbed: null,
            exercise_minutes: null,
            stand_hours: null,
            walking_speed: null,
            source_providers: ["apple_health"],
          },
        ]),
      },
      sleep: {
        listRange: vi.fn().mockResolvedValue([
          {
            date: "2026-03-09",
            duration_minutes: 450,
            efficiency_pct: 91,
            deep_minutes: 80,
            light_minutes: 250,
            rem_minutes: 90,
            awake_minutes: 30,
            staging_available: true,
            source_providers: ["whoop"],
            selected_session_id: "sleep-1",
            timezone: "America/Los_Angeles",
            start_utc_offset_minutes: -480,
            end_utc_offset_minutes: -420,
            local_time_source: "provider_timezone",
            started_at: "2026-03-09T06:30:00.000Z",
            ended_at: "2026-03-09T14:00:00.000Z",
          },
        ]),
      },
    });

    const result = await new RecoveryTrainingSeriesRepository(
      input,
      "America/Los_Angeles",
    ).listRange("2026-03-08", "2026-03-09", ["health", "sleep"]);

    expect(result).toMatchSnapshot();
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      date: "2026-03-08",
      health: {
        hrv: { value: 52, status: "observed" },
        resting_hr: {
          value: 48,
          status: "observed",
          value_kind: "calculated_from_deduped_samples",
          source_providers: [],
        },
      },
      sleep: { status: "missing" },
    });
    expect(result.rows[1]).toMatchObject({
      date: "2026-03-09",
      health: { hrv: { value: null, status: "missing" } },
      sleep: {
        status: "observed",
        duration_minutes: 450,
        started_at: "2026-03-09T06:30:00.000Z",
        ended_at: "2026-03-09T14:00:00.000Z",
        local_time_context: { start_utc_offset_minutes: -480, end_utc_offset_minutes: -420 },
      },
    });
  });

  it("aligns the prior calendar day's load across a DST boundary", async () => {
    const trainingLoad = {
      listRange: vi.fn().mockResolvedValue({
        rows: [
          { date: "2026-03-08", channels: { cycling_power_tss: { daily_value: 80 } } },
          { date: "2026-03-09", channels: { cycling_power_tss: { daily_value: 0 } } },
        ],
      }),
    };
    const result = await new RecoveryTrainingSeriesRepository(
      sources({ trainingLoad }),
      "America/Los_Angeles",
    ).listRange("2026-03-09", "2026-03-09", ["training_load"]);

    expect(result).toMatchSnapshot();
    expect(trainingLoad.listRange).toHaveBeenCalledWith(
      "2026-03-08",
      "2026-03-09",
      {
        providers: [],
        modalities: [],
      },
      "source_context",
    );
    expect(result.rows[0]).toMatchObject({
      date: "2026-03-09",
      training_load: { cycling_power_tss: { daily_value: 0 } },
      previous_day_training_load: { cycling_power_tss: { daily_value: 80 } },
    });
  });

  it("queries only requested streams", async () => {
    const input = sources();
    await new RecoveryTrainingSeriesRepository(input, "UTC").listRange("2026-06-01", "2026-06-02", [
      "subjective",
    ]);

    expect(input.subjective.timeline).toHaveBeenCalledOnce();
    expect(input.dailyMetrics.listRange).not.toHaveBeenCalled();
    expect(input.sleep.listRange).not.toHaveBeenCalled();
    expect(input.trainingLoad.listRange).not.toHaveBeenCalled();
    expect(input.nutrition.dailyTotalsRange).not.toHaveBeenCalled();
  });

  it("returns nearby direct-weight evidence and rolling context on dates without a measurement", async () => {
    const input = sources({
      body: {
        listReconciledRange: vi.fn().mockResolvedValue([
          {
            date: "2026-06-01",
            weightKg: 70,
            weightMeasurementKind: "direct",
            sourceProviderByMetric: { weightKg: "withings" },
          },
        ]),
      },
      weightObservations: {
        listRange: vi.fn().mockResolvedValue([
          {
            date: "2026-06-01",
            recordedAt: "2026-06-01T08:00:00.000Z",
            valueKg: 70,
            observationType: "body_weight",
            measurementKind: "direct",
            provider: "withings",
            sourceRecordId: "weight-1",
          },
        ]),
      },
    });

    const result = await new RecoveryTrainingSeriesRepository(input, "UTC").listRange(
      "2026-06-02",
      "2026-06-02",
      ["body_weight"],
    );

    expect(result).toMatchSnapshot();
    expect(result.rows[0]?.body_weight).toMatchObject({
      direct_status: "missing",
      direct_value_kg: null,
      nearby_evidence: { value_kg: 70, kind: "nearest", distance_days: 1 },
      rolling: { average_7d_kg: 70, observed_days_7d: 1 },
    });
  });

  it("bounds rolling body-weight windows and excludes future, null, and non-positive values", async () => {
    const bodyRows = [
      { date: "2026-06-16", weightKg: 100 },
      { date: "2026-06-15", weightKg: 70 },
      { date: "2026-06-14", weightKg: 72 },
      { date: "2026-06-08", weightKg: 69 },
      { date: "2026-06-01", weightKg: 68 },
      { date: "2026-06-13", weightKg: 0 },
      { date: "2026-06-12", weightKg: null },
    ].map((row) => ({
      ...row,
      weightMeasurementKind: "direct" as const,
      sourceProviderByMetric: { weightKg: "withings" },
    }));
    const result = await new RecoveryTrainingSeriesRepository(
      sources({
        body: { listReconciledRange: vi.fn().mockResolvedValue(bodyRows) },
      }),
      "UTC",
    ).listRange("2026-06-15", "2026-06-15", ["body_weight"]);

    expect(result).toMatchSnapshot();
    expect(result.rows[0]?.body_weight.rolling).toEqual({
      average_7d_kg: 71,
      average_28d_kg: 69.75,
      observed_days_7d: 2,
      observed_days_28d: 4,
    });
  });

  it("lists every missing sleep field without substituting zeros", async () => {
    const result = await new RecoveryTrainingSeriesRepository(
      sources({
        sleep: {
          listRange: vi.fn().mockResolvedValue([
            {
              date: "2026-06-15",
              duration_minutes: null,
              efficiency_pct: null,
              deep_minutes: null,
              light_minutes: null,
              rem_minutes: null,
              awake_minutes: null,
              staging_available: false,
              source_providers: ["whoop"],
              selected_session_id: "sleep-incomplete",
              timezone: null,
              start_utc_offset_minutes: null,
              end_utc_offset_minutes: null,
              local_time_source: "unknown",
              started_at: "2026-06-15T07:00:00.000Z",
              ended_at: null,
            },
          ]),
        },
      }),
      "UTC",
    ).listRange("2026-06-15", "2026-06-15", ["sleep"]);

    expect(result).toMatchSnapshot();
    expect(result.rows[0]?.sleep).toMatchObject({
      status: "observed",
      duration_minutes: null,
      missing_fields: ["duration_minutes", "efficiency_pct", "stages_minutes", "ended_at"],
    });
  });

  it("returns an explicit zero exposure when no matching activities exist", async () => {
    const result = await new RecoveryTrainingSeriesRepository(sources(), "UTC").listRange(
      "2026-06-15",
      "2026-06-15",
      ["activities"],
    );

    expect(result).toMatchSnapshot();
    expect(result.rows[0]?.activity_exposure).toMatchObject({
      activity_count: 0,
      source_activity_count: 0,
      source_activity_ids: [],
      duration: { value_minutes: 0, status: "observed", total_activities: 0 },
    });
  });

  it("passes provider and modality filters to compact activity exposure", async () => {
    const activities = {
      listDailyExposureRange: vi.fn().mockResolvedValue([
        {
          date: "2026-06-01",
          activity_count: 1,
          duration_minutes: 60,
          supported_duration_count: 1,
          missing_end_count: 0,
          invalid_interval_count: 0,
          canonical_types: ["cycling"],
          modalities: ["indoor"],
          source_providers: ["peloton"],
          source_activity_ids: ["activity-1"],
          source_activity_ids_truncated: false,
          authoritative_date_count: 1,
          assumed_date_count: 0,
        },
      ]),
    };
    const filters = { providers: ["peloton"], modalities: ["indoor"] };

    const result = await new RecoveryTrainingSeriesRepository(
      sources({ activities }),
      "UTC",
    ).listRange("2026-06-01", "2026-06-01", ["activities"], filters);

    expect(result).toMatchSnapshot();
    expect(activities.listDailyExposureRange).toHaveBeenCalledWith(
      "2026-06-01",
      "2026-06-01",
      filters,
    );
    expect(result.rows[0]?.activity_exposure).toMatchObject({
      activity_count: 1,
      duration: { value_minutes: 60, status: "observed", supported_activities: 1 },
      source_activity_ids: ["activity-1"],
      source_activity_ids_truncated: false,
      date_attribution: { authoritative_records: 1, analysis_timezone_assumptions: 0 },
    });
  });
});
