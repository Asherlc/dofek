import { describe, expect, it, vi } from "vitest";
import { CyclingPerformanceRepository } from "./cycling-performance-repository.ts";
import type { CyclingActivityPowerMetrics } from "./cycling-threshold-repository.ts";
import { CyclingThresholdRepository } from "./cycling-threshold-repository.ts";

function powerMetrics(
  activityId: string,
  ftp: number | null,
  np: number | null,
): CyclingActivityPowerMetrics {
  return {
    activity_id: activityId,
    started_at: "2026-08-30T10:00:00.000Z",
    ended_at: "2026-08-30T11:00:00.000Z",
    activity_date: "2026-08-30",
    canonical_type: "cycling",
    normalized_power: np,
    power_sample_count: np === null ? 0 : 3600,
    ftp,
    intensity_factor: ftp === null || np === null ? null : np / ftp,
    power_tss: null,
    threshold:
      ftp === null
        ? null
        : {
            value: ftp,
            unit: "watt",
            effective_from: "2026-01-01",
            source_record_id: "00000000-0000-4000-8000-000000000001",
            kind: "configured",
          },
  };
}

describe("CyclingPerformanceRepository", () => {
  it("withholds configured FTP attribution for a ride with power but no dated setting", async () => {
    vi.spyOn(CyclingThresholdRepository.prototype, "getForActivities").mockResolvedValue(new Map());
    const query = vi
      .fn()
      .mockResolvedValueOnce([
        {
          activity_id: "ride",
          activity_date: "2026-08-30",
          activity_name: "Unsupported ride",
          modality: "indoor",
          elapsed_seconds: 3600,
          average_power: 200,
          elevation_gain_meters: null,
        },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const result = await new CyclingPerformanceRepository(
      { execute: vi.fn() },
      { query },
      "user",
      "UTC",
    ).listRange("2026-08-01", "2026-09-01");
    expect(result.activities[0]).toMatchObject({
      normalized_power_watts: null,
      ftp_watts: null,
      ftp_source: null,
      intensity_factor: null,
    });
  });
  it("returns per-ride and rolling-90-day load-normalized power without look-ahead", async () => {
    const getForActivities = vi
      .spyOn(CyclingThresholdRepository.prototype, "getForActivities")
      .mockResolvedValue(
        new Map([
          ["older-ride", powerMetrics("older-ride", 210, 190)],
          ["outdoor-ride", powerMetrics("outdoor-ride", 245, 220)],
          ["ride-without-power", powerMetrics("ride-without-power", 245, null)],
        ]),
      );
    const query = vi
      .fn()
      .mockResolvedValueOnce([
        {
          activity_id: "older-ride",
          activity_date: "2026-06-10",
          activity_name: "Older ride",
          modality: "outdoor",
          elapsed_seconds: 3600,
          average_power: 160,
          elevation_gain_meters: 100,
        },
        {
          activity_id: "outdoor-ride",
          activity_date: "2026-08-30",
          activity_name: "Hilly ride",
          modality: "outdoor",
          elapsed_seconds: 3720,
          average_power: 180,
          elevation_gain_meters: 736,
        },
        {
          activity_id: "ride-without-power",
          activity_date: "2026-08-31",
          activity_name: "Recovery ride",
          modality: "outdoor",
          elapsed_seconds: 1800,
          average_power: null,
          elevation_gain_meters: 310.4,
        },
      ])
      .mockResolvedValueOnce([
        {
          activity_id: "older-ride",
          activity_date: "2026-06-10",
          duration_seconds: 1200,
          best_power: 200,
        },
        {
          activity_id: "outdoor-ride",
          activity_date: "2026-08-30",
          duration_seconds: 5,
          best_power: 900,
        },
        {
          activity_id: "outdoor-ride",
          activity_date: "2026-08-30",
          duration_seconds: 60,
          best_power: 500,
        },
        {
          activity_id: "outdoor-ride",
          activity_date: "2026-08-30",
          duration_seconds: 300,
          best_power: 300,
        },
        {
          activity_id: "outdoor-ride",
          activity_date: "2026-08-30",
          duration_seconds: 1200,
          best_power: 250,
        },
      ])
      .mockResolvedValueOnce([
        {
          modality: "indoor",
          first_observed: "2023-01-02",
          last_observed: "2026-09-01",
          activities_with_power: 174,
          activities_total: 184,
          source_providers: ["peloton"],
        },
        {
          modality: "outdoor",
          first_observed: null,
          last_observed: null,
          activities_with_power: 0,
          activities_total: 224,
          source_providers: [],
        },
      ]);
    const repository = new CyclingPerformanceRepository(
      { execute: vi.fn() },
      { query },
      "00000000-0000-4000-8000-000000000001",
      "America/Los_Angeles",
    );

    const actual = await repository.listRange("2026-08-29", "2026-09-01");
    expect(getForActivities).toHaveBeenCalledWith([
      "older-ride",
      "outdoor-ride",
      "ride-without-power",
    ]);
    expect(actual, JSON.stringify(actual)).toEqual({
      activities: [
        {
          activity_id: "outdoor-ride",
          date: "2026-08-30",
          name: "Hilly ride",
          modality: "outdoor",
          duration_minutes: 62,
          average_power_watts: 180,
          normalized_power_watts: 220,
          ftp_watts: 245,
          ftp_source: expect.objectContaining({ value: 245, kind: "configured" }),
          intensity_factor: 0.898,
          elevation_gain_m: 736,
          best_efforts_watts: { "5s": 900, "1m": 500, "5m": 300, "20m": 250 },
        },
        {
          activity_id: "ride-without-power",
          date: "2026-08-31",
          name: "Recovery ride",
          modality: "outdoor",
          duration_minutes: 30,
          average_power_watts: null,
          normalized_power_watts: null,
          ftp_watts: 245,
          ftp_source: expect.objectContaining({ value: 245, kind: "configured" }),
          intensity_factor: null,
          elevation_gain_m: 310.4,
          best_efforts_watts: { "5s": null, "1m": null, "5m": null, "20m": null },
        },
      ],
      rolling_90_day_best: {
        "5s": { activity_id: "outdoor-ride", date: "2026-08-30", watts: 900 },
        "1m": { activity_id: "outdoor-ride", date: "2026-08-30", watts: 500 },
        "5m": { activity_id: "outdoor-ride", date: "2026-08-30", watts: 300 },
        "20m": { activity_id: "outdoor-ride", date: "2026-08-30", watts: 250 },
      },
      summary: {
        power_coverage: { activities_with_power: 1, activities_total: 2, pct: 50 },
        power_availability_by_modality: {
          indoor: {
            first_observed: "2023-01-02",
            last_observed: "2026-09-01",
            activities_with_power: 174,
            activities_total: 184,
            pct: 94.6,
            source_providers: ["peloton"],
          },
          outdoor: {
            first_observed: null,
            last_observed: null,
            activities_with_power: 0,
            activities_total: 224,
            pct: 0,
            source_providers: [],
          },
          unknown: {
            first_observed: null,
            last_observed: null,
            activities_with_power: 0,
            activities_total: 0,
            pct: 0,
            source_providers: [],
          },
        },
        elevation_gain: {
          total_elevation_gain_m: 1046.4,
          avg_elevation_gain_m: 523.2,
          coverage: { activities_with_elevation: 2, activities_total: 2, pct: 100 },
        },
      },
    });
    const availabilityCall = query.mock.calls[2];
    expect(availabilityCall?.[1]).toContain(
      "modality IN ('outdoor', 'road', 'mountain', 'gravel', 'electric', 'cyclocross', 'track', 'bmx')",
    );
    expect(availabilityCall?.[1]).toContain(
      "toDate({startDate:String}) AND toDate({endDate:String})",
    );

    expect(query.mock.calls[0]?.[1]).toContain("FROM analytics.cycling_activity AS ride FINAL");
    expect(query.mock.calls[1]?.[1]).toContain("FROM analytics.activity_power_curve FINAL");
    expect(query.mock.calls[2]?.[1]).toContain("FROM analytics.cycling_activity AS ride FINAL");
    expect(query.mock.calls[2]?.[1]).toContain("'road', 'mountain'");
    expect(query.mock.calls[0]?.[2]).toMatchObject({
      lookbackStartDate: "2026-06-04",
      startDate: "2026-08-29",
      endDate: "2026-09-01",
    });
  });
});
