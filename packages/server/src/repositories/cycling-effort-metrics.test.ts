import { describe, expect, it } from "vitest";
import { cyclingEffortMetricsSchema } from "../mcp/performance-comparison-output.ts";
import {
  calculateCyclingEffortMetrics,
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

describe("calculateCyclingEffortMetrics", () => {
  it("treats sequential 2Hz samples as observations and integrates their native durations", () => {
    const result = calculateCyclingEffortMetrics(
      Array.from({ length: 120 }, (_, index) => ({
        elapsedSeconds: index / 2,
        powerWatts: index % 2 === 0 ? 100 : 300,
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
});
