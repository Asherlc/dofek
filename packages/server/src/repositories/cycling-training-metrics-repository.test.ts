import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type CyclingEffortContext,
  calculateCyclingEffortMetrics,
  evaluateCyclingEffortMetrics,
  prepareCyclingEffortMetrics,
} from "./cycling-effort-metrics.ts";
import {
  type CyclingActivityPowerMetrics,
  CyclingThresholdRepository,
} from "./cycling-threshold-repository.ts";
import { CyclingTrainingMetricsRepository } from "./cycling-training-metrics-repository.ts";

vi.mock("./cycling-effort-metrics.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./cycling-effort-metrics.ts")>();
  return {
    ...actual,
    prepareCyclingEffortMetrics: vi.fn(actual.prepareCyclingEffortMetrics),
    evaluateCyclingEffortMetrics: vi.fn(actual.evaluateCyclingEffortMetrics),
  };
});

const prepareCyclingEffortMetricsMock = vi.mocked(prepareCyclingEffortMetrics);
const evaluateCyclingEffortMetricsMock = vi.mocked(evaluateCyclingEffortMetrics);

function emptyEffort(context: CyclingEffortContext) {
  const prepared = prepareCyclingEffortMetrics([], context);
  return calculateCyclingEffortMetrics(prepared, {
    activity: { normalizedPowerWatts: null, intensityFactor: null, trainingStressScore: null },
    intervals: prepared.powerWindows.map(() => ({
      normalizedPowerWatts: null,
      intensityFactor: null,
      trainingStressScore: null,
    })),
  });
}

const userId = "00000000-0000-4000-8000-000000000001";
const activityId = "00000000-0000-4000-8000-000000000010";
const memberActivityId = "00000000-0000-4000-8000-000000000011";
const unknownIntervalSource = {
  source_kind: null,
  source_provider: null,
  source_activity_id: null,
  segment_type: null,
  target_intensity: null,
  target_zone: null,
  target_cadence_rpm: null,
  target_power_watts: null,
  target_resistance: null,
  work_recovery_kind: null,
  fit_source: null,
  planned_duration_seconds: null,
  recorded_timer_duration_seconds: null,
  target_power_min_watts: null,
  target_power_max_watts: null,
  raw: null,
};

function queryText(query: unknown): string {
  if (typeof query !== "object" || query === null || !("queryChunks" in query)) {
    throw new Error("Expected Drizzle SQL query object");
  }
  return JSON.stringify(Reflect.get(query, "queryChunks"));
}

function snapshotQuery(query: string): string {
  return query
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n");
}

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
    stream_evidence: [
      ["power", "peloton", "Peloton Bike", "direct"],
      ["heart_rate", "peloton", "Peloton Bike", "direct"],
      ["cadence", "peloton", "Peloton Bike", "direct"],
    ],
  }));
}

describe("CyclingTrainingMetricsRepository", () => {
  beforeEach(() => {
    vi.spyOn(CyclingThresholdRepository.prototype, "getForActivities").mockImplementation(
      async (ids) =>
        new Map(
          ids.map((id) => {
            const ftp = 250;
            const np = 200;
            const metrics: CyclingActivityPowerMetrics = {
              activity_id: id,
              started_at: "2026-06-15T15:00:00.000Z",
              ended_at: "2026-06-15T16:00:00.000Z",
              activity_date: "2026-06-15",
              canonical_type: "cycling",
              normalized_power: np,
              power_sample_count: 3600,
              ftp,
              intensity_factor: np / ftp,
              power_tss: 64,
              threshold: {
                value: ftp,
                unit: "watt",
                effective_from: "2026-01-01",
                source_record_id: userId,
                kind: "configured",
              },
            };
            return [id, metrics] as const;
          }),
        ),
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it("renders canonical activity power metrics with configured FTP provenance", async () => {
    const execute = vi.fn().mockResolvedValue([]);
    const query = vi.fn(async (_schema, text: string) => {
      if (text.includes("cycling-training-metrics:activities")) return [activityRow()];
      if (text.includes("cycling-training-metrics:samples")) return samples();
      return [];
    });
    const result = await new CyclingTrainingMetricsRepository(
      { execute },
      { query },
      userId,
      "UTC",
    ).listRange({
      startDate: "2026-06-01",
      endDate: "2026-06-30",
      modalities: [],
      providers: [],
      durationsSeconds: [],
      cursor: null,
      limit: 10,
    });
    expect(result.activities[0]?.metrics.power).toMatchObject({
      normalized_watts: 200,
      intensity_factor: 0.8,
      training_stress_score: 64,
    });
    expect(result.activities[0]?.thresholds.ftp).toMatchObject({
      value: 250,
      kind: "configured",
      effective_from: "2026-01-01",
      source_record_id: userId,
    });
  });

  it("preserves a real null-valued clear snapshot in training metrics output", async () => {
    const clear = {
      value: null,
      unit: "watt" as const,
      effective_from: "2026-06-10",
      source_record_id: "00000000-0000-4000-8000-000000000004",
      kind: "configured" as const,
    };
    vi.spyOn(CyclingThresholdRepository.prototype, "getForActivities").mockResolvedValue(
      new Map([
        [
          activityId,
          {
            activity_id: activityId,
            started_at: "2026-06-15T15:00:00.000Z",
            ended_at: "2026-06-15T16:00:00.000Z",
            activity_date: "2026-06-15",
            canonical_type: "cycling",
            normalized_power: 200,
            power_sample_count: 3600,
            ftp: null,
            intensity_factor: null,
            power_tss: null,
            threshold: clear,
          },
        ],
      ]),
    );
    const execute = vi.fn().mockResolvedValue([]);
    const query = vi.fn(async (_schema, text: string) => {
      if (text.includes("cycling-training-metrics:activities")) return [activityRow()];
      if (text.includes("cycling-training-metrics:samples")) return samples();
      return [];
    });
    const result = await new CyclingTrainingMetricsRepository(
      { execute },
      { query },
      userId,
      "UTC",
    ).listRange({
      startDate: "2026-06-01",
      endDate: "2026-06-30",
      modalities: [],
      providers: [],
      durationsSeconds: [],
      cursor: null,
      limit: 10,
    });

    expect(result.activities[0]?.thresholds.ftp).toEqual({
      value: null,
      unit: "W",
      effective_from: clear.effective_from,
      source_record_id: clear.source_record_id,
      kind: "configured",
    });
    expect(result.activities[0]?.metrics.unavailable_reasons).toContainEqual({
      metric: "intensity_factor",
      reason: expect.stringContaining("cleared"),
    });
  });

  it("links interval evidence by input position when indexes and bounds repeat", async () => {
    const intervalInputs = [
      {
        index: 1,
        type: "work" as const,
        label: "A",
        startOffsetSeconds: 0,
        endOffsetSeconds: 20,
        targetPowerWatts: 225,
      },
      {
        index: 1,
        type: "work" as const,
        label: "B",
        startOffsetSeconds: 0,
        endOffsetSeconds: 30,
        targetPowerWatts: 230,
      },
      {
        index: 1,
        type: "work" as const,
        label: "C",
        startOffsetSeconds: 10,
        endOffsetSeconds: 30,
        targetPowerWatts: 235,
      },
    ];
    const intervalEvidence = intervalInputs.map((input, index) => ({
      input,
      interval: {
        intervalIndex: input.index,
        source: "provider_recorded" as const,
        startOffsetSeconds: input.startOffsetSeconds,
        endOffsetSeconds: input.endOffsetSeconds,
        label: input.label,
        intervalType: input.type,
        segmentType: `segment-${input.label}`,
        workRecoveryKind: "work" as const,
        sourceProvider: `provider-${input.label.toLowerCase()}`,
        sourceActivityId: memberActivityId,
        sourceMemberActivityIds: [memberActivityId],
        targetIntensity: 0.9 + index / 100,
        targetZone: 3 + index,
        targetCadenceRpm: 90 + index,
        targetPowerWatts: input.targetPowerWatts,
        targetResistance: 35 + index,
        raw: { interval: input.label },
        completionPct: 95 - index,
        ...(index === 0
          ? {
              conflicts: ["targetPowerWatts"],
              sourceEvidence: [],
            }
          : {}),
      },
      memberActivityIds: [memberActivityId],
    }));
    const calculated = emptyEffort({
      durationSeconds: 60,
      activityDate: "2026-06-15",
      settingsHistory: [],
      activityPowerMetrics: null,
      intervals: intervalInputs,
      intervalEvidence,
      weightObservations: [],
      powerMeasurementKinds: [],
      sourceProviders: [],
      sourceDevices: [],
    });
    const first = calculated.intervals[0];
    const third = calculated.intervals[2];
    if (!first || !third) throw new Error("Expected three calculated intervals");
    evaluateCyclingEffortMetricsMock.mockResolvedValueOnce([
      {
        ...calculated,
        workout: calculated.workout,
        intervals: [...calculated.intervals.slice(0, 2), { ...third, source: "inferred" }],
      },
    ]);
    const execute = vi.fn().mockResolvedValue([]);
    const query = vi.fn(async (_schema, text: string) =>
      text.includes("cycling-training-metrics:activities") ? [activityRow()] : [],
    );

    const result = await new CyclingTrainingMetricsRepository(
      { execute },
      { query },
      userId,
      "UTC",
    ).listRange({
      startDate: "2026-06-01",
      endDate: "2026-06-30",
      modalities: [],
      providers: [],
      durationsSeconds: [],
      cursor: null,
      limit: 10,
    });

    const intervals = result.activities[0]?.metrics.intervals;
    expect(intervals?.map((interval) => interval.source_provider)).toEqual([
      "provider-a",
      "provider-b",
      "provider-c",
    ]);
    expect(intervals?.[0]).toMatchObject({
      source_kind: "provider_recorded",
      source_activity_id: memberActivityId,
      segment_type: "segment-A",
      target_intensity: 0.9,
      target_zone: 3,
      target_cadence_rpm: 90,
      target_power_watts: 225,
      target_resistance: 35,
      work_recovery_kind: "work",
      completion_pct: null,
      source_member_activity_ids: [memberActivityId],
      raw: { interval: "A" },
      conflicts: ["targetPowerWatts"],
      source_evidence: [],
    });
    expect(intervals?.[2]).toMatchObject({
      source_kind: "inferred",
      target_intensity: null,
      target_zone: null,
      target_cadence_rpm: null,
      target_power_watts: null,
      target_resistance: null,
      completion_pct: null,
    });
  });

  it("returns explicit unknown and nullable evidence when no normalized interval matches", async () => {
    const calculated = emptyEffort({
      durationSeconds: 60,
      activityDate: "2026-06-15",
      settingsHistory: [],
      activityPowerMetrics: null,
      intervals: [
        {
          index: 1,
          type: "work",
          label: "Unmatched",
          startOffsetSeconds: 0,
          endOffsetSeconds: 30,
          targetPowerWatts: 220,
        },
      ],
      weightObservations: [],
      powerMeasurementKinds: [],
      sourceProviders: [],
      sourceDevices: [],
    });
    evaluateCyclingEffortMetricsMock.mockResolvedValueOnce([
      {
        ...calculated,
        workout: calculated.workout,
        intervals: [],
      },
    ]);
    const execute = vi.fn().mockResolvedValue([]);
    const query = vi.fn(async (_schema, text: string) =>
      text.includes("cycling-training-metrics:activities") ? [activityRow()] : [],
    );

    const result = await new CyclingTrainingMetricsRepository(
      { execute },
      { query },
      userId,
      "UTC",
    ).listRange({
      startDate: "2026-06-01",
      endDate: "2026-06-30",
      modalities: [],
      providers: [],
      durationsSeconds: [],
      cursor: null,
      limit: 10,
    });

    expect(result.activities[0]?.metrics.intervals[0]).toEqual({
      index: 1,
      type: "work",
      label: "Unmatched",
      source: "recorded",
      start_offset_seconds: 0,
      end_offset_seconds: 30,
      duration_seconds: 30,
      average_power_watts: null,
      normalized_power_watts: null,
      average_heart_rate_bpm: null,
      average_cadence_rpm: null,
      source_kind: "unknown",
      source_provider: null,
      source_activity_id: null,
      segment_type: null,
      target_intensity: null,
      target_zone: null,
      target_cadence_rpm: null,
      target_power_watts: 220,
      target_resistance: null,
      work_recovery_kind: null,
      completion_pct: null,
      source_member_activity_ids: [],
      raw: null,
    });
  });

  it("passes complete provider and sensor provenance to effort calculation", async () => {
    prepareCyclingEffortMetricsMock.mockClear();
    const execute = vi.fn().mockResolvedValue([]);
    const query = vi.fn(async (_schema, text: string) => {
      if (text.includes("cycling-training-metrics:activities")) {
        return [activityRow({ source_providers: ["garmin", "apple_health", "garmin"] })];
      }
      if (text.includes("cycling-training-metrics:samples")) {
        return [
          {
            ...samples()[0],
            source_devices: ["trainer", "watch"],
            power_measurement_kinds: ["direct", "estimated"],
          },
          {
            ...samples()[1],
            source_devices: ["bike"],
            power_measurement_kinds: ["unknown"],
          },
        ];
      }
      return [];
    });

    await new CyclingTrainingMetricsRepository({ execute }, { query }, userId, "UTC").listRange({
      startDate: "2026-06-01",
      endDate: "2026-06-30",
      modalities: [],
      providers: [],
      durationsSeconds: [],
      cursor: null,
      limit: 10,
    });

    expect(prepareCyclingEffortMetricsMock).toHaveBeenCalledOnce();
    expect(prepareCyclingEffortMetricsMock.mock.calls[0]?.[1]).toMatchObject({
      weightObservations: [],
      powerMeasurementKinds: ["direct", "estimated", "unknown"],
      sourceProviders: ["garmin", "apple_health", "garmin"],
      sourceDevices: ["trainer", "watch", "bike"],
    });
  });

  it.each(["provider_recorded", "inferred"] as const)(
    "preserves clipped %s interval provenance",
    async (sourceKind) => {
      const execute = vi
        .fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            ...unknownIntervalSource,
            member_activity_id: memberActivityId,
            interval_index: 1,
            label: "clipped interval",
            interval_type: "work",
            started_at: "2026-06-15T14:59:59.000Z",
            ended_at: "2026-06-15T16:00:01.000Z",
            source_kind: sourceKind,
            source_provider: "training-provider",
            source_activity_id: memberActivityId,
            target_power_watts: 240,
            raw: { evidence: "retained" },
          },
        ]);
      const query = vi.fn(async (_schema, text: string) =>
        text.includes(":activities") ? [activityRow()] : text.includes(":samples") ? samples() : [],
      );
      const result = await new CyclingTrainingMetricsRepository(
        { execute },
        { query },
        userId,
        "UTC",
      ).listRange({
        startDate: "2026-06-01",
        endDate: "2026-06-30",
        modalities: [],
        providers: [],
        durationsSeconds: [],
        cursor: null,
        limit: 10,
      });
      expect(result.activities[0]?.metrics.intervals[0]).toMatchObject({
        source: sourceKind === "inferred" ? "inferred" : "recorded",
        source_kind: sourceKind,
        start_offset_seconds: 0,
        end_offset_seconds: 3600,
        source_provider: "training-provider",
        source_member_activity_ids: [memberActivityId],
        target_power_watts: sourceKind === "inferred" ? null : 240,
        raw: { evidence: "retained" },
      });
    },
  );
  it("keeps each planned comparison with its own exact lap when selected buckets match", async () => {
    const fitLap = (member: string, endedAt: string, watts: number) => ({
      ...unknownIntervalSource,
      member_activity_id: member,
      interval_index: 0,
      label: "Step 1",
      interval_type: "lap",
      started_at: "2026-06-15T15:00:00.000Z",
      ended_at: endedAt,
      source_kind: "provider_recorded",
      source_provider: "garmin",
      source_activity_id: member,
      target_power_watts: watts,
      fit_source: "workout_step_lap",
      planned_duration_seconds: 180,
      recorded_timer_duration_seconds: 179,
    });
    const execute = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        fitLap(memberActivityId, "2026-06-15T15:02:59.100Z", 200),
        fitLap(activityId, "2026-06-15T15:02:59.200Z", 300),
      ]);
    const query = vi.fn(async (_schema, text: string) =>
      text.includes(":activities") ? [activityRow()] : text.includes(":samples") ? samples() : [],
    );
    const result = await new CyclingTrainingMetricsRepository(
      { execute },
      { query },
      userId,
      "UTC",
    ).listRange({
      startDate: "2026-06-01",
      endDate: "2026-06-30",
      modalities: [],
      providers: [],
      durationsSeconds: [],
      cursor: null,
      limit: 10,
    });

    expect(
      result.activities[0]?.metrics.intervals.map((interval) => [
        interval.source_activity_id,
        interval.planned_comparison?.target,
        interval.planned_comparison?.end_offset_seconds,
      ]),
    ).toEqual([
      [memberActivityId, { kind: "point", watts: 200 }, 179.1],
      [activityId, { kind: "point", watts: 300 }, 179.2],
    ]);
  });

  it("compares planned laps over the exact canonical window, not whole-second elapsed time", async () => {
    // ClickHouse reports 2 elapsed seconds for a canonical window that actually ends at 2.4 s.
    const execute = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          ...unknownIntervalSource,
          member_activity_id: memberActivityId,
          interval_index: 0,
          label: "Step 1",
          interval_type: "lap",
          started_at: "2026-06-15T15:00:00.000Z",
          ended_at: "2026-06-15T15:00:02.400Z",
          source_kind: "provider_recorded",
          source_provider: "garmin",
          source_activity_id: memberActivityId,
          target_power_watts: 200,
          fit_source: "workout_step_lap",
          planned_duration_seconds: 180,
          recorded_timer_duration_seconds: 2.4,
        },
      ]);
    const rampSamples = [10, 20, 30].map((power, second) => ({
      ...samples()[0],
      elapsed_seconds: second,
      power,
      heart_rate: null,
      cadence: null,
      stream_evidence: [["power", "peloton", "Peloton Bike", "direct"]],
    }));
    const query = vi.fn(async (_schema, text: string) =>
      text.includes(":activities")
        ? [activityRow({ ended_at: "2026-06-15T15:00:02.400Z", elapsed_seconds: 2 })]
        : text.includes(":samples")
          ? rampSamples
          : [],
    );
    const result = await new CyclingTrainingMetricsRepository(
      { execute },
      { query },
      userId,
      "UTC",
    ).listRange({
      startDate: "2026-06-01",
      endDate: "2026-06-30",
      modalities: [],
      providers: [],
      durationsSeconds: [],
      cursor: null,
      limit: 10,
    });
    const [interval] = result.activities[0]?.metrics.intervals ?? [];

    expect(interval?.planned_comparison).toMatchObject({
      start_offset_seconds: 0,
      end_offset_seconds: 2.4,
      average_power_watts: 20,
    });
    // The legacy aggregate keeps its whole-second elapsed-time window.
    expect(interval?.average_power_watts).toBe(15);
    expect(query.mock.calls.filter(([, text]) => String(text).includes(":samples"))).toHaveLength(
      1,
    );
  });

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
          source_kind: "provider_recorded",
          source_provider: "peloton",
          source_activity_id: memberActivityId,
          segment_type: "power_zone",
          target_intensity: 0.96,
          target_zone: 4,
          target_cadence_rpm: 95,
          target_power_watts: 240,
          target_resistance: 38,
          work_recovery_kind: "work",
          raw: { source: "fixture" },
          fit_source: null,
          planned_duration_seconds: null,
          recorded_timer_duration_seconds: null,
          target_power_min_watts: null,
          target_power_max_watts: null,
        },
        {
          member_activity_id: activityId,
          interval_index: 1,
          label: "20 minute effort",
          interval_type: "work",
          started_at: "2026-06-15T15:10:00.000Z",
          ended_at: "2026-06-15T15:30:00.000Z",
          source_kind: "inferred",
          source_provider: null,
          source_activity_id: null,
          segment_type: null,
          target_intensity: null,
          target_zone: null,
          target_cadence_rpm: null,
          target_power_watts: null,
          target_resistance: null,
          work_recovery_kind: null,
          raw: null,
          fit_source: null,
          planned_duration_seconds: null,
          recorded_timer_duration_seconds: null,
          target_power_min_watts: null,
          target_power_max_watts: null,
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
    expect(execute.mock.calls.map(([query]) => queryText(query))).toMatchSnapshot();
    expect(
      query.mock.calls.map(([, clickHouseQuery, parameters]) => ({
        query: snapshotQuery(clickHouseQuery),
        parameters,
      })),
    ).toMatchSnapshot();
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
          kind: "configured",
          source_record_id: userId,
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
            source_kind: "provider_recorded",
            source_provider: "peloton",
            source_activity_id: memberActivityId,
            segment_type: "power_zone",
            target_intensity: 0.96,
            target_zone: 4,
            target_cadence_rpm: 95,
            target_power_watts: 240,
            target_resistance: 38,
            work_recovery_kind: "work",
            raw: { source: "fixture" },
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

  it("retains historical heart-rate settings and explains an unpublished canonical power projection", async () => {
    vi.spyOn(CyclingThresholdRepository.prototype, "getForActivities").mockResolvedValue(new Map());
    const execute = vi
      .fn()
      .mockResolvedValueOnce([
        settingsRow({
          id: "00000000-0000-4000-8000-000000000101",
          effective_from: "2026-06-20",
          threshold_hr: 190,
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
            activity_date: "2026-06-15",
            started_at: "2026-06-15T15:00:00.000Z",
            ended_at: "2026-06-15T15:05:00.000Z",
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
          stream_evidence: [["power", "wahoo", "KICKR", "direct"]],
        }));
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
      limit: 10,
    });

    expect(result).toMatchSnapshot();
    expect(execute.mock.calls.map(([query]) => queryText(query))).toMatchSnapshot();
    expect(
      query.mock.calls.map(([, clickHouseQuery, parameters]) => ({
        query: snapshotQuery(clickHouseQuery),
        parameters,
      })),
    ).toMatchSnapshot();
    expect(result.activities[0]?.thresholds.threshold_heart_rate).toMatchObject({
      value: 175,
      effective_from: "2026-01-01",
    });
    expect(result.activities[0]?.thresholds.ftp).toBeNull();
    expect(result.activities[0]?.metrics.power.intensity_factor).toBeNull();
    expect(result.activities[0]?.metrics.unavailable_reasons).toContainEqual({
      metric: "intensity_factor",
      reason:
        "Normalized power is not available for this activity yet. Processing may be incomplete or power coverage may be insufficient.",
    });
  });

  it("preserves limited estimated-power, timezone, and recorded-interval evidence", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([settingsRow({ threshold_hr: 0 })])
      .mockResolvedValueOnce([
        {
          member_activity_id: memberActivityId,
          interval_index: 2,
          label: "Easy",
          interval_type: "recovery",
          started_at: "2026-06-15T15:20:00.000Z",
          ended_at: "2026-06-15T15:25:00.000Z",
          ...unknownIntervalSource,
        },
        {
          member_activity_id: memberActivityId,
          interval_index: 1,
          label: "Warm up",
          interval_type: "warm_up",
          started_at: "2026-06-15T15:00:00.000Z",
          ended_at: "2026-06-15T15:10:00.000Z",
          ...unknownIntervalSource,
        },
        {
          member_activity_id: memberActivityId,
          interval_index: 3,
          label: "Cool down",
          interval_type: "cooldown",
          started_at: "2026-06-15T15:50:00.000Z",
          ended_at: null,
          ...unknownIntervalSource,
        },
      ]);
    const query = vi.fn(async (_schema, queryText: string) => {
      if (queryText.includes("cycling-training-metrics:activities")) {
        return [
          activityRow({
            activity_timezone: null,
            local_time_source: "unknown",
            member_activity_ids: [memberActivityId],
          }),
        ];
      }
      if (queryText.includes("cycling-training-metrics:samples")) {
        return [
          {
            activity_id: activityId,
            elapsed_seconds: 0,
            power: 200,
            heart_rate: null,
            cadence: null,
            source_providers: ["virtual"],
            source_devices: ["trainer"],
            power_measurement_kinds: ["estimated", "unknown"],
            stream_evidence: [
              ["power", "virtual", "trainer", "estimated"],
              ["power", "virtual", "trainer", "unknown"],
            ],
          },
          {
            activity_id: "00000000-0000-4000-8000-000000000099",
            elapsed_seconds: 0,
            power: 999,
            heart_rate: 200,
            cadence: 120,
            source_providers: ["other"],
            source_devices: ["other"],
            power_measurement_kinds: ["direct"],
            stream_evidence: [
              ["power", "other", "other", "direct"],
              ["heart_rate", "other", "other", "direct"],
              ["cadence", "other", "other", "direct"],
            ],
          },
        ];
      }
      if (queryText.includes("cycling-training-metrics:power-curve")) {
        return [
          {
            activity_id: activityId,
            duration_seconds: 300,
            best_power: 220,
            start_offset_seconds: 30,
            observed_samples: 55,
            coverage_pct: 98,
            largest_gap_seconds: null,
            median_sample_interval_seconds: null,
            power_measurement_kind: "estimated",
          },
        ];
      }
      return [];
    });
    const result = await new CyclingTrainingMetricsRepository(
      { execute },
      { query },
      userId,
      "UTC",
    ).listRange({
      startDate: "2026-06-01",
      endDate: "2026-06-30",
      modalities: [],
      providers: [],
      durationsSeconds: [300],
      cursor: null,
      limit: 10,
    });

    expect(result).toMatchSnapshot();
    expect(result.activities[0]).toMatchObject({
      provenance: {
        timezone_assumption_required: true,
        power_measurement_kinds: ["estimated", "unknown"],
      },
      quality: { status: "limited", trustworthy_for_longitudinal_comparison: false },
    });
    expect(result.activities[0]?.best_powers[0]?.quality.status).toBe("limited");
    expect(result.activities[0]?.metrics.intervals.map((interval) => interval.type)).toEqual([
      "warmup",
      "recovery",
    ]);
  });

  it("returns a stable cursor and never double-counts the lookahead activity", async () => {
    const execute = vi.fn().mockResolvedValue([]);
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
    expect(execute.mock.calls.map(([query]) => queryText(query))).toMatchSnapshot();
    expect(
      query.mock.calls.map(([, clickHouseQuery, parameters]) => ({
        query: snapshotQuery(clickHouseQuery),
        parameters,
      })),
    ).toMatchSnapshot();
    expect(result.activities.map((activity) => activity.activity_id)).toEqual([activityId]);
    expect(result.next_cursor).toEqual(expect.any(String));

    const nextPage = await repository.listRange({
      startDate: "2026-06-01",
      endDate: "2026-06-30",
      modalities: [],
      providers: [],
      durationsSeconds: [],
      cursor: result.next_cursor,
      limit: 1,
    });
    expect(nextPage).toMatchSnapshot();
  });
});
