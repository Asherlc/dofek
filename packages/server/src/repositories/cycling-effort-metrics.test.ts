import type { Database } from "dofek/db";
import type { SQL } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { makeMockSensorStore } from "../lib/test-helpers.ts";
import { cyclingEffortMetricsSchema } from "../mcp/performance-comparison-output.ts";
import {
  calculateCyclingEffortMetrics,
  effectiveSettings,
  loadCyclingEffortData,
  loadCyclingEffortMetrics,
  recordedIntervalsForActivity,
} from "./cycling-effort-metrics.ts";
import type { SportSettingsRow } from "./sport-settings-repository.ts";

const settings: SportSettingsRow = {
  id: "threshold",
  userId: "user",
  sport: "cycling",
  ftp: 250,
  thresholdHr: 175,
  thresholdPacePerKm: null,
  powerZonePcts: [0.55, 0.75, 0.9, 1.05, 1.2, 1.5],
  hrZonePcts: [0.6, 0.7, 0.8, 0.9],
  paceZonePcts: null,
  effectiveFrom: "2026-06-01",
  notes: null,
  createdAt: "2026-06-01",
  updatedAt: "2026-06-01",
};
const samples = Array.from({ length: 1800 }, (_, elapsedSeconds) => ({
  elapsedSeconds,
  powerWatts: 210,
  heartRateBpm: 140,
  cadenceRpm: 90,
  speedMetersPerSecond: 10,
  altitudeMeters: elapsedSeconds / 10,
  temperatureC: 20,
}));
const context = {
  durationSeconds: 1800,
  activityDate: "2026-06-15",
  settingsHistory: [settings],
  intervals: [],
  weightObservations: [
    {
      date: "2026-06-15",
      recordedAt: "2026-06-15T10:00:00Z",
      valueKg: 70,
      observationType: "body_weight" as const,
      measurementKind: "direct" as const,
      provider: "scale",
      sourceRecordId: "weight",
    },
  ],
  powerMeasurementKinds: ["direct" as const],
  sourceProviders: ["sensor"],
  sourceDevices: ["meter"],
};

const activityA = "00000000-0000-4000-8000-000000000001";
const activityB = "00000000-0000-4000-8000-000000000002";
const memberA = "00000000-0000-4000-8000-000000000003";

function intervalRow(
  overrides: Partial<Parameters<typeof recordedIntervalsForActivity>[1][number]> = {},
): Parameters<typeof recordedIntervalsForActivity>[1][number] {
  return {
    member_activity_id: activityA,
    interval_index: 1,
    label: "work",
    interval_type: "work",
    started_at: "2026-06-15T00:00:00.000Z",
    ended_at: "2026-06-15T00:00:30.000Z",
    source_kind: "provider_recorded",
    source_provider: "provider-a",
    source_activity_id: activityA,
    segment_type: null,
    target_intensity: 0.9,
    target_zone: 4,
    target_cadence_rpm: 90,
    target_power_watts: 200,
    target_resistance: 50,
    work_recovery_kind: "work",
    raw: { stable: true },
    ...overrides,
  };
}

function emptyDatabase() {
  const execute = vi.fn(async (_query: SQL): Promise<Record<string, unknown>[]> => []);
  return {
    database: { execute } satisfies Pick<Database, "execute">,
    execute,
  };
}

describe("calculateCyclingEffortMetrics", () => {
  it("treats sequential 2Hz samples as observations and integrates their native durations", () => {
    const result = calculateCyclingEffortMetrics(
      Array.from({ length: 120 }, (_, index) => ({
        elapsedSeconds: index / 2,
        powerWatts: index % 2 === 0 ? 100 : 300,
        speedMetersPerSecond: index % 2 === 0 ? 10 : 20,
        heartRateBpm: index % 2 === 0 ? 120 : 180,
      })),
      { ...context, durationSeconds: 60 },
    );
    expect(result.streamQuality.power).toMatchObject({
      conflictingSamples: 0,
      observedSamples: 120,
      coveredSeconds: 60,
      medianSampleIntervalSeconds: 0.5,
    });
    expect(result.workout.power).toMatchObject({
      averageWatts: 200,
      normalizedWatts: 200,
      workKilojoules: 12,
    });
    expect(result.movement).toMatchObject({
      maximumSpeedMetersPerSecond: 20,
      averageMovingSpeedMetersPerSecond: 15,
      distanceMeters: 900,
      speedHeartRatePairedSeconds: 60,
      speedToHeartRateRatio: 0.1,
    });
    expect(result.workout.heartRate).toEqual({ averageBpm: 150, maximumBpm: 180 });
  });

  it("excludes conflicting, suspicious, and partially covered peaks while retaining native valid peaks", () => {
    const result = calculateCyclingEffortMetrics(
      [
        { elapsedSeconds: 0, speedMetersPerSecond: 10, heartRateBpm: 120 },
        { elapsedSeconds: 0.5, speedMetersPerSecond: 20, heartRateBpm: 180 },
        { elapsedSeconds: 1, speedMetersPerSecond: 30, heartRateBpm: 190 },
        { elapsedSeconds: 1.5, speedMetersPerSecond: 40, heartRateBpm: 200 },
        { elapsedSeconds: 1.5, speedMetersPerSecond: 50, heartRateBpm: 210 },
        { elapsedSeconds: 2, speedMetersPerSecond: 0, heartRateBpm: 0 },
        { elapsedSeconds: 2.5, speedMetersPerSecond: 0, heartRateBpm: 0 },
        { elapsedSeconds: 2.5, speedMetersPerSecond: 0, heartRateBpm: 0 },
        {
          elapsedSeconds: 3,
          speedMetersPerSecond: Number.POSITIVE_INFINITY,
          heartRateBpm: Number.NaN,
        },
        { elapsedSeconds: 3.5, speedMetersPerSecond: -1, heartRateBpm: -1 },
        { elapsedSeconds: -1, speedMetersPerSecond: 60, heartRateBpm: 220 },
        { elapsedSeconds: 4, speedMetersPerSecond: 60, heartRateBpm: 220 },
      ],
      { ...context, durationSeconds: 4 },
    );
    expect(result.movement).toMatchObject({
      maximumSpeedMetersPerSecond: 20,
      averageMovingSpeedMetersPerSecond: 15,
      distanceMeters: 15,
      speedHeartRatePairedSeconds: 1,
      speedToHeartRateRatio: null,
    });
    expect(result.workout.heartRate).toEqual({ averageBpm: 75, maximumBpm: 180 });
    for (const stream of ["speed", "heartRate"] as const) {
      expect(result.streamQuality[stream]).toMatchObject({
        observedSamples: 5,
        conflictingSamples: 1,
        suspiciousSamples: 4,
        coveredSeconds: 2,
        missingSeconds: 2,
        zeroSeconds: 1,
      });
    }
    expect(cyclingEffortMetricsSchema.safeParse(result).success).toBe(true);
  });

  it.each([10, 10.5])(
    "keeps a conflict at %s as a barrier until the next valid observation",
    (offset) => {
      const result = calculateCyclingEffortMetrics(
        [
          ...Array.from({ length: 30 }, (_, index) => ({
            elapsedSeconds: index * 2,
            powerWatts: 200,
            speedMetersPerSecond: 10,
            heartRateBpm: 140,
            cadenceRpm: 90,
            altitudeMeters: index * 2,
            temperatureC: -5,
          })),
          {
            elapsedSeconds: offset,
            powerWatts: 400,
            speedMetersPerSecond: 20,
            altitudeMeters: 40,
            temperatureC: 5,
          },
          {
            elapsedSeconds: offset,
            powerWatts: 600,
            speedMetersPerSecond: 30,
            altitudeMeters: 60,
            temperatureC: 10,
          },
        ],
        { ...context, durationSeconds: 60 },
      );
      for (const stream of ["power", "speed", "altitude", "temperature"] as const) {
        expect(result.streamQuality[stream]).toMatchObject({
          conflictingSamples: 1,
          coveredSeconds: 58,
          missingSeconds: 2,
        });
      }
      expect(result.workout.power).toMatchObject({
        averageWatts: 200,
        normalizedWatts: null,
        workKilojoules: 11.6,
      });
      expect(result.streamQuality.heartRate.coveredSeconds).toBe(60);
      expect(result.streamQuality.cadence.coveredSeconds).toBe(60);
      expect(result.movement.distanceMeters).toBe(580);
      expect(result.movement.elevationGainMeters).toBe(offset === 10 ? 54 : 56);
    },
  );

  it("does not recover coverage after a trailing conflict without another valid sample", () => {
    const result = calculateCyclingEffortMetrics(
      [
        { elapsedSeconds: 0, powerWatts: 0 },
        { elapsedSeconds: 0, powerWatts: 0 },
        { elapsedSeconds: 2, powerWatts: 100 },
        { elapsedSeconds: 2, powerWatts: 200 },
      ],
      { ...context, durationSeconds: 6 },
    );
    expect(result.streamQuality.power).toMatchObject({
      observedSamples: 1,
      conflictingSamples: 1,
      coveredSeconds: 2,
      missingSeconds: 4,
      zeroSeconds: 2,
    });
    expect(result.workout.power.workKilojoules).toBe(0);
  });

  it.each([1800, 30])(
    "normalizes stored inferred intervals in every representation for a %s-second effort",
    (durationSeconds) => {
      const evidence = recordedIntervalsForActivity(
        {
          activity_id: "activity",
          member_activity_ids: ["activity"],
          started_at: "2026-06-15T00:00:00Z",
        },
        [
          {
            member_activity_id: "activity",
            interval_index: 1,
            label: "detected",
            interval_type: "work",
            started_at: "2026-06-15T00:00:00Z",
            ended_at: "2026-06-15T00:01:00Z",
            source_kind: "inferred",
            source_provider: "sensor",
            source_activity_id: "activity",
            segment_type: "work",
            target_intensity: 0.9,
            target_zone: 3,
            target_cadence_rpm: 90,
            target_power_watts: 220,
            target_resistance: 50,
            work_recovery_kind: "work",
            raw: { original: "retained" },
          },
        ],
      );
      const result = calculateCyclingEffortMetrics(samples, {
        ...context,
        durationSeconds,
        intervals: evidence.map((item) => item.input),
        intervalEvidence: evidence,
      });
      expect(result.workout.intervalSource).toBe("inferred");
      for (const intervals of [result.intervals, result.workout.intervals]) {
        expect(intervals[0]).toMatchObject({
          source: "inferred",
          targetPowerWatts: null,
          completionPct: null,
        });
      }
      expect(result.intervals[0]?.evidence).toMatchObject({
        source: "inferred",
        raw: { original: "retained" },
        targetZone: null,
      });
      expect(cyclingEffortMetricsSchema.safeParse(result).success).toBe(true);
    },
  );

  it("explains locally unavailable power, movement, elevation and weight-normalized metrics", () => {
    const result = calculateCyclingEffortMetrics([], context);
    for (const metric of [
      "average_power",
      "work",
      "variability_index",
      "average_moving_speed",
      "maximum_speed",
      "elevation_gain",
      "elevation_loss",
      "average_watts_per_kg",
      "normalized_watts_per_kg",
    ]) {
      expect(result.unavailableReasons).toContainEqual({ metric, reason: expect.any(String) });
    }
  });
  it("shares workout calculations, coverage, zones and valid weight provenance", () => {
    const result = calculateCyclingEffortMetrics(samples, context);
    expect(result.workout).toMatchObject({
      power: {
        averageWatts: 210,
        normalizedWatts: 210,
        workKilojoules: 378,
        variabilityIndex: 1,
        intensityFactor: 0.84,
      },
      aerobicEfficiency: { powerToHeartRateRatio: 1.5 },
      cardiacDrift: { percent: 0 },
    });
    expect(result.workout.powerZones?.zones.reduce((n, zone) => n + zone.seconds, 0)).toBe(1800);
    expect(result.weight).toMatchObject({
      value_kg: 70,
      kind: "measured",
      sources: [{ provider: "scale" }],
    });
    expect(result.averageWattsPerKg).toBe(3);
    expect(result.quality.status).toBe("high");
  });

  it("never applies future FTP and exposes the age and unverified freshness of old settings", () => {
    const historical = calculateCyclingEffortMetrics(samples, {
      ...context,
      activityDate: "2026-05-01",
    });
    expect(historical.thresholds.ftp).toBeNull();
    expect(historical.workout.power.intensityFactor).toBeNull();
    expect(historical.unavailableReasons).toContainEqual({
      metric: "intensity_factor",
      reason: "no contemporaneous FTP",
    });
    const old = calculateCyclingEffortMetrics(samples, { ...context, activityDate: "2027-06-01" });
    expect(old.thresholds).toMatchObject({
      ftp: { value: 250 },
      ageDays: 365,
      freshness: "unverified",
    });
    expect(old.thresholds.freshnessReason).toContain("stale");
    const newer = { ...settings, ftp: 300, effectiveFrom: "2026-06-10" };
    expect(
      calculateCyclingEffortMetrics(samples, { ...context, settingsHistory: [settings, newer] })
        .thresholds.ftp?.value,
    ).toBe(300);
  });

  it("calculates movement, paired speed/HR and ascent-window vertical speed with evidence", () => {
    const result = calculateCyclingEffortMetrics(samples, context);
    expect(result.movement).toMatchObject({
      elapsedSeconds: 1800,
      movingSeconds: 1800,
      movingDurationKind: "calculated_from_covered_speed_samples",
      distanceMeters: 18000,
      averageMovingSpeedMetersPerSecond: 10,
      maximumSpeedMetersPerSecond: 10,
    });
    expect(result.movement.speedToHeartRateRatio).toBeCloseTo(10 / 140, 3);
    expect(result.movement.climbVerticalSpeedMetersPerHour).toBeCloseTo(360);
    expect(result.environment).toMatchObject({
      averageTemperatureC: 20,
      valueKind: "calculated_from_samples",
    });
  });

  it("preserves gaps and prevents unpaired speed/HR and unsupported movement", () => {
    const result = calculateCyclingEffortMetrics(
      samples.filter((s) => s.elapsedSeconds < 600),
      context,
    );
    expect(result.movement.speedToHeartRateRatio).toBeNull();
    expect(result.streamQuality.speed.coveredSeconds).toBe(600);
    expect(result.streamQuality.speed.missingSeconds).toBe(1200);
    expect(result.quality.status).toBe("limited");
    const missing = calculateCyclingEffortMetrics([], context);
    expect(missing.movement.movingSeconds).toBeNull();
    expect(missing.movement.distanceMeters).toBeNull();
    expect(missing.movement.climbVerticalSpeedMetersPerHour).toBeNull();
    const sparse = calculateCyclingEffortMetrics(
      samples.filter((sample) => sample.elapsedSeconds === 0 || sample.elapsedSeconds === 600),
      context,
    );
    expect(sparse.streamQuality.power.coveredSeconds).toBe(20);
    expect(sparse.streamQuality.speed.coveredSeconds).toBe(20);
    expect(sparse.movement.speedToHeartRateRatio).toBeNull();
  });

  it("retains provider moving-duration conflicts and labels estimated power and missing weight", () => {
    const result = calculateCyclingEffortMetrics(samples, {
      ...context,
      powerMeasurementKinds: ["estimated"],
      weightObservations: [],
      movingDuration: {
        seconds: null,
        status: "conflicting",
        evidence: [],
        evidence_count: 2,
        evidence_truncated: false,
      },
    });
    expect(result.movement.providerMovingDuration?.status).toBe("conflicting");
    expect(result.averageWattsPerKg).toBeNull();
    expect(result.provenance.powerMeasurementKinds).toEqual(["estimated"]);
    expect(result.quality.reasons).toContain("Provider moving durations conflict");
    expect(result.bestPowerInterpretation).toMatchObject({
      kind: "descriptive_observed_maxima",
      maximalTest: false,
    });
    expect(result.bestPowerInterpretation.caveat).toContain("lower bound");
  });

  it("excludes suspicious and conflicting sensor values without losing measured zeros", () => {
    const result = calculateCyclingEffortMetrics(
      [
        { elapsedSeconds: 0, powerWatts: -5, speedMetersPerSecond: -1 },
        { elapsedSeconds: 1, powerWatts: 0, speedMetersPerSecond: 0 },
        { elapsedSeconds: 2, powerWatts: 200 },
        { elapsedSeconds: 2, powerWatts: 400 },
      ],
      { ...context, durationSeconds: 4 },
    );
    expect(result.streamQuality.power).toMatchObject({
      suspiciousSamples: 1,
      conflictingSamples: 1,
      zeroSeconds: 1,
    });
    expect(result.workout.power.averageWatts).toBe(0);
    expect(result.movement.movingSeconds).toBe(0);
  });

  it("uses provider moving time with deduplicated distance evidence when speed is absent", () => {
    const result = calculateCyclingEffortMetrics([], {
      ...context,
      distanceEvidence: { meters: 12000, kind: "deduplicated_summary" },
      movingDuration: {
        seconds: 1200,
        status: "available",
        evidence: [],
        evidence_count: 1,
        evidence_truncated: false,
      },
    });
    expect(result.movement).toMatchObject({
      movingSeconds: 1200,
      movingDurationKind: "provider_reported",
      distanceMeters: 12000,
      distanceKind: "deduplicated_summary",
      averageMovingSpeedMetersPerSecond: 10,
    });
  });

  it("preserves signed environment observations and descriptive best-power weight evidence", () => {
    const result = calculateCyclingEffortMetrics(
      samples.map((sample) => ({
        ...sample,
        altitudeMeters: sample.altitudeMeters - 400,
        temperatureC: -5,
      })),
      {
        ...context,
        bestPowers: [
          {
            activity_id: "activity",
            duration_seconds: 300,
            best_power: 280,
            start_offset_seconds: 100,
            observed_samples: 300,
            coverage_pct: 100,
            largest_gap_seconds: 1,
            median_sample_interval_seconds: 1,
            power_measurement_kind: "direct",
          },
        ],
      },
    );
    expect(result.environment.averageTemperatureC).toBe(-5);
    expect(result.streamQuality.temperature.zeroSeconds).toBe(0);
    expect(result.bestPowers[0]).toMatchObject({
      watts: 280,
      wattsPerKg: 4,
      powerKind: "direct",
      durationSeconds: 300,
    });
    expect(result.movement.elevationGainMeters).toBeCloseTo(179.9);
  });

  it("treats exactly 90% paired speed and heart-rate coverage as comparable", () => {
    const ninetyPercent = Array.from({ length: 9 }, (_, elapsedSeconds) => ({
      elapsedSeconds,
      speedMetersPerSecond: 9,
      heartRateBpm: 90,
    }));
    const comparable = calculateCyclingEffortMetrics(ninetyPercent, {
      ...context,
      durationSeconds: 10,
    });
    expect(comparable.movement).toMatchObject({
      speedHeartRatePairedSeconds: 9,
      speedToHeartRateRatio: 0.1,
    });
    expect(comparable.unavailableReasons).not.toContainEqual({
      metric: "speed_to_heart_rate_ratio",
      reason: expect.any(String),
    });

    const belowThreshold = calculateCyclingEffortMetrics(ninetyPercent.slice(0, 8), {
      ...context,
      durationSeconds: 10,
    });
    expect(belowThreshold.movement).toMatchObject({
      speedHeartRatePairedSeconds: 8,
      speedToHeartRateRatio: null,
    });
    expect(belowThreshold.unavailableReasons).toContainEqual({
      metric: "speed_to_heart_rate_ratio",
      reason: "paired speed and heart-rate coverage is below 90%",
    });
  });

  it("requires positive heart rate and positive speed only for their respective ratios and movement", () => {
    const result = calculateCyclingEffortMetrics(
      [
        { elapsedSeconds: 0, speedMetersPerSecond: 0, heartRateBpm: 100 },
        { elapsedSeconds: 1, speedMetersPerSecond: 10, heartRateBpm: 0 },
        { elapsedSeconds: 2, speedMetersPerSecond: 20, heartRateBpm: 100 },
      ],
      { ...context, durationSeconds: 3 },
    );
    expect(result.movement).toMatchObject({
      movingSeconds: 2,
      averageMovingSpeedMetersPerSecond: 15,
      speedHeartRatePairedSeconds: 2,
      speedToHeartRateRatio: null,
      distanceMeters: 30,
    });
  });

  it("accepts zero summary distance and provider moving time equal to elapsed time", () => {
    const shortSamples = Array.from({ length: 10 }, (_, elapsedSeconds) => ({
      elapsedSeconds,
      powerWatts: 200,
      heartRateBpm: 140,
      cadenceRpm: 90,
      speedMetersPerSecond: 10,
    }));
    const exactBoundary = calculateCyclingEffortMetrics(shortSamples, {
      ...context,
      durationSeconds: 10,
      distanceEvidence: { meters: 0, kind: "deduplicated_summary" },
      movingDuration: {
        seconds: 10,
        status: "available",
        evidence: [],
        evidence_count: 1,
        evidence_truncated: false,
      },
    });
    expect(exactBoundary.movement).toMatchObject({
      movingSeconds: 10,
      movingDurationKind: "provider_reported",
      distanceMeters: 0,
      distanceKind: "deduplicated_summary",
      averageMovingSpeedMetersPerSecond: 0,
    });
    expect(exactBoundary.quality.reasons).not.toContain(
      "Provider moving duration exceeds elapsed duration",
    );

    const excessive = calculateCyclingEffortMetrics(shortSamples, {
      ...context,
      durationSeconds: 10,
      distanceEvidence: { meters: 100, kind: "deduplicated_summary" },
      movingDuration: {
        seconds: 11,
        status: "available",
        evidence: [],
        evidence_count: 1,
        evidence_truncated: false,
      },
    });
    expect(excessive.movement).toMatchObject({
      movingSeconds: 10,
      movingDurationKind: "calculated_from_covered_speed_samples",
      averageMovingSpeedMetersPerSecond: 10,
    });
    expect(excessive.quality.reasons).toContain(
      "Provider moving duration exceeds elapsed duration",
    );
  });

  it.each([
    [Number.NaN, "integrated_covered_speed_samples"],
    [Number.POSITIVE_INFINITY, "integrated_covered_speed_samples"],
    [-1, "integrated_covered_speed_samples"],
  ] as const)("rejects invalid summary distance %s", (meters, expectedKind) => {
    const result = calculateCyclingEffortMetrics(
      [{ elapsedSeconds: 0, speedMetersPerSecond: 12 }],
      {
        ...context,
        durationSeconds: 1,
        distanceEvidence: { meters, kind: "deduplicated_summary" },
      },
    );
    expect(result.movement).toMatchObject({
      distanceMeters: 12,
      distanceKind: expectedKind,
      averageMovingSpeedMetersPerSecond: 12,
    });
  });

  it("separates ascent, descent, level terrain and discontinuous elevation windows", () => {
    const continuous = calculateCyclingEffortMetrics(
      [
        { elapsedSeconds: 0, altitudeMeters: 100 },
        { elapsedSeconds: 10, altitudeMeters: 110 },
        { elapsedSeconds: 20, altitudeMeters: 105 },
        { elapsedSeconds: 30, altitudeMeters: 105 },
      ],
      { ...context, durationSeconds: 31 },
    );
    expect(continuous.movement).toMatchObject({
      elevationGainMeters: 10,
      elevationLossMeters: 5,
      climbDurationSeconds: 10,
      climbVerticalSpeedMetersPerHour: 3600,
    });

    const discontinuous = calculateCyclingEffortMetrics(
      [
        { elapsedSeconds: 0, altitudeMeters: 100 },
        { elapsedSeconds: 11, altitudeMeters: 120 },
      ],
      { ...context, durationSeconds: 12 },
    );
    expect(discontinuous.movement).toMatchObject({
      elevationGainMeters: null,
      elevationLossMeters: null,
      climbDurationSeconds: 0,
      climbVerticalSpeedMetersPerHour: null,
    });
  });

  it("applies an altitude conflict barrier without contaminating temperature", () => {
    const result = calculateCyclingEffortMetrics(
      [
        { elapsedSeconds: 0, altitudeMeters: 100, temperatureC: -5 },
        { elapsedSeconds: 5, altitudeMeters: 105, temperatureC: -4 },
        { elapsedSeconds: 5, altitudeMeters: 106, temperatureC: -4 },
        { elapsedSeconds: 10, altitudeMeters: 110, temperatureC: -3 },
      ],
      { ...context, durationSeconds: 11 },
    );
    expect(result.streamQuality.altitude).toMatchObject({
      conflictingSamples: 1,
      coveredSeconds: 6,
      missingSeconds: 5,
    });
    expect(result.streamQuality.temperature).toMatchObject({
      conflictingSamples: 0,
      coveredSeconds: 11,
      missingSeconds: 0,
    });
    expect(result.environment.averageTemperatureC).toBeCloseTo(-48 / 11, 5);
    expect(result.movement.elevationGainMeters).toBeNull();
  });

  it("deduplicates and sorts provenance while preferring per-stream measurement evidence", () => {
    const direct = { providerId: "meter", deviceId: "bike", measurementKind: "direct" as const };
    const estimated = {
      providerId: "trainer",
      deviceId: "bike",
      measurementKind: "estimated" as const,
    };
    const result = calculateCyclingEffortMetrics(
      [{ elapsedSeconds: 0, powerWatts: 200, cadenceRpm: 90 }],
      {
        ...context,
        durationSeconds: 1,
        sourceProviders: ["zeta", "alpha", "zeta"],
        sourceDevices: ["watch", "bike", "watch"],
        powerMeasurementKinds: ["unknown", "direct", "unknown"],
        streamEvidence: {
          power: [estimated, direct, estimated],
          cadence: [],
        },
      },
    );
    expect(result.provenance).toMatchObject({
      sourceProviders: ["alpha", "zeta"],
      sourceDevices: ["bike", "watch"],
      powerMeasurementKinds: ["direct", "unknown"],
    });
    expect(result.streamQuality.power).toMatchObject({
      measurementKinds: ["direct", "estimated"],
      evidence: [estimated, direct],
    });
    expect(result.streamQuality.cadence).toMatchObject({
      measurementKinds: [],
      evidence: [],
    });
    expect(result.quality).toEqual({
      status: "limited",
      reasons: ["Power is estimated or its measurement provenance is unknown"],
    });
  });

  it("uses the 99% power-coverage boundary for the comparison quality flag", () => {
    const power = Array.from({ length: 99 }, (_, elapsedSeconds) => ({
      elapsedSeconds,
      powerWatts: 200,
    }));
    const exact = calculateCyclingEffortMetrics(power, { ...context, durationSeconds: 100 });
    expect(exact.streamQuality.power.coveragePct).toBe(99);
    expect(exact.quality).toEqual({ status: "high", reasons: [] });

    const below = calculateCyclingEffortMetrics(power.slice(0, 98), {
      ...context,
      durationSeconds: 100,
    });
    expect(below.streamQuality.power.coveragePct).toBe(98);
    expect(below.quality).toEqual({
      status: "limited",
      reasons: ["Power coverage is incomplete"],
    });
  });

  it("reports each isolated sample-quality defect without requiring every stream to be defective", () => {
    const result = calculateCyclingEffortMetrics(
      [
        { elapsedSeconds: 0, powerWatts: 200, speedMetersPerSecond: 10 },
        { elapsedSeconds: 1, powerWatts: 200, speedMetersPerSecond: 20 },
        { elapsedSeconds: 1, speedMetersPerSecond: 30 },
        { elapsedSeconds: 2, temperatureC: Number.NaN },
      ],
      { ...context, durationSeconds: 2 },
    );
    expect(result.quality.reasons).toEqual([
      "Suspicious samples excluded",
      "Conflicting samples excluded",
    ]);
    expect(result.streamQuality).toMatchObject({
      speed: { conflictingSamples: 1 },
      temperature: { suspiciousSamples: 1 },
      power: { suspiciousSamples: 0, conflictingSamples: 0 },
    });
  });

  it.each([0, -1, Number.NaN])("rejects non-positive or non-finite FTP %s", (ftp) => {
    const result = calculateCyclingEffortMetrics(samples.slice(0, 30), {
      ...context,
      durationSeconds: 30,
      settingsHistory: [{ ...settings, ftp }],
    });
    expect(result.thresholds).toMatchObject({
      ftp: null,
      freshness: "unavailable",
      freshnessReason: "no contemporaneous FTP",
    });
    expect(result.workout.powerZones).toBeNull();
    expect(result.unavailableReasons).toContainEqual({
      metric: "power_zones",
      reason: "no contemporaneous FTP",
    });
  });

  it.each([[], [0.5, 0.5], [0.75, 0.5], [-0.5, 0.5]])(
    "rejects malformed power-zone boundaries %j",
    (powerZonePcts) => {
      const result = calculateCyclingEffortMetrics(samples.slice(0, 30), {
        ...context,
        durationSeconds: 30,
        settingsHistory: [{ ...settings, powerZonePcts }],
      });
      expect(result.thresholds.ftp?.value).toBe(250);
      expect(result.workout.powerZones).toBeNull();
      expect(result.unavailableReasons).toContainEqual({
        metric: "power_zones",
        reason: "no valid contemporaneous power zone boundaries",
      });
    },
  );

  it("does not manufacture weight-normalized metrics or best-power provenance", () => {
    const result = calculateCyclingEffortMetrics(samples.slice(0, 30), {
      ...context,
      durationSeconds: 30,
      weightObservations: [],
      bestPowers: [
        {
          activity_id: activityA,
          duration_seconds: 30,
          best_power: 280,
          start_offset_seconds: null,
          observed_samples: null,
          coverage_pct: null,
          largest_gap_seconds: null,
          median_sample_interval_seconds: null,
          power_measurement_kind: null,
        },
      ],
    });
    expect(result.averageWattsPerKg).toBeNull();
    expect(result.normalizedWattsPerKg).toBeNull();
    expect(result.bestPowers).toEqual([
      {
        durationSeconds: 30,
        watts: 280,
        wattsPerKg: null,
        startOffsetSeconds: null,
        powerKind: "unknown",
        observedSamples: null,
        coveragePct: null,
        largestGapSeconds: null,
        medianSampleIntervalSeconds: null,
      },
    ]);
    expect(result.unavailableReasons).toContainEqual({
      metric: "average_watts_per_kg",
      reason: "No valid positive directly measured body weight is available",
    });
    expect(result.unavailableReasons).toContainEqual({
      metric: "normalized_watts_per_kg",
      reason: "No valid positive directly measured body weight is available",
    });
  });
});

describe("effectiveSettings", () => {
  it("includes settings effective on the activity date and chooses the latest eligible row", () => {
    const older = { ...settings, id: "older", effectiveFrom: "2026-05-01", ftp: 225 };
    const sameDay = { ...settings, id: "same-day", effectiveFrom: "2026-06-15", ftp: 275 };
    const future = { ...settings, id: "future", effectiveFrom: "2026-06-16", ftp: 300 };

    expect(effectiveSettings([older, future, sameDay], "2026-06-15")).toBe(sameDay);
    expect(effectiveSettings([future], "2026-06-15")).toBeNull();
    expect(effectiveSettings([], "2026-06-15")).toBeNull();
  });
});

describe("recordedIntervalsForActivity", () => {
  it("normalizes provider interval kinds while excluding foreign, open and non-positive rows", () => {
    const activity = {
      activity_id: activityA,
      member_activity_ids: [activityA, memberA],
      started_at: "2026-06-15T00:00:00.000Z",
    };
    const result = recordedIntervalsForActivity(activity, [
      intervalRow({ work_recovery_kind: "work", interval_type: "ignored", label: "work" }),
      intervalRow({
        member_activity_id: memberA,
        interval_index: 2,
        started_at: "2026-06-15T00:00:30.000Z",
        ended_at: "2026-06-15T00:01:00.000Z",
        work_recovery_kind: null,
        segment_type: " WARM_UP ",
        interval_type: null,
        label: "warmup",
      }),
      intervalRow({
        interval_index: 3,
        started_at: "2026-06-15T00:01:00.000Z",
        ended_at: "2026-06-15T00:01:30.000Z",
        work_recovery_kind: null,
        segment_type: null,
        interval_type: "COOL_DOWN",
        label: "cooldown",
      }),
      intervalRow({
        interval_index: 4,
        started_at: "2026-06-15T00:01:30.000Z",
        ended_at: "2026-06-15T00:02:00.000Z",
        work_recovery_kind: "recovery",
        label: "recovery",
      }),
      intervalRow({
        interval_index: 5,
        started_at: "2026-06-15T00:02:00.000Z",
        ended_at: "2026-06-15T00:02:30.000Z",
        work_recovery_kind: null,
        segment_type: null,
        interval_type: "tempo",
        label: "other",
      }),
      intervalRow({ member_activity_id: activityB, interval_index: 6 }),
      intervalRow({ interval_index: 7, ended_at: null }),
      intervalRow({
        interval_index: 8,
        started_at: "2026-06-15T00:03:00.000Z",
        ended_at: "2026-06-15T00:03:00.000Z",
      }),
    ]);

    expect(result.map(({ input }) => [input.index, input.type, input.label])).toEqual([
      [1, "work", "work"],
      [2, "warmup", "warmup"],
      [3, "cooldown", "cooldown"],
      [4, "recovery", "recovery"],
      [5, "other", "other"],
    ]);
    expect(result[1]).toMatchObject({
      memberActivityIds: [memberA],
      input: { startOffsetSeconds: 30, endOffsetSeconds: 60 },
      interval: {
        source: "provider_recorded",
        sourceProvider: "provider-a",
        targetIntensity: 0.9,
        targetZone: 4,
        targetCadenceRpm: 90,
        targetPowerWatts: 200,
        targetResistance: 50,
        raw: { stable: true },
      },
    });
  });

  it("rounds recorded boundaries and retains an interval ending one second after it starts", () => {
    const [result] = recordedIntervalsForActivity(
      {
        activity_id: activityA,
        member_activity_ids: [activityA],
        started_at: "2026-06-15T00:00:00.000Z",
      },
      [
        intervalRow({
          started_at: "2026-06-15T00:00:00.400Z",
          ended_at: "2026-06-15T00:00:00.600Z",
        }),
      ],
    );
    expect(result?.input).toMatchObject({ startOffsetSeconds: 0, endOffsetSeconds: 1 });
  });

  it("keeps mixed inferred and provider evidence distinct in interval results", () => {
    const evidence = recordedIntervalsForActivity(
      {
        activity_id: activityA,
        member_activity_ids: [activityA],
        started_at: "2026-06-15T00:00:00.000Z",
      },
      [
        intervalRow({ source_kind: "inferred", label: "detected" }),
        intervalRow({
          interval_index: 2,
          started_at: "2026-06-15T00:00:30.000Z",
          ended_at: "2026-06-15T00:01:00.000Z",
          source_kind: "provider_recorded",
          label: "prescribed",
        }),
      ],
    );
    const result = calculateCyclingEffortMetrics(samples.slice(0, 60), {
      ...context,
      durationSeconds: 60,
      intervals: evidence.map(({ input }) => input),
      intervalEvidence: evidence,
    });

    expect(result.workout.intervalSource).toBe("recorded");
    expect(result.workout.intervals).toMatchObject([
      { index: 1, source: "inferred", targetPowerWatts: null, completionPct: null },
      { index: 2, source: "recorded", targetPowerWatts: 200, completionPct: 105 },
    ]);
    expect(result.intervals).toMatchObject([
      {
        index: 1,
        source: "inferred",
        evidence: { source: "inferred", targetPowerWatts: null },
        targetPowerWatts: null,
        completionPct: null,
      },
      {
        index: 2,
        source: "provider_recorded",
        evidence: { source: "provider_recorded", sourceProvider: "provider-a" },
        targetPowerWatts: 200,
        completionPct: 105,
      },
    ]);
  });
});

describe("cycling effort metric loading", () => {
  it("returns immediately for no activities and rejects oversized or malformed requests", async () => {
    const { database, execute } = emptyDatabase();
    const store = makeMockSensorStore();
    const query = vi.mocked(store.query);

    await expect(
      loadCyclingEffortMetrics(database, store, "user", "UTC", [], [300]),
    ).resolves.toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();

    const request = {
      activity_id: activityA,
      member_activity_ids: [],
      started_at: "2026-06-15T00:00:00.000Z",
      activityDate: "2026-06-15",
      durationSeconds: 1,
      sourceProviders: [],
      movingDuration: {
        seconds: null,
        status: "not_available" as const,
        evidence: [],
        evidence_count: 0,
        evidence_truncated: false,
      },
    };
    await expect(
      loadCyclingEffortMetrics(database, store, "user", "UTC", Array(26).fill(request), []),
    ).rejects.toThrow("At most 25 cycling activities may be calculated");
    await expect(
      loadCyclingEffortMetrics(
        database,
        store,
        "user",
        "UTC",
        [{ ...request, activityDate: "" }, request],
        [],
      ),
    ).rejects.toThrow("Cycling activities require local dates");
    expect(execute).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it("accepts exactly 25 activities", async () => {
    const { database } = emptyDatabase();
    const store = makeMockSensorStore();
    const requests = Array.from({ length: 25 }, (_, index) => ({
      activity_id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
      member_activity_ids: [],
      started_at: "2026-06-15T00:00:00.000Z",
      activityDate: "2026-06-15",
      durationSeconds: 1,
      sourceProviders: [],
      movingDuration: {
        seconds: null,
        status: "not_available" as const,
        evidence: [],
        evidence_count: 0,
        evidence_truncated: false,
      },
    }));

    const result = await loadCyclingEffortMetrics(database, store, "user", "UTC", requests, []);
    expect(result).toHaveLength(25);
    expect(result.map(({ activityId }) => activityId)).toEqual(
      requests.map(({ activity_id }) => activity_id),
    );
  });

  it("skips all sensor and interval reads for an empty effort-data page", async () => {
    const { database, execute } = emptyDatabase();
    const store = makeMockSensorStore();
    const query = vi.mocked(store.query);

    const result = await loadCyclingEffortData(database, store, "user", [], [300]);
    expect(result).toEqual({
      sampleRows: [],
      bestPowerRows: [],
      settingsHistory: [],
      intervalRows: [],
    });
    expect(query).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("maps each canonical activity from only its own samples, evidence, routes and intervals", async () => {
    const coreRows = [
      {
        activity_id: activityA,
        elapsed_seconds: 0,
        power: 100,
        heart_rate: 120,
        cadence: 80,
        source_providers: ["shared", "core-a"],
        source_devices: ["bike-a", "bike-a"],
        power_measurement_kinds: ["estimated", "direct", "direct"],
        stream_evidence: [
          ["power", "meter-a", "bike-a", "direct"],
          ["power", "meter-a", "bike-a", "direct"],
          ["heart_rate", "strap-a", "strap-device-a", "direct"],
        ],
      },
      {
        activity_id: activityB,
        elapsed_seconds: 0,
        power: 200,
        heart_rate: 100,
        cadence: 90,
        source_providers: ["core-b"],
        source_devices: ["bike-b"],
        power_measurement_kinds: ["direct"],
        stream_evidence: [["power", "meter-b", "bike-b", "direct"]],
      },
    ];
    const movementRows = [
      {
        activity_id: activityA,
        elapsed_seconds: 0,
        channel: "speed",
        scalar: 10,
        provider_id: "move-a",
        device_id: "speed-a",
        measurement_kind: "estimated",
      },
      {
        activity_id: activityB,
        elapsed_seconds: 0,
        channel: "speed",
        scalar: 20,
        provider_id: "move-b",
        device_id: "speed-b",
        measurement_kind: "direct",
      },
    ];
    const bestPowerRows = [
      {
        activity_id: activityA,
        duration_seconds: 1,
        best_power: 150,
        start_offset_seconds: 0,
        observed_samples: 1,
        coverage_pct: 100,
        largest_gap_seconds: 0,
        median_sample_interval_seconds: 1,
        power_measurement_kind: "estimated",
      },
      {
        activity_id: activityB,
        duration_seconds: 1,
        best_power: 300,
        start_offset_seconds: 0,
        observed_samples: 1,
        coverage_pct: 100,
        largest_gap_seconds: 0,
        median_sample_interval_seconds: 1,
        power_measurement_kind: "direct",
      },
    ];
    const store = makeMockSensorStore();
    const query = vi.mocked(store.query);
    query.mockImplementation(
      async (schema, statement: string, params: Record<string, unknown> = {}) => {
        let rows: unknown[];
        if (statement.includes("cycling-training-metrics:samples")) {
          expect(params).toEqual({ userId: "user", activityIds: [activityA, activityB] });
          rows = coreRows;
        } else if (statement.includes("cycling-training-metrics:power-curve")) {
          expect(params).toEqual({
            userId: "user",
            activityIds: [activityA, activityB],
            durations: [1],
          });
          rows = bestPowerRows;
        } else if (statement.includes("cycling-effort:movement-samples")) {
          rows = movementRows;
        } else if (statement.includes("cycling-effort:distance")) {
          rows = [
            { activity_id: activityA, distance_meters: 10 },
            { activity_id: activityB, distance_meters: 20 },
          ];
        } else if (statement.includes("nearby-weight:observations")) {
          expect(params).toEqual({
            userId: "user",
            timezone: "UTC",
            startDate: "2026-06-15",
            endDate: "2026-06-16",
          });
          rows = [
            {
              date: "2026-06-15",
              recorded_at: "2026-06-15T08:00:00.000Z",
              weight_kg: 100,
              provider_id: "scale-b",
              external_id: "weight-b",
            },
            {
              date: "2026-06-16",
              recorded_at: "2026-06-16T08:00:00.000Z",
              weight_kg: 50,
              provider_id: "scale-a",
              external_id: "weight-a",
            },
          ];
        } else {
          throw new Error(`Unexpected query: ${statement}`);
        }
        return schema.array().parse(rows);
      },
    );
    const settingsRow = {
      id: "setting",
      user_id: "user",
      sport: "cycling",
      ftp: 250,
      threshold_hr: 175,
      threshold_pace_per_km: null,
      power_zone_pcts: [0.55, 0.75, 0.9, 1.05, 1.2, 1.5],
      hr_zone_pcts: [0.6, 0.7, 0.8, 0.9],
      pace_zone_pcts: null,
      effective_from: "2026-06-01",
      notes: null,
      created_at: "2026-06-01T00:00:00.000Z",
      updated_at: "2026-06-01T00:00:00.000Z",
    };
    const intervalRows = [
      intervalRow({
        member_activity_id: memberA,
        started_at: "2026-06-16T00:00:00.000Z",
        ended_at: "2026-06-16T00:00:01.000Z",
      }),
      intervalRow({
        member_activity_id: activityB,
        started_at: "2026-06-15T00:00:00.000Z",
        ended_at: "2026-06-15T00:00:01.000Z",
        source_provider: "provider-b",
        source_activity_id: activityB,
      }),
    ];
    const databaseRows: Record<string, unknown>[][] = [[settingsRow], intervalRows];
    const execute = vi.fn(
      async (_query: SQL): Promise<Record<string, unknown>[]> => databaseRows.shift() ?? [],
    );
    const database = { execute } satisfies Pick<Database, "execute">;
    const noProviderMoving = {
      seconds: null,
      status: "not_available" as const,
      evidence: [],
      evidence_count: 0,
      evidence_truncated: false,
    };

    const result = await loadCyclingEffortMetrics(
      database,
      store,
      "user",
      "UTC",
      [
        {
          activity_id: activityA,
          member_activity_ids: [activityA, memberA],
          started_at: "2026-06-16T00:00:00.000Z",
          activityDate: "2026-06-16",
          durationSeconds: 1,
          sourceProviders: ["shared", "activity-a", "shared"],
          movingDuration: noProviderMoving,
        },
        {
          activity_id: activityB,
          member_activity_ids: [activityB],
          started_at: "2026-06-15T00:00:00.000Z",
          activityDate: "2026-06-15",
          durationSeconds: 1,
          sourceProviders: ["activity-b"],
          movingDuration: noProviderMoving,
        },
      ],
      [1],
    );

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      activityId: activityA,
      memberActivityIds: [activityA, memberA],
      activityDate: "2026-06-16",
      metrics: {
        workout: { power: { averageWatts: 100 } },
        movement: { distanceMeters: 10, averageMovingSpeedMetersPerSecond: 10 },
        weight: { value_kg: 50, sources: [{ provider: "scale-a" }] },
        averageWattsPerKg: 2,
        bestPowers: [{ watts: 150, wattsPerKg: 3, powerKind: "estimated" }],
        intervals: [
          {
            evidence: { sourceProvider: "provider-a" },
            source: "provider_recorded",
          },
        ],
        provenance: {
          sourceProviders: ["activity-a", "core-a", "move-a", "shared"],
          sourceDevices: ["bike-a", "speed-a"],
          powerMeasurementKinds: ["direct", "estimated"],
        },
        streamQuality: {
          power: {
            measurementKinds: ["direct"],
            evidence: [
              {
                providerId: "meter-a",
                deviceId: "bike-a",
                measurementKind: "direct",
              },
            ],
          },
          heartRate: {
            measurementKinds: ["direct"],
            evidence: [
              {
                providerId: "strap-a",
                deviceId: "strap-device-a",
                measurementKind: "direct",
              },
            ],
          },
          speed: {
            measurementKinds: ["estimated"],
            evidence: [
              {
                providerId: "move-a",
                deviceId: "speed-a",
                measurementKind: "estimated",
              },
            ],
          },
        },
      },
    });
    expect(result[1]).toMatchObject({
      activityId: activityB,
      metrics: {
        workout: { power: { averageWatts: 200 } },
        movement: { distanceMeters: 20, averageMovingSpeedMetersPerSecond: 20 },
        weight: { value_kg: 100, sources: [{ provider: "scale-b" }] },
        averageWattsPerKg: 2,
        bestPowers: [{ watts: 300, wattsPerKg: 3, powerKind: "direct" }],
        provenance: {
          sourceProviders: ["activity-b", "core-b", "move-b"],
          sourceDevices: ["bike-b", "speed-b"],
          powerMeasurementKinds: ["direct"],
        },
      },
    });
  });
});
