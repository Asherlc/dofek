import { describe, expect, it } from "vitest";
import {
  type CyclingWorkoutSample,
  computeCyclingWorkoutMetrics,
} from "./cycling-workout-metrics.ts";

function constantSamples(
  durationSeconds: number,
  values: { powerWatts?: number; heartRateBpm?: number; cadenceRpm?: number },
  intervalSeconds = 1,
): CyclingWorkoutSample[] {
  return Array.from({ length: Math.ceil(durationSeconds / intervalSeconds) }, (_, index) => ({
    elapsedSeconds: index * intervalSeconds,
    ...values,
  }));
}

describe("computeCyclingWorkoutMetrics", () => {
  it("averages sequential subsecond observations using their covered durations", () => {
    const result = computeCyclingWorkoutMetrics({
      durationSeconds: 60,
      samples: Array.from({ length: 120 }, (_, index) => ({
        elapsedSeconds: index / 2,
        powerWatts: index % 2 ? 300 : 100,
        heartRateBpm: index % 2 ? 180 : 120,
      })),
      settings: null,
      intervals: [],
    });
    expect(result.coverage.power).toMatchObject({
      observedSamples: 120,
      coveredSeconds: 60,
      medianSampleIntervalSeconds: 0.5,
    });
    expect(result.power).toMatchObject({
      averageWatts: 200,
      normalizedWatts: 200,
      workKilojoules: 12,
    });
    expect(result.heartRate).toEqual({ averageBpm: 150, maximumBpm: 180 });
  });
  it("does not extrapolate sparse native observations across multi-minute dropouts", () => {
    const result = computeCyclingWorkoutMetrics({
      durationSeconds: 1800,
      samples: [
        { elapsedSeconds: 0, powerWatts: 200 },
        { elapsedSeconds: 600, powerWatts: 200 },
      ],
      settings: null,
      intervals: [],
    });
    expect(result.coverage.power.coveredSeconds).toBe(20);
    expect(result.coverage.power.largestGapSeconds).toBe(600);
    expect(result.power.workKilojoules).toBe(4);
    expect(result.power.normalizedWatts).toBeNull();
  });
  it("computes complete one-hertz power, load, zones, and evidence", () => {
    const result = computeCyclingWorkoutMetrics({
      durationSeconds: 3_600,
      samples: constantSamples(3_600, {
        powerWatts: 200,
        heartRateBpm: 140,
        cadenceRpm: 90,
      }),
      settings: {
        ftpWatts: 250,
        thresholdHeartRateBpm: 175,
        powerZoneUpperPcts: [0.55, 0.75, 0.9, 1.05, 1.2, 1.5],
        heartRateZoneUpperPcts: [0.6, 0.7, 0.8, 0.9],
      },
      intervals: [],
    });

    expect(result).toMatchSnapshot();
    expect(result.power).toMatchObject({
      averageWatts: 200,
      normalizedWatts: 200,
      variabilityIndex: 1,
      workKilojoules: 720,
      intensityFactor: 0.8,
      trainingStressScore: 64,
    });
    expect(result.heartRate).toMatchObject({ averageBpm: 140, maximumBpm: 140 });
    expect(result.cadence.averageRpm).toBe(90);
    expect(result.aerobicEfficiency.powerToHeartRateRatio).toBeCloseTo(200 / 140, 3);
    expect(result.coverage.power).toMatchObject({
      observedSamples: 3_600,
      coveredSeconds: 3_600,
      missingSeconds: 0,
      coveragePct: 100,
      medianSampleIntervalSeconds: 1,
      largestGapSeconds: 1,
    });
    expect(result.powerZones?.zones).toEqual([
      { zone: 1, seconds: 0, percent: 0 },
      { zone: 2, seconds: 0, percent: 0 },
      { zone: 3, seconds: 3_600, percent: 100 },
      { zone: 4, seconds: 0, percent: 0 },
      { zone: 5, seconds: 0, percent: 0 },
      { zone: 6, seconds: 0, percent: 0 },
      { zone: 7, seconds: 0, percent: 0 },
    ]);
    expect(result.unavailableReasons).toEqual([]);
  });

  it("supports native five-second sampling without treating resampled seconds as observations", () => {
    const result = computeCyclingWorkoutMetrics({
      durationSeconds: 600,
      samples: constantSamples(600, { powerWatts: 180, heartRateBpm: 130, cadenceRpm: 85 }, 5),
      settings: null,
      intervals: [],
    });

    expect(result).toMatchSnapshot();
    expect(result.power.averageWatts).toBe(180);
    expect(result.power.normalizedWatts).toBe(180);
    expect(result.coverage.power).toMatchObject({
      observedSamples: 120,
      coveredSeconds: 600,
      missingSeconds: 0,
      coveragePct: 100,
      medianSampleIntervalSeconds: 5,
      largestGapSeconds: 5,
    });
  });

  it("sorts irregular samples while excluding invalid and out-of-range observations", () => {
    const result = computeCyclingWorkoutMetrics({
      durationSeconds: 12,
      samples: [
        { elapsedSeconds: 10, powerWatts: 100 },
        { elapsedSeconds: 0, powerWatts: 100 },
        { elapsedSeconds: 6, powerWatts: 300 },
        { elapsedSeconds: 2, powerWatts: 200 },
        { elapsedSeconds: 4, powerWatts: null },
        { elapsedSeconds: 8, powerWatts: Number.NaN },
        { elapsedSeconds: 9, powerWatts: -1 },
        { elapsedSeconds: -1, powerWatts: 999 },
        { elapsedSeconds: 12, powerWatts: 999 },
      ],
      settings: null,
      intervals: [],
    });

    expect(result).toMatchSnapshot();
    expect(result.coverage.power).toEqual({
      observedSamples: 4,
      coveredSeconds: 12,
      missingSeconds: 0,
      zeroSeconds: 0,
      coveragePct: 100,
      medianSampleIntervalSeconds: 4,
      largestGapSeconds: 4,
    });
    expect(result.power.averageWatts).toBe(200);
  });

  it("preserves measured zero power and reports a dropout as missing rather than zero", () => {
    const samples: CyclingWorkoutSample[] = [
      ...constantSamples(30, { powerWatts: 0 }),
      ...constantSamples(30, { powerWatts: 200 }).map((sample) => ({
        ...sample,
        elapsedSeconds: sample.elapsedSeconds + 40,
      })),
    ];
    const result = computeCyclingWorkoutMetrics({
      durationSeconds: 70,
      samples,
      settings: null,
      intervals: [],
    });

    expect(result.coverage.power).toMatchObject({
      coveredSeconds: 60,
      missingSeconds: 10,
      zeroSeconds: 30,
      coveragePct: 85.7,
    });
    expect(result.power.averageWatts).toBe(100);
    expect(result.power.workKilojoules).toBe(6);
    expect(result.power.normalizedWatts).toBeNull();
    expect(result.unavailableReasons).toContainEqual({
      metric: "normalized_power",
      reason: "power coverage is below 90%",
    });
  });

  it("does not manufacture FTP-dependent metrics or heart-rate metrics", () => {
    const result = computeCyclingWorkoutMetrics({
      durationSeconds: 300,
      samples: constantSamples(300, { powerWatts: 210 }),
      settings: null,
      intervals: [],
    });

    expect(result).toMatchSnapshot();
    expect(result.power).toMatchObject({
      averageWatts: 210,
      normalizedWatts: 210,
      intensityFactor: null,
      trainingStressScore: null,
    });
    expect(result.heartRate).toEqual({ averageBpm: null, maximumBpm: null });
    expect(result.aerobicEfficiency.powerToHeartRateRatio).toBeNull();
    expect(result.cardiacDrift).toMatchObject({ percent: null });
    expect(result.unavailableReasons).toEqual(
      expect.arrayContaining([
        { metric: "intensity_factor", reason: "no valid FTP was effective for this activity" },
        { metric: "training_stress_score", reason: "no valid FTP was effective for this activity" },
        { metric: "heart_rate", reason: "no heart-rate samples are available" },
        {
          metric: "aerobic_efficiency",
          reason: "no synchronized power and heart-rate samples are available",
        },
      ]),
    );
  });

  it("computes cardiac drift from equal elapsed halves when paired coverage is sufficient", () => {
    const samples = Array.from({ length: 2_400 }, (_, elapsedSeconds) => ({
      elapsedSeconds,
      powerWatts: 200,
      heartRateBpm: elapsedSeconds < 1_200 ? 140 : 154,
      cadenceRpm: 90,
    }));
    const result = computeCyclingWorkoutMetrics({
      durationSeconds: 2_400,
      samples,
      settings: null,
      intervals: [],
    });

    expect(result).toMatchSnapshot();
    expect(result.cardiacDrift).toEqual({
      percent: 9.1,
      firstHalfPowerToHeartRate: 1.429,
      secondHalfPowerToHeartRate: 1.299,
      pairedSeconds: 2_400,
      method: "equal_elapsed_time_halves_power_to_heart_rate",
    });
  });

  it("uses recorded interval boundaries and targets without relabeling them as inferred", () => {
    const samples = Array.from({ length: 360 }, (_, elapsedSeconds) => ({
      elapsedSeconds,
      powerWatts: elapsedSeconds >= 60 && elapsedSeconds < 180 ? 300 : 100,
      heartRateBpm: elapsedSeconds >= 60 && elapsedSeconds < 180 ? 165 : 120,
      cadenceRpm: elapsedSeconds >= 60 && elapsedSeconds < 180 ? 95 : 75,
    }));
    const result = computeCyclingWorkoutMetrics({
      durationSeconds: 360,
      samples,
      settings: { ftpWatts: 250 },
      intervals: [
        {
          index: 1,
          type: "work",
          label: "2 min at 300 W",
          startOffsetSeconds: 60,
          endOffsetSeconds: 180,
          targetPowerWatts: 300,
        },
      ],
    });

    expect(result).toMatchSnapshot();
    expect(result.intervalSource).toBe("recorded");
    expect(result.intervals).toHaveLength(1);
    expect(result.intervals[0]).toMatchObject({
      index: 1,
      type: "work",
      source: "recorded",
      durationSeconds: 120,
      averagePowerWatts: 300,
      averageHeartRateBpm: 165,
      averageCadenceRpm: 95,
      targetPowerWatts: 300,
      completionPct: 100,
    });
  });

  it("detects sustained work intervals but never invents a target", () => {
    const samples = Array.from({ length: 900 }, (_, elapsedSeconds) => ({
      elapsedSeconds,
      powerWatts:
        (elapsedSeconds >= 120 && elapsedSeconds < 240) ||
        (elapsedSeconds >= 360 && elapsedSeconds < 480)
          ? 300
          : 120,
      heartRateBpm:
        (elapsedSeconds >= 120 && elapsedSeconds < 240) ||
        (elapsedSeconds >= 360 && elapsedSeconds < 480)
          ? 160
          : 125,
    }));
    const result = computeCyclingWorkoutMetrics({
      durationSeconds: 900,
      samples,
      settings: { ftpWatts: 250 },
      intervals: [],
    });

    expect(result).toMatchSnapshot();
    expect(result.intervalSource).toBe("inferred");
    expect(result.intervals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "work",
          source: "inferred",
          averagePowerWatts: 300,
          targetPowerWatts: null,
          completionPct: null,
        }),
        expect.objectContaining({
          type: "recovery",
          source: "inferred",
          startOffsetSeconds: 240,
          endOffsetSeconds: 360,
          targetPowerWatts: null,
          completionPct: null,
        }),
      ]),
    );
    expect(result.intervalDetection).toMatchObject({
      method: "30_second_average_above_105_percent_ftp",
      thresholdWatts: 262.5,
      minimumWorkSeconds: 30,
    });
  });

  it("does not call a sub-30-second power spike an interval", () => {
    const result = computeCyclingWorkoutMetrics({
      durationSeconds: 300,
      samples: Array.from({ length: 300 }, (_, elapsedSeconds) => ({
        elapsedSeconds,
        powerWatts: elapsedSeconds >= 100 && elapsedSeconds < 120 ? 400 : 120,
      })),
      settings: { ftpWatts: 250 },
      intervals: [],
    });

    expect(result).toMatchSnapshot();
    expect(result.intervalSource).toBe("none");
    expect(result.intervals).toEqual([]);
    expect(result.intervalDetection).toBeNull();
  });
});
