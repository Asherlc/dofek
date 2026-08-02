import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChartRange } from "../lib/chart-range.ts";
import { makeMockSensorStore } from "../lib/test-helpers.ts";
import { CyclingAnalyticsRepository } from "./cycling-analytics-repository.ts";

vi.mock("dofek/personalization/storage", () => ({
  loadPersonalizedParams: vi.fn().mockResolvedValue(null),
}));

function cyclingActivityRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    started_at: "2026-07-10T10:00:00.000Z",
    ended_at: "2026-07-10T11:00:00.000Z",
    activity_type: "cycling",
    activity_name: "Steady Ride",
    provider_id: "wahoo",
    source_providers: ["wahoo"],
    distance_meters: 40000,
    date: "2026-07-10",
    normalized_power: 220,
    average_power: 200,
    estimated_ftp: 300,
    elevation_gain_meters: null,
    elapsed_seconds: 3600,
    max_hr: null,
    avg_power_z2: null,
    avg_hr_z2: null,
    efficiency_factor: null,
    z2_samples: null,
    ...overrides,
  };
}

function performanceActivityRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    date: "2026-07-10",
    duration_min: 60,
    avg_hr: 150,
    max_hr: 180,
    global_max_hr: 190,
    resting_hr: 55,
    avg_power: 250,
    power_samples: 3600,
    hr_samples: 3600,
    normalized_power: 280,
    activity_name: "Intervals",
    latest_weight_kg: 80,
    ...overrides,
  };
}

function powerComparisonRow(
  durationSeconds: number,
  recentBestPower: number | null,
  seasonBestPower: number | null,
  overrides: Record<string, unknown> = {},
) {
  return {
    duration_seconds: durationSeconds,
    recent_best_power: recentBestPower,
    recent_activity_date: "2026-07-10",
    season_best_power: seasonBestPower,
    season_activity_date: "2026-03-15",
    ...overrides,
  };
}

describe("CyclingAnalyticsRepository", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-14T12:00:00.000Z"));
  });

  it("loads the complete performance contract with exactly two ClickHouse statements", async () => {
    const sensorStore = makeMockSensorStore();
    vi.mocked(sensorStore.query)
      .mockResolvedValueOnce([
        {
          duration_seconds: 300,
          recent_best_power: 400,
          recent_activity_date: "2026-07-10",
          season_best_power: 500,
          season_activity_date: "2026-03-15",
        },
      ])
      .mockResolvedValueOnce([
        {
          id: "11111111-1111-4111-8111-111111111111",
          date: "2026-07-10",
          duration_min: 60,
          avg_hr: 150,
          max_hr: 180,
          global_max_hr: 190,
          resting_hr: 55,
          avg_power: 250,
          power_samples: 3600,
          hr_samples: 3600,
          normalized_power: 280,
          activity_name: "Intervals",
          latest_weight_kg: 80,
        },
      ]);

    const repository = new CyclingAnalyticsRepository(
      { execute: vi.fn().mockResolvedValue([]) },
      "11111111-1111-4111-8111-111111111111",
      "UTC",
      sensorStore,
    );

    const result = await repository.getPerformance(ChartRange.fromDays(90));

    expect(sensorStore.query).toHaveBeenCalledTimes(2);
    expect(result.powerCurve.recent.points).toEqual([
      {
        durationSeconds: 300,
        label: "5min",
        bestPower: 400,
        activityDate: "2026-07-10",
        sourceActivityId: null,
        sourceActivityName: null,
      },
    ]);
    expect(result.powerCurve.season.points[0]?.bestPower).toBe(500);
    expect(result.powerSummary.weightKg).toBe(80);
    expect(result.powerSummary.recent.maximalAerobicPower).toBe(400);
    expect(result.powerSummary.recent.vo2Max).toBe(61);
    expect(result.eftpTrend.trend).toEqual([
      { date: "2026-07-10", eftp: 266, activityName: "Intervals" },
    ]);
    expect(result.eftpTrend.currentEftp).toBe(266);
    expect(vi.mocked(sensorStore.query).mock.calls[1]?.[1]).toMatch(
      /FROM analytics\.daily_body_measurement FINAL[\s\S]*AND is_deleted = 0/,
    );
    expect(sensorStore.query).toHaveBeenNthCalledWith(
      1,
      expect.anything(),
      expect.stringContaining("analytics.activity_power_curve"),
      expect.objectContaining({ userId: "11111111-1111-4111-8111-111111111111", days: 90 }),
      { priority: "dashboard" },
    );
    expect(sensorStore.query).toHaveBeenNthCalledWith(
      2,
      expect.anything(),
      expect.stringContaining("analytics.daily_cycling"),
      expect.objectContaining({ userId: "11111111-1111-4111-8111-111111111111", timezone: "UTC" }),
      { priority: "dashboard" },
    );
  });

  it("builds critical-power summaries and omits incomplete curve points", async () => {
    const sensorStore = makeMockSensorStore();
    vi.mocked(sensorStore.query)
      .mockResolvedValueOnce([
        powerComparisonRow(5, 1000, 1100),
        powerComparisonRow(15, 800, null, { recent_activity_date: null }),
        powerComparisonRow(60, 700, 750),
        powerComparisonRow(120, 550, 570),
        powerComparisonRow(300, 400, 420),
        powerComparisonRow(600, 350, 370),
        powerComparisonRow(1200, 325, 340),
      ])
      .mockResolvedValueOnce([performanceActivityRow()]);
    const repository = new CyclingAnalyticsRepository(
      { execute: vi.fn().mockResolvedValue([]) },
      "11111111-1111-4111-8111-111111111111",
      "UTC",
      sensorStore,
    );

    const result = await repository.getPerformance(ChartRange.fromDays(90));

    expect(result.powerCurve.recent.points.map((point) => point.durationSeconds)).toEqual([
      5, 60, 120, 300, 600, 1200,
    ]);
    expect(result.powerCurve.recent.model).toEqual({ cp: 300, wPrime: 30000, r2: 1 });
    expect(result.powerCurve.season.model).toEqual({ cp: 320, wPrime: 30000, r2: 1 });
    expect(result.powerSummary.recent).toEqual({
      efforts: [
        { durationSeconds: 5, watts: 1000, wattsPerKg: 12.5 },
        { durationSeconds: 60, watts: 700, wattsPerKg: 8.75 },
        { durationSeconds: 300, watts: 400, wattsPerKg: 5 },
        { durationSeconds: 1200, watts: 325, wattsPerKg: 4.06 },
      ],
      maximalAerobicPower: 400,
      vo2Max: 61,
      timeToExhaustionSeconds: 300,
    });
    expect(result.eftpTrend.currentEftp).toBe(300);
  });

  it("leaves weight-derived summary metrics empty for a zero body weight", async () => {
    const sensorStore = makeMockSensorStore();
    vi.mocked(sensorStore.query)
      .mockResolvedValueOnce([powerComparisonRow(300, 400, 500)])
      .mockResolvedValueOnce([performanceActivityRow({ latest_weight_kg: 0 })]);
    const repository = new CyclingAnalyticsRepository(
      { execute: vi.fn().mockResolvedValue([]) },
      "11111111-1111-4111-8111-111111111111",
      "UTC",
      sensorStore,
    );

    const result = await repository.getPerformance(ChartRange.fromDays(90));

    expect(result.powerSummary.weightKg).toBe(0);
    expect(result.powerSummary.recent).toMatchObject({
      efforts: [{ durationSeconds: 300, watts: 400, wattsPerKg: null }],
      maximalAerobicPower: 400,
      vo2Max: null,
      timeToExhaustionSeconds: null,
    });
  });

  it("filters estimated threshold trend rows to the selected date window", async () => {
    const sensorStore = makeMockSensorStore();
    vi.mocked(sensorStore.query)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        performanceActivityRow({ date: "2026-04-15", normalized_power: 500 }),
        performanceActivityRow({
          id: "22222222-2222-4222-8222-222222222222",
          date: "2026-04-16",
          normalized_power: 300,
          activity_name: null,
        }),
        performanceActivityRow({
          id: "33333333-3333-4333-8333-333333333333",
          date: "2026-07-10",
          normalized_power: null,
        }),
      ]);
    const repository = new CyclingAnalyticsRepository(
      { execute: vi.fn().mockResolvedValue([]) },
      "11111111-1111-4111-8111-111111111111",
      "UTC",
      sensorStore,
    );

    const result = await repository.getPerformance(ChartRange.fromDays(90));

    expect(result.eftpTrend).toMatchObject({
      trend: [{ date: "2026-04-16", eftp: 285, activityName: null }],
      currentEftp: 285,
      model: null,
    });
  });

  it("returns estimate methods, confidence, and source workouts", async () => {
    const sensorStore = makeMockSensorStore();
    vi.mocked(sensorStore.query)
      .mockResolvedValueOnce([
        powerComparisonRow(120, 425, 450, {
          recent_source_activity_id: "11111111-1111-4111-8111-111111111111",
          recent_source_activity_name: "Threshold Intervals",
          season_source_activity_id: "22222222-2222-4222-8222-222222222222",
          season_source_activity_name: "Season Opener",
        }),
        powerComparisonRow(180, 380, 410, {
          recent_source_activity_id: "11111111-1111-4111-8111-111111111111",
          recent_source_activity_name: "Threshold Intervals",
          season_source_activity_id: "22222222-2222-4222-8222-222222222222",
          season_source_activity_name: "Season Opener",
        }),
        powerComparisonRow(300, 350, 375, {
          recent_source_activity_id: "33333333-3333-4333-8333-333333333333",
          recent_source_activity_name: "Five-Minute Test",
          season_source_activity_id: "22222222-2222-4222-8222-222222222222",
          season_source_activity_name: "Season Opener",
        }),
        powerComparisonRow(420, 330, 355, {
          recent_source_activity_id: "44444444-4444-4444-8444-444444444444",
          recent_source_activity_name: "Long Intervals",
          season_source_activity_id: "22222222-2222-4222-8222-222222222222",
          season_source_activity_name: "Season Opener",
        }),
        powerComparisonRow(600, 315, 340, {
          recent_source_activity_id: "44444444-4444-4444-8444-444444444444",
          recent_source_activity_name: "Long Intervals",
          season_source_activity_id: "22222222-2222-4222-8222-222222222222",
          season_source_activity_name: "Season Opener",
        }),
      ])
      .mockResolvedValueOnce([
        performanceActivityRow({
          id: "11111111-1111-4111-8111-111111111111",
          activity_name: "Threshold Intervals",
          normalized_power: 280,
        }),
        performanceActivityRow({
          id: "33333333-3333-4333-8333-333333333333",
          activity_name: "Five-Minute Test",
          date: "2026-07-11",
          normalized_power: 300,
        }),
      ]);

    const repository = new CyclingAnalyticsRepository(
      { execute: vi.fn().mockResolvedValue([]) },
      "11111111-1111-4111-8111-111111111111",
      "UTC",
      sensorStore,
    );

    const result = await repository.getPerformance(ChartRange.fromDays(90));

    expect(result.estimateEvidence.recent.threshold).toMatchObject({
      method: "Critical Power model fitted to 120–600 second best-power efforts",
      confidence: "high",
      confidenceLabel: "High fit quality",
      sourceWorkouts: [
        { id: "11111111-1111-4111-8111-111111111111", name: "Threshold Intervals" },
        { id: "33333333-3333-4333-8333-333333333333", name: "Five-Minute Test" },
        { id: "44444444-4444-4444-8444-444444444444", name: "Long Intervals" },
      ],
    });
    expect(result.estimateEvidence.recent.vo2Max).toMatchObject({
      method: "Indirect estimate from 5-minute maximal aerobic power and latest body weight",
      confidence: "limited",
      confidenceLabel: "Indirect estimate",
      sourceWorkouts: [{ id: "33333333-3333-4333-8333-333333333333", name: "Five-Minute Test" }],
    });
    expect(result.estimateEvidence.eftp).toMatchObject({
      method:
        "Critical Power model for the current value; trend points use normalized power × 0.95",
      sourceWorkouts: [
        { id: "11111111-1111-4111-8111-111111111111", name: "Threshold Intervals" },
        { id: "33333333-3333-4333-8333-333333333333", name: "Five-Minute Test" },
      ],
    });
  });

  it("loads ride cards and all activity charts with one ClickHouse statement", async () => {
    const sensorStore = makeMockSensorStore([
      {
        id: "11111111-1111-4111-8111-111111111111",
        started_at: "2026-07-10T10:00:00.000Z",
        ended_at: "2026-07-10T11:00:00.000Z",
        activity_type: "cycling",
        activity_name: "Intervals",
        provider_id: "wahoo",
        source_providers: ["wahoo"],
        distance_meters: 40000,
        date: "2026-07-10",
        normalized_power: 280,
        average_power: 250,
        estimated_ftp: 300,
        elevation_gain_meters: 500,
        elapsed_seconds: 3600,
        max_hr: 190,
        avg_power_z2: 180,
        avg_hr_z2: 135,
        efficiency_factor: 1.333,
        z2_samples: 600,
      },
    ]);
    const repository = new CyclingAnalyticsRepository(
      { execute: vi.fn().mockResolvedValue([]) },
      "11111111-1111-4111-8111-111111111111",
      "UTC",
      sensorStore,
    );

    const result = await repository.getActivities(ChartRange.fromDays(90), {
      activityLimit: 20,
      activityOffset: 0,
      variabilityLimit: 20,
      variabilityOffset: 0,
    });

    expect(sensorStore.query).toHaveBeenCalledTimes(1);
    expect(result.activities).toEqual({
      totalCount: 1,
      items: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          started_at: "2026-07-10T10:00:00.000Z",
          ended_at: "2026-07-10T11:00:00.000Z",
          activity_type: "cycling",
          name: "Intervals",
          provider_id: "wahoo",
          source_providers: ["wahoo"],
          distance_meters: 40000,
          distance_state: { status: "available" },
          elevation_gain_m: 500,
          elevation_state: { status: "available" },
        },
      ],
    });
    expect(result.variability).toEqual({
      rows: [
        {
          activityId: "11111111-1111-4111-8111-111111111111",
          date: "2026-07-10",
          activityName: "Intervals",
          normalizedPower: 280,
          averagePower: 250,
          variabilityIndex: 1.12,
          intensityFactor: 0.933,
        },
      ],
      totalCount: 1,
      emptyReason: null,
    });
    expect(result.verticalAscent).toEqual([
      {
        date: "2026-07-10",
        activityName: "Intervals",
        activityType: "cycling",
        verticalAscentRate: 500,
        elevationGainMeters: 500,
        elapsedMinutes: 60,
      },
    ]);
    expect(result.aerobicEfficiency).toEqual({
      maxHr: 190,
      activities: [
        {
          date: "2026-07-10",
          activityType: "cycling",
          name: "Intervals",
          avgPowerZ2: 180,
          avgHrZ2: 135,
          efficiencyFactor: 1.333,
          z2Samples: 600,
        },
      ],
    });
    expect(sensorStore.query).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("analytics.cycling_activity"),
      expect.objectContaining({
        userId: "11111111-1111-4111-8111-111111111111",
        timezone: "UTC",
        days: 90,
      }),
      { priority: "dashboard" },
    );
  });

  it("filters, paginates, and orders the combined activity analytics", async () => {
    const sensorStore = makeMockSensorStore([
      cyclingActivityRow({
        activity_name: null,
        avg_power_z2: 180,
        avg_hr_z2: 135,
        efficiency_factor: 1.333,
        z2_samples: 600,
      }),
      cyclingActivityRow({
        id: "22222222-2222-4222-8222-222222222222",
        activity_name: "Hill Repeats",
        normalized_power: 300,
        average_power: 250,
        estimated_ftp: 320,
        elevation_gain_meters: 500,
        elapsed_seconds: 1800,
        max_hr: 190,
        avg_power_z2: 200,
        avg_hr_z2: 140,
        efficiency_factor: 1.429,
        z2_samples: 700,
      }),
      cyclingActivityRow({
        id: "33333333-3333-4333-8333-333333333333",
        activity_name: "Incomplete Ride",
        normalized_power: null,
        average_power: null,
        elevation_gain_meters: 100,
        elapsed_seconds: 0,
        max_hr: 200,
        avg_power_z2: 100,
        avg_hr_z2: 100,
        efficiency_factor: 1,
        z2_samples: null,
      }),
    ]);
    const repository = new CyclingAnalyticsRepository(
      { execute: vi.fn().mockResolvedValue([]) },
      "11111111-1111-4111-8111-111111111111",
      "UTC",
      sensorStore,
    );

    const result = await repository.getActivities(ChartRange.fromDays(90), {
      activityLimit: 1,
      activityOffset: 1,
      variabilityLimit: 2,
      variabilityOffset: 0,
    });

    expect(result.activities).toMatchObject({
      totalCount: 3,
      items: [{ id: "22222222-2222-4222-8222-222222222222", name: "Hill Repeats" }],
    });
    expect(result.variability.totalCount).toBe(2);
    expect(result.variability.rows.map((row) => row.activityName)).toEqual([
      "cycling",
      "Hill Repeats",
    ]);
    expect(result.verticalAscent).toEqual([
      expect.objectContaining({ activityName: "Hill Repeats", verticalAscentRate: 1000 }),
    ]);
    expect(result.aerobicEfficiency).toEqual({
      maxHr: 190,
      activities: [
        expect.objectContaining({ name: "Hill Repeats", efficiencyFactor: 1.429 }),
        expect.objectContaining({ name: "cycling", efficiencyFactor: 1.333 }),
      ],
    });
  });

  it("requires positive efficiency values and at least 300 zone 2 samples", async () => {
    const sensorStore = makeMockSensorStore([
      cyclingActivityRow({
        activity_name: "Minimum Valid Ride",
        avg_power_z2: 180,
        avg_hr_z2: 135,
        efficiency_factor: 1.333,
        z2_samples: 300,
      }),
      cyclingActivityRow({
        id: "22222222-2222-4222-8222-222222222222",
        activity_name: "Zero Power Ride",
        avg_power_z2: 0,
        avg_hr_z2: 135,
        efficiency_factor: 1.333,
        z2_samples: 600,
      }),
      cyclingActivityRow({
        id: "33333333-3333-4333-8333-333333333333",
        activity_name: "Zero Heart Rate Ride",
        avg_power_z2: 180,
        avg_hr_z2: 0,
        efficiency_factor: 1.333,
        z2_samples: 600,
      }),
      cyclingActivityRow({
        id: "44444444-4444-4444-8444-444444444444",
        activity_name: "Zero Efficiency Ride",
        avg_power_z2: 180,
        avg_hr_z2: 135,
        efficiency_factor: 0,
        z2_samples: 600,
      }),
      cyclingActivityRow({
        id: "55555555-5555-4555-8555-555555555555",
        activity_name: "Missing Samples Ride",
        avg_power_z2: 180,
        avg_hr_z2: 135,
        efficiency_factor: 1.333,
        z2_samples: null,
      }),
      cyclingActivityRow({
        id: "66666666-6666-4666-8666-666666666666",
        activity_name: "Insufficient Samples Ride",
        avg_power_z2: 180,
        avg_hr_z2: 135,
        efficiency_factor: 1.333,
        z2_samples: 299,
      }),
    ]);
    const repository = new CyclingAnalyticsRepository(
      { execute: vi.fn().mockResolvedValue([]) },
      "11111111-1111-4111-8111-111111111111",
      "UTC",
      sensorStore,
    );

    const result = await repository.getActivities(ChartRange.fromDays(90), {
      activityLimit: 20,
      activityOffset: 0,
      variabilityLimit: 20,
      variabilityOffset: 0,
    });

    expect(result.aerobicEfficiency.activities.map((activity) => activity.name)).toEqual([
      "Minimum Valid Ride",
    ]);
  });

  it("excludes indoor and virtual cycling workouts from vertical ascent", async () => {
    const sensorStore = makeMockSensorStore([
      cyclingActivityRow({
        activity_name: "Spin Class",
        activity_type: "indoor_cycling",
        elevation_gain_meters: 500,
      }),
      cyclingActivityRow({
        id: "22222222-2222-4222-8222-222222222222",
        activity_name: "Virtual Climb",
        activity_type: "virtual_cycling",
        elevation_gain_meters: 1000,
      }),
      cyclingActivityRow({
        id: "33333333-3333-4333-8333-333333333333",
        activity_name: "Outdoor Climb",
        activity_type: "road_cycling",
        elevation_gain_meters: 750,
      }),
    ]);
    const repository = new CyclingAnalyticsRepository(
      { execute: vi.fn().mockResolvedValue([]) },
      "11111111-1111-4111-8111-111111111111",
      "UTC",
      sensorStore,
    );

    const result = await repository.getActivities(ChartRange.fromDays(90), {
      activityLimit: 20,
      activityOffset: 0,
      variabilityLimit: 20,
      variabilityOffset: 0,
    });

    expect(result.verticalAscent.map((activity) => activity.activityName)).toEqual([
      "Outdoor Climb",
    ]);
  });

  it("returns the cycling empty state when there are no activities", async () => {
    const sensorStore = makeMockSensorStore([]);
    const repository = new CyclingAnalyticsRepository(
      { execute: vi.fn().mockResolvedValue([]) },
      "11111111-1111-4111-8111-111111111111",
      "UTC",
      sensorStore,
    );

    const result = await repository.getActivities(ChartRange.fromDays(90), {
      activityLimit: 20,
      activityOffset: 0,
      variabilityLimit: 20,
      variabilityOffset: 0,
    });

    expect(result).toEqual({
      activities: { items: [], totalCount: 0 },
      variability: { rows: [], totalCount: 0, emptyReason: "no_cycling_activities" },
      verticalAscent: [],
      aerobicEfficiency: { maxHr: null, activities: [] },
    });
  });

  it("applies limited access bounds to every ClickHouse statement", async () => {
    const sensorStore = makeMockSensorStore([[], [], []]);
    const repository = new CyclingAnalyticsRepository(
      { execute: vi.fn().mockResolvedValue([]) },
      "11111111-1111-4111-8111-111111111111",
      "America/Los_Angeles",
      sensorStore,
      {
        kind: "limited",
        paid: false,
        reason: "free_signup_week",
        startDate: "2026-07-01T00:00:00.000Z",
        endDateExclusive: "2026-07-08T00:00:00.000Z",
      },
    );

    await repository.getPerformance(ChartRange.fromDays(null));
    await repository.getActivities(ChartRange.fromDays(null), {
      activityLimit: 20,
      activityOffset: 0,
      variabilityLimit: 20,
      variabilityOffset: 0,
    });

    expect(sensorStore.query).toHaveBeenCalledTimes(3);
    for (const queryCall of vi.mocked(sensorStore.query).mock.calls) {
      expect(queryCall[1]).toContain("accessStartDate");
      expect(queryCall[1]).toContain("accessEndDateExclusive");
      expect(queryCall[2]).toMatchObject({
        accessStartDate: "2026-07-01T00:00:00.000Z",
        accessEndDateExclusive: "2026-07-08T00:00:00.000Z",
      });
      expect(queryCall[3]).toEqual({ priority: "dashboard" });
    }
  });

  it("reports a missing threshold estimate when power data exists without an FTP estimate", async () => {
    const sensorStore = makeMockSensorStore([
      {
        id: "11111111-1111-4111-8111-111111111111",
        started_at: "2026-07-10T10:00:00.000Z",
        ended_at: "2026-07-10T11:00:00.000Z",
        activity_type: "cycling",
        activity_name: "Steady Ride",
        provider_id: "wahoo",
        source_providers: ["wahoo"],
        distance_meters: 40000,
        date: "2026-07-10",
        normalized_power: 220,
        average_power: 200,
        estimated_ftp: null,
        elevation_gain_meters: null,
        elapsed_seconds: 3600,
        max_hr: null,
        avg_power_z2: null,
        avg_hr_z2: null,
        efficiency_factor: null,
        z2_samples: null,
      },
    ]);
    const repository = new CyclingAnalyticsRepository(
      { execute: vi.fn().mockResolvedValue([]) },
      "11111111-1111-4111-8111-111111111111",
      "UTC",
      sensorStore,
    );

    const result = await repository.getActivities(ChartRange.fromDays(90), {
      activityLimit: 20,
      activityOffset: 0,
      variabilityLimit: 20,
      variabilityOffset: 0,
    });

    expect(result.variability).toMatchObject({
      rows: [],
      totalCount: 0,
      emptyReason: "no_ftp_estimate",
    });
  });

  it.each([
    {
      label: "zero average power",
      row: cyclingActivityRow({ average_power: 0 }),
      emptyReason: "no_normalized_power",
    },
    {
      label: "zero FTP estimate",
      row: cyclingActivityRow({ estimated_ftp: 0 }),
      emptyReason: "no_ftp_estimate",
    },
  ])("rejects $label before calculating variability", async ({ row, emptyReason }) => {
    const sensorStore = makeMockSensorStore([row]);
    const repository = new CyclingAnalyticsRepository(
      { execute: vi.fn().mockResolvedValue([]) },
      "11111111-1111-4111-8111-111111111111",
      "UTC",
      sensorStore,
    );

    const result = await repository.getActivities(ChartRange.fromDays(90), {
      activityLimit: 20,
      activityOffset: 0,
      variabilityLimit: 20,
      variabilityOffset: 0,
    });

    expect(result.variability).toMatchObject({ rows: [], totalCount: 0, emptyReason });
  });
});
