import { describe, expect, it, vi } from "vitest";
import { CyclingTrainingMetricsRepository } from "./cycling-training-metrics-repository.ts";

const userId = "00000000-0000-4000-8000-000000000001";
const activityId = "00000000-0000-4000-8000-000000000010";
const memberActivityId = "00000000-0000-4000-8000-000000000011";

function settingsRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "00000000-0000-4000-8000-000000000100",
    user_id: userId,
    sport: "cycling",
    ftp: 250,
    threshold_hr: 175,
    threshold_pace_per_km: null,
    power_zone_pcts: [0.55, 0.75, 0.9, 1.05, 1.2, 1.5],
    hr_zone_pcts: [0.6, 0.7, 0.8, 0.9],
    pace_zone_pcts: null,
    effective_from: "2026-01-01",
    notes: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function activityRow(overrides: Record<string, unknown> = {}) {
  return {
    activity_id: activityId,
    activity_date: "2026-06-15",
    started_at: "2026-06-15T15:00:00.000Z",
    ended_at: "2026-06-15T16:00:00.000Z",
    elapsed_seconds: 3600,
    modality: "indoor",
    activity_name: "Power Zone Endurance",
    provider_id: "peloton",
    source_providers: ["apple_health", "peloton"],
    member_activity_ids: [activityId, memberActivityId],
    activity_timezone: "America/New_York",
    local_time_source: "provider_timezone",
    aggregate_average_power: 200,
    aggregate_normalized_power: 205,
    aggregate_average_heart_rate: 140,
    aggregate_max_heart_rate: 155,
    ...overrides,
  };
}

function samples() {
  return Array.from({ length: 720 }, (_, index) => ({
    activity_id: activityId,
    elapsed_seconds: index * 5,
    power: 200,
    heart_rate: 140,
    cadence: 90,
    source_providers: ["peloton"],
    source_devices: ["Peloton Bike"],
    power_measurement_kinds: ["direct"],
  }));
}

describe("CyclingTrainingMetricsRepository", () => {
  it("computes a paginated activity from canonical streams and historical settings", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([settingsRow()])
      .mockResolvedValueOnce([
        {
          member_activity_id: memberActivityId,
          interval_index: 1,
          label: "20 minute effort",
          interval_type: "work",
          started_at: "2026-06-15T15:10:00.000Z",
          ended_at: "2026-06-15T15:30:00.000Z",
        },
        {
          member_activity_id: activityId,
          interval_index: 1,
          label: "20 minute effort",
          interval_type: "work",
          started_at: "2026-06-15T15:10:00.000Z",
          ended_at: "2026-06-15T15:30:00.000Z",
        },
      ]);
    const query = vi.fn(async (_schema, queryText: string) => {
      if (queryText.includes("cycling-training-metrics:activities")) return [activityRow()];
      if (queryText.includes("cycling-training-metrics:samples")) return samples();
      if (queryText.includes("cycling-training-metrics:power-curve")) {
        return [
          {
            activity_id: activityId,
            duration_seconds: 300,
            best_power: 200,
            start_offset_seconds: 0,
            observed_samples: 61,
            coverage_pct: 100,
            largest_gap_seconds: 5,
            median_sample_interval_seconds: 5,
            power_measurement_kind: "direct",
          },
        ];
      }
      return [];
    });
    const repository = new CyclingTrainingMetricsRepository(
      { execute },
      { query },
      userId,
      "America/Los_Angeles",
    );

    const result = await repository.listRange({
      startDate: "2026-06-01",
      endDate: "2026-06-30",
      modalities: ["indoor"],
      providers: ["peloton"],
      durationsSeconds: [300],
      cursor: null,
      limit: 10,
    });

    expect(result).toMatchSnapshot();
    expect(result.range).toEqual({
      start_date: "2026-06-01",
      end_date: "2026-06-30",
      timezone: "America/Los_Angeles",
    });
    expect(result.activities).toHaveLength(1);
    expect(result.activities[0]).toMatchObject({
      activity_id: activityId,
      member_activity_ids: [activityId, memberActivityId],
      source_providers: ["apple_health", "peloton"],
      source_devices: ["Peloton Bike"],
      duration_seconds: 3600,
      thresholds: {
        ftp: {
          value: 250,
          effective_from: "2026-01-01",
          source_record_id: "00000000-0000-4000-8000-000000000100",
          kind: "configured",
        },
      },
      metrics: {
        value_kind: "calculated_from_samples",
        power: {
          average_watts: 200,
          normalized_watts: 200,
          intensity_factor: 0.8,
          training_stress_score: 64,
          work_kilojoules: 720,
        },
        coverage: { power: { observed_samples: 720, coverage_pct: 100 } },
        interval_source: "recorded",
        intervals: [
          expect.objectContaining({
            type: "work",
            source: "recorded",
            start_offset_seconds: 600,
            end_offset_seconds: 1800,
            source_member_activity_ids: [activityId, memberActivityId],
          }),
        ],
      },
      best_powers: [
        expect.objectContaining({
          duration_seconds: 300,
          watts: 200,
          start_offset_seconds: 0,
          power_kind: "direct",
        }),
      ],
      provenance: {
        duplicate_merged: true,
        activity_timezone: "America/New_York",
        timezone_source: "provider_timezone",
        timezone_assumption_required: false,
      },
    });
    expect(result.next_cursor).toBeNull();

    const activityCall = query.mock.calls.find((call) =>
      String(call[1]).includes("cycling-training-metrics:activities"),
    );
    expect(activityCall?.[1]).toContain("FROM analytics.cycling_activity AS cycling FINAL");
    expect(activityCall?.[1]).toContain(
      "INNER JOIN analytics.deduped_activities AS activity FINAL",
    );
    expect(activityCall?.[1]).toContain("hasAny(activity.source_providers");
    expect(activityCall?.[2]).toMatchObject({
      startDate: "2026-06-01",
      endDate: "2026-06-30",
      modalities: ["indoor"],
      providers: ["peloton"],
      pageLimit: 11,
    });
    const sampleCall = query.mock.calls.find((call) =>
      String(call[1]).includes("cycling-training-metrics:samples"),
    );
    expect(sampleCall?.[1]).toContain("analytics.activity_sensor_sample AS sensor FINAL");
    expect(sampleCall?.[2]).toMatchObject({ activityIds: [activityId] });
  });

  it("uses the setting effective on each activity date and explains missing FTP", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([
        settingsRow({
          id: "00000000-0000-4000-8000-000000000101",
          effective_from: "2026-06-20",
          ftp: 275,
        }),
        settingsRow(),
      ])
      .mockResolvedValueOnce([]);
    const noFtpActivityId = "00000000-0000-4000-8000-000000000012";
    const query = vi.fn(async (_schema, queryText: string) => {
      if (queryText.includes("cycling-training-metrics:activities")) {
        return [
          activityRow({
            activity_id: noFtpActivityId,
            activity_date: "2025-12-20",
            started_at: "2025-12-20T15:00:00.000Z",
            ended_at: "2025-12-20T15:05:00.000Z",
            elapsed_seconds: 300,
            member_activity_ids: [noFtpActivityId],
          }),
        ];
      }
      if (queryText.includes("cycling-training-metrics:samples")) {
        return Array.from({ length: 300 }, (_, elapsedSeconds) => ({
          activity_id: noFtpActivityId,
          elapsed_seconds: elapsedSeconds,
          power: 200,
          heart_rate: null,
          cadence: null,
          source_providers: ["wahoo"],
          source_devices: ["KICKR"],
          power_measurement_kinds: ["direct"],
        }));
      }
      return [];
    });
    const repository = new CyclingTrainingMetricsRepository({ execute }, { query }, userId, "UTC");

    const result = await repository.listRange({
      startDate: "2025-12-01",
      endDate: "2025-12-31",
      modalities: [],
      providers: [],
      durationsSeconds: [],
      cursor: null,
      limit: 10,
    });

    expect(result).toMatchSnapshot();
    expect(result.activities[0]?.thresholds.ftp).toBeNull();
    expect(result.activities[0]?.metrics.power.intensity_factor).toBeNull();
    expect(result.activities[0]?.metrics.unavailable_reasons).toContainEqual({
      metric: "intensity_factor",
      reason: "no valid FTP was effective for this activity",
    });
  });

  it("returns a stable cursor and never double-counts the lookahead activity", async () => {
    const execute = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const query = vi.fn(async (_schema, queryText: string) => {
      if (queryText.includes("cycling-training-metrics:activities")) {
        return [
          activityRow(),
          activityRow({
            activity_id: "00000000-0000-4000-8000-000000000020",
            member_activity_ids: ["00000000-0000-4000-8000-000000000020"],
            started_at: "2026-06-14T15:00:00.000Z",
          }),
        ];
      }
      return [];
    });
    const repository = new CyclingTrainingMetricsRepository({ execute }, { query }, userId, "UTC");
    const result = await repository.listRange({
      startDate: "2026-06-01",
      endDate: "2026-06-30",
      modalities: [],
      providers: [],
      durationsSeconds: [],
      cursor: null,
      limit: 1,
    });

    expect(result).toMatchSnapshot();
    expect(result.activities.map((activity) => activity.activity_id)).toEqual([activityId]);
    expect(result.next_cursor).toEqual(expect.any(String));
  });
});
