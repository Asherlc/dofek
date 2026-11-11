import { normalizedPower } from "@dofek/cycling-power/power";
import { describe, expect, it } from "vitest";
import {
  type CyclingWorkoutMetricsInput,
  type CyclingWorkoutPowerMetrics,
  type CyclingWorkoutSample,
  computeCyclingPowerWork,
  computeCyclingWorkoutMetrics,
  prepareCyclingWorkoutMetrics,
  resampleCyclingStream,
} from "./cycling-workout-metrics.ts";

const fixtureCoveragePolicy = {
  maximumHoldSeconds: 10,
  minimumGapSeconds: 5,
  gapIntervalMultiplier: 2,
  maximumGapSeconds: 10,
};

const unavailablePower: CyclingWorkoutPowerMetrics = {
  normalizedPowerWatts: null,
  intensityFactor: null,
  trainingStressScore: null,
};

function computeWorkoutFixture(
  input: Omit<CyclingWorkoutMetricsInput, "thresholdWatts" | "coveragePolicy"> & {
    thresholdWatts?: number | null;
  },
  activity: CyclingWorkoutPowerMetrics = unavailablePower,
  intervals: CyclingWorkoutPowerMetrics[] = [],
) {
  const prepared = prepareCyclingWorkoutMetrics({
    coveragePolicy: fixtureCoveragePolicy,
    ...input,
    thresholdWatts: input.thresholdWatts ?? null,
  });
  return computeCyclingWorkoutMetrics(prepared, {
    activity,
    intervals: prepared.intervalInputs.map((_, index) => intervals[index] ?? unavailablePower),
  });
}

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

describe("resampleCyclingStream", () => {
  it("uses the caller's hold policy for sparse observations", () => {
    const result = resampleCyclingStream(
      [
        { elapsedSeconds: 0, powerWatts: 200 },
        { elapsedSeconds: 5, powerWatts: 200 },
      ],
      10,
      (sample) => sample.powerWatts,
      {
        maximumHoldSeconds: 3,
        minimumGapSeconds: 1,
        gapIntervalMultiplier: 2,
        maximumGapSeconds: 3,
      },
    );
    expect(result.coverage.coveredSeconds).toBe(6);
  });
  it.each([1, 5, 0.5])(
    "preserves explicit null barriers across whole and interval power at %s second cadence",
    (cadence) => {
      const samples = Array.from({ length: 60 / cadence }, (_, index) => ({
        elapsedSeconds: index * cadence,
        powerWatts: index * cadence === 30 ? null : 240,
      }));
      const prepared = prepareCyclingWorkoutMetrics({
        coveragePolicy: fixtureCoveragePolicy,
        durationSeconds: 60,
        thresholdWatts: 240,
        settings: null,
        samples,
        intervals: [{ index: 1, type: "work", startOffsetSeconds: 0, endOffsetSeconds: 60 }],
      });
      const policy = {
        maximumHoldSeconds: 10,
        minimumGapSeconds: 5,
        gapIntervalMultiplier: 2,
        maximumGapSeconds: 10,
      };
      const native = samples.map((sample) => ({
        elapsedSeconds: sample.elapsedSeconds,
        watts: sample.powerWatts,
      }));
      expect(prepared.power.coverage.coveredSeconds).toBeLessThan(60);
      expect(prepared.power.coverage.observedSamples).toBe(samples.length - 1);
      expect(normalizedPower(native, 60, policy)).toBeNull();
      const window = prepared.powerWindows[0];
      expect(window).toBeDefined();
      if (!window) throw new Error("Missing interval");
      expect(normalizedPower(window.samples, window.durationSeconds, policy)).toBeNull();
    },
  );

  it("does not treat absent fields on other channels as a barrier", () => {
    const result = resampleCyclingStream(
      [
        { elapsedSeconds: 0, powerWatts: 240 },
        { elapsedSeconds: 0.5, heartRateBpm: 130 },
        { elapsedSeconds: 1, powerWatts: 240 },
      ],
      2,
      (sample) => sample.powerWatts,
      fixtureCoveragePolicy,
    );
    expect(result.values).toEqual([240, 240]);
  });
  it("treats conflicting native values as barriers regardless of sample order", () => {
    const samples = [
      { elapsedSeconds: 0, powerWatts: 240 },
      { elapsedSeconds: 1, powerWatts: 240 },
      { elapsedSeconds: 1, powerWatts: 260 },
      { elapsedSeconds: 2, powerWatts: 240 },
    ];
    const first = resampleCyclingStream(
      samples,
      3,
      (sample) => sample.powerWatts,
      fixtureCoveragePolicy,
    );
    expect(first).toEqual(
      resampleCyclingStream(
        [...samples].reverse(),
        3,
        (sample) => sample.powerWatts,
        fixtureCoveragePolicy,
      ),
    );
    expect(first.values).toEqual([240, null, 240]);
    expect(first.coverage.observedSamples).toBe(2);
  });
  const selectPower = (sample: CyclingWorkoutSample) => sample.powerWatts;

  it("returns duration-aligned missing buckets when the stream is empty", () => {
    const result = resampleCyclingStream([], 3, selectPower, fixtureCoveragePolicy);

    expect(result.values).toEqual([null, null, null]);
    expect(result.maximumValue).toBeNull();
    expect(result.coverage).toEqual({
      observedSamples: 0,
      coveredSeconds: 0,
      missingSeconds: 3,
      zeroSeconds: 0,
      coveragePct: 0,
      medianSampleIntervalSeconds: null,
      largestGapSeconds: null,
    });
  });

  it("preserves a fractional null barrier while excluding out-of-range samples", () => {
    const result = resampleCyclingStream(
      [
        { elapsedSeconds: -1, powerWatts: 999 },
        { elapsedSeconds: 0, powerWatts: 10 },
        { elapsedSeconds: 0.5, powerWatts: null },
        { elapsedSeconds: 1, powerWatts: 20 },
        { elapsedSeconds: 2, powerWatts: 999 },
      ],
      2,
      selectPower,
      fixtureCoveragePolicy,
    );

    expect(result.values).toEqual([null, null]);
    expect(result.maximumValue).toBeNull();
    expect(result.coverage.observedSamples).toBe(2);
  });

  it("preserves the native peak when a lower sample completes the same second", () => {
    const result = resampleCyclingStream(
      [
        { elapsedSeconds: 0, powerWatts: 300 },
        { elapsedSeconds: 0.5, powerWatts: 100 },
      ],
      1,
      selectPower,
      fixtureCoveragePolicy,
    );

    expect(result.values).toEqual([200]);
    expect(result.maximumValue).toBe(300);
    expect(result.coverage.coveredSeconds).toBe(1);
  });

  it("treats an in-range barrier as missing and excludes it from observed samples", () => {
    const result = resampleCyclingStream(
      [
        { elapsedSeconds: 0, powerWatts: 100 },
        { elapsedSeconds: 1, powerWatts: 200 },
      ],
      2,
      selectPower,
      fixtureCoveragePolicy,
      0,
      [0],
    );

    expect(result.values).toEqual([null, 200]);
    expect(result.maximumValue).toBe(200);
    expect(result.coverage).toMatchObject({
      observedSamples: 1,
      coveredSeconds: 1,
      missingSeconds: 1,
    });
  });

  it("ignores barriers outside the activity boundaries", () => {
    const result = resampleCyclingStream(
      [{ elapsedSeconds: 1, powerWatts: 100 }],
      4,
      selectPower,
      fixtureCoveragePolicy,
      0,
      [-1, 4],
    );

    expect(result.values).toEqual([null, 100, null, null]);
    expect(result.coverage).toMatchObject({
      observedSamples: 1,
      coveredSeconds: 1,
      medianSampleIntervalSeconds: null,
      largestGapSeconds: null,
    });
  });

  it("does not report a peak from a partially covered barrier window", () => {
    const result = resampleCyclingStream(
      [{ elapsedSeconds: 0, powerWatts: 300 }],
      1,
      selectPower,
      fixtureCoveragePolicy,
      0,
      [0.5],
    );

    expect(result.values).toEqual([null]);
    expect(result.maximumValue).toBeNull();
    expect(result.coverage).toMatchObject({
      observedSamples: 1,
      coveredSeconds: 0,
      missingSeconds: 1,
    });
  });

  it("bridges a gap exactly at the continuity tolerance", () => {
    const result = resampleCyclingStream(
      [0, 3, 6, 9, 15].map((elapsedSeconds) => ({ elapsedSeconds, powerWatts: 100 })),
      18,
      selectPower,
      fixtureCoveragePolicy,
    );

    expect(result.values).toEqual(Array.from({ length: 18 }, () => 100));
    expect(result.coverage).toMatchObject({
      observedSamples: 5,
      coveredSeconds: 18,
      missingSeconds: 0,
      medianSampleIntervalSeconds: 3,
      largestGapSeconds: 6,
    });
  });

  it("does not bridge a gap beyond the capped continuity tolerance", () => {
    const result = resampleCyclingStream(
      [
        { elapsedSeconds: 0, powerWatts: 100 },
        { elapsedSeconds: 15, powerWatts: 200 },
      ],
      25,
      selectPower,
      fixtureCoveragePolicy,
    );

    expect(result.values).toEqual([
      ...Array.from({ length: 10 }, () => 100),
      ...Array.from({ length: 5 }, () => null),
      ...Array.from({ length: 10 }, () => 200),
    ]);
    expect(result.coverage).toMatchObject({
      coveredSeconds: 20,
      missingSeconds: 5,
      medianSampleIntervalSeconds: 15,
      largestGapSeconds: 15,
    });
  });

  it("accepts coverage exactly at the full-second floating-point tolerance", () => {
    const result = resampleCyclingStream(
      [{ elapsedSeconds: 1e-9, powerWatts: 100 }],
      1,
      selectPower,
      fixtureCoveragePolicy,
    );

    expect(result.values[0]).toBeCloseTo(99.9999999, 8);
    expect(result.maximumValue).toBe(100);
    expect(result.coverage.coveredSeconds).toBe(1);
  });

  it("summarizes gaps without spreading a large native sample stream into arguments", () => {
    const result = resampleCyclingStream(
      Array.from({ length: 150_000 }, (_, index) => ({
        elapsedSeconds: index / 150_000,
        powerWatts: 100,
      })),
      1,
      selectPower,
      fixtureCoveragePolicy,
    );

    expect(result.values[0]).toBeCloseTo(100);
    expect(result.coverage).toMatchObject({ observedSamples: 150_000, coveredSeconds: 1 });
    expect(result.coverage.largestGapSeconds).toBeCloseTo(1 / 150_000);
  });
});

describe("computeCyclingPowerWork", () => {
  it("reports missing power across a huge empty activity window", () => {
    expect(computeCyclingPowerWork([], 10_000_000_000, fixtureCoveragePolicy)).toEqual({
      workKilojoules: null,
      coverage: {
        observedSamples: 0,
        coveredSeconds: 0,
        missingSeconds: 10_000_000_000,
        zeroSeconds: 0,
        coveragePct: 0,
        medianSampleIntervalSeconds: null,
        largestGapSeconds: null,
      },
    });
  });

  it("preserves sparse observations at both ends of a huge activity window", () => {
    const duration = 10_000_000_000;
    const result = computeCyclingPowerWork(
      [
        { elapsedSeconds: 0, powerWatts: 200 },
        { elapsedSeconds: 1, powerWatts: 0 },
        { elapsedSeconds: duration - 2, powerWatts: 300 },
        { elapsedSeconds: duration - 1, powerWatts: 100 },
      ],
      duration,
      fixtureCoveragePolicy,
    );

    expect(result).toEqual({
      workKilojoules: 0.6,
      coverage: {
        observedSamples: 4,
        coveredSeconds: 4,
        missingSeconds: duration - 4,
        zeroSeconds: 1,
        coveragePct: 0,
        medianSampleIntervalSeconds: 1,
        largestGapSeconds: duration - 3,
      },
    });
  });

  it("retains work for a sparse multi-day ride without bridging its dropouts", () => {
    expect(
      computeCyclingPowerWork(
        [
          { elapsedSeconds: 0, powerWatts: 200 },
          { elapsedSeconds: 86_400, powerWatts: 300 },
        ],
        3 * 86_400,
        fixtureCoveragePolicy,
      ),
    ).toEqual({
      workKilojoules: 5,
      coverage: {
        observedSamples: 2,
        coveredSeconds: 20,
        missingSeconds: 3 * 86_400 - 20,
        zeroSeconds: 0,
        coveragePct: 0,
        medianSampleIntervalSeconds: 86_400,
        largestGapSeconds: 86_400,
      },
    });
  });

  it.each<{
    name: string;
    durationSeconds: number;
    samples: CyclingWorkoutSample[];
    barriers?: number[];
  }>([
    { name: "empty power", durationSeconds: 3, samples: [] },
    {
      name: "measured zero",
      durationSeconds: 3,
      samples: [0, 1, 2].map((elapsedSeconds) => ({ elapsedSeconds, powerWatts: 0 })),
    },
    {
      name: "duplicates, invalid values, and activity bounds",
      durationSeconds: 4.9,
      samples: [
        { elapsedSeconds: 3, powerWatts: 200 },
        { elapsedSeconds: -1, powerWatts: 999 },
        { elapsedSeconds: 0, powerWatts: 999 },
        { elapsedSeconds: 0, powerWatts: 100 },
        { elapsedSeconds: 1, powerWatts: -1 },
        { elapsedSeconds: 2, powerWatts: Number.NaN },
        { elapsedSeconds: 4, powerWatts: 999 },
      ],
    },
    {
      name: "sub-second power and a partially covered barrier bucket",
      durationSeconds: 4,
      samples: [
        { elapsedSeconds: 0, powerWatts: 300 },
        { elapsedSeconds: 0.5, powerWatts: 100 },
        { elapsedSeconds: 1, powerWatts: 0 },
        { elapsedSeconds: 2, powerWatts: 400 },
        { elapsedSeconds: 3, powerWatts: 200 },
      ],
      barriers: [-1, 2.5, 4],
    },
    {
      name: "gaps at and beyond continuity tolerance",
      durationSeconds: 27,
      samples: [0, 3, 6, 9, 15, 24].map((elapsedSeconds) => ({
        elapsedSeconds,
        powerWatts: 100,
      })),
    },
    {
      name: "full-second floating-point tolerance",
      durationSeconds: 1,
      samples: [{ elapsedSeconds: 1e-9, powerWatts: 100 }],
    },
  ])(
    "matches full workout work and coverage for $name",
    ({ durationSeconds, samples, barriers }) => {
      const workout = computeWorkoutFixture({
        durationSeconds,
        samples,
        settings: null,
        intervals: [],
        streamBarriers: { power: barriers },
      });

      expect(
        computeCyclingPowerWork(samples, durationSeconds, fixtureCoveragePolicy, barriers),
      ).toEqual({
        workKilojoules: workout.power.workKilojoules,
        coverage: workout.coverage.power,
      });
    },
  );
});

describe("prepared cycling workout metrics", () => {
  it("assembles the supplied activity and interval power calculations without recomputing them", () => {
    const prepared = prepareCyclingWorkoutMetrics({
      coveragePolicy: fixtureCoveragePolicy,
      durationSeconds: 60,
      thresholdWatts: 250,
      samples: constantSamples(60, { powerWatts: 200 }),
      settings: null,
      intervals: [{ index: 7, type: "work", startOffsetSeconds: 10, endOffsetSeconds: 50 }],
    });
    const result = computeCyclingWorkoutMetrics(prepared, {
      activity: { normalizedPowerWatts: 237, intensityFactor: 0.948, trainingStressScore: 1.49784 },
      intervals: [
        { normalizedPowerWatts: 271, intensityFactor: 1.084, trainingStressScore: 1.30562 },
      ],
    });
    expect(result.power).toMatchObject({
      normalizedWatts: 237,
      intensityFactor: 0.948,
      trainingStressScore: 1.49784,
    });
    expect(result.intervals[0]?.normalizedPowerWatts).toBe(271);
  });

  it("preserves explicit missing power at barriers in prepared interval windows", () => {
    const prepared = prepareCyclingWorkoutMetrics({
      coveragePolicy: fixtureCoveragePolicy,
      durationSeconds: 60,
      thresholdWatts: 250,
      samples: constantSamples(60, { powerWatts: 200 }),
      settings: null,
      intervals: [{ index: 7, type: "work", startOffsetSeconds: 10, endOffsetSeconds: 50 }],
      streamBarriers: { power: [20] },
    });
    expect(prepared.powerWindows[0]?.samples[10]).toEqual({ elapsedSeconds: 10, watts: null });
  });

  it("rejects an incomplete set of supplied interval calculations", () => {
    const prepared = prepareCyclingWorkoutMetrics({
      coveragePolicy: fixtureCoveragePolicy,
      durationSeconds: 60,
      thresholdWatts: null,
      samples: [],
      settings: null,
      intervals: [{ index: 7, type: "work", startOffsetSeconds: 10, endOffsetSeconds: 50 }],
    });
    expect(() =>
      computeCyclingWorkoutMetrics(prepared, {
        activity: { normalizedPowerWatts: null, intensityFactor: null, trainingStressScore: null },
        intervals: [],
      }),
    ).toThrow("Every prepared interval requires computed power metrics");
  });

  it("explains unavailable supplied normalized power without claiming complete samples are too short", () => {
    const prepared = prepareCyclingWorkoutMetrics({
      coveragePolicy: fixtureCoveragePolicy,
      durationSeconds: 60,
      thresholdWatts: 250,
      samples: constantSamples(60, { powerWatts: 200 }),
      settings: null,
      intervals: [],
    });
    const result = computeCyclingWorkoutMetrics(prepared, {
      activity: unavailablePower,
      intervals: [],
    });
    expect(result.unavailableReasons).toContainEqual({
      metric: "normalized_power",
      reason: "computed normalized power is unavailable",
    });
  });
});

describe("computeCyclingWorkoutMetrics", () => {
  it("explains unavailable supplied stress fields even with normalized power and a threshold", () => {
    const result = computeWorkoutFixture(
      {
        durationSeconds: 60,
        thresholdWatts: 250,
        samples: constantSamples(60, { powerWatts: 220 }),
        settings: null,
        intervals: [],
      },
      { normalizedPowerWatts: 220, intensityFactor: null, trainingStressScore: null },
    );
    expect(result.unavailableReasons).toContainEqual({
      metric: "intensity_factor",
      reason: "computed intensity factor is unavailable",
    });
    expect(result.unavailableReasons).toContainEqual({
      metric: "training_stress_score",
      reason: "computed training stress score is unavailable",
    });
  });
  it("averages sequential sub-second observations using their covered durations", () => {
    const result = computeWorkoutFixture(
      {
        durationSeconds: 60,
        samples: Array.from({ length: 120 }, (_, index) => ({
          elapsedSeconds: index / 2,
          powerWatts: index % 2 ? 300 : 100,
          heartRateBpm: index % 2 ? 180 : 120,
        })),
        settings: null,
        intervals: [],
      },
      { normalizedPowerWatts: 200, intensityFactor: null, trainingStressScore: null },
    );
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
    const result = computeWorkoutFixture({
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
    const result = computeWorkoutFixture(
      {
        durationSeconds: 3_600,
        thresholdWatts: 250,
        samples: constantSamples(3_600, {
          powerWatts: 200,
          heartRateBpm: 140,
          cadenceRpm: 90,
        }),
        settings: {
          thresholdHeartRateBpm: 175,
          powerZoneUpperPcts: [0.55, 0.75, 0.9, 1.05, 1.2, 1.5],
          heartRateZoneUpperPcts: [0.6, 0.7, 0.8, 0.9],
        },
        intervals: [],
      },
      { normalizedPowerWatts: 200, intensityFactor: 0.8, trainingStressScore: 64 },
    );

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
    const result = computeWorkoutFixture(
      {
        durationSeconds: 600,
        samples: constantSamples(600, { powerWatts: 180, heartRateBpm: 130, cadenceRpm: 85 }, 5),
        settings: null,
        intervals: [],
      },
      { normalizedPowerWatts: 180, intensityFactor: null, trainingStressScore: null },
    );

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

  it("sorts irregular samples while preserving invalid-value barriers", () => {
    const result = computeWorkoutFixture({
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
      coveredSeconds: 8,
      missingSeconds: 4,
      zeroSeconds: 0,
      coveragePct: 66.7,
      medianSampleIntervalSeconds: 2,
      largestGapSeconds: 2,
    });
    expect(result.power.averageWatts).toBe(175);
  });

  it("preserves measured zero power and reports a dropout as missing rather than zero", () => {
    const samples: CyclingWorkoutSample[] = [
      ...constantSamples(30, { powerWatts: 0 }),
      ...constantSamples(30, { powerWatts: 200 }).map((sample) => ({
        ...sample,
        elapsedSeconds: sample.elapsedSeconds + 40,
      })),
    ];
    const result = computeWorkoutFixture({
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
    const result = computeWorkoutFixture(
      {
        durationSeconds: 300,
        samples: constantSamples(300, { powerWatts: 210 }),
        settings: null,
        intervals: [],
      },
      { normalizedPowerWatts: 210, intensityFactor: null, trainingStressScore: null },
    );

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
        {
          metric: "intensity_factor",
          reason: "no computed threshold is available for this activity",
        },
        {
          metric: "training_stress_score",
          reason: "no computed threshold is available for this activity",
        },
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
    const result = computeWorkoutFixture(
      {
        durationSeconds: 2_400,
        samples,
        settings: null,
        intervals: [],
      },
      { normalizedPowerWatts: 200, intensityFactor: null, trainingStressScore: null },
    );

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
    const result = computeWorkoutFixture(
      {
        durationSeconds: 360,
        samples,
        thresholdWatts: 250,
        settings: null,
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
      },
      { normalizedPowerWatts: 227.9, intensityFactor: 0.912, trainingStressScore: 8.3 },
      [{ normalizedPowerWatts: 300, intensityFactor: null, trainingStressScore: null }],
    );

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
    const result = computeWorkoutFixture(
      {
        durationSeconds: 900,
        samples,
        thresholdWatts: 250,
        settings: null,
        intervals: [],
      },
      { normalizedPowerWatts: 216, intensityFactor: 0.864, trainingStressScore: 18.7 },
      [
        { normalizedPowerWatts: 300, intensityFactor: null, trainingStressScore: null },
        { normalizedPowerWatts: 120, intensityFactor: null, trainingStressScore: null },
        { normalizedPowerWatts: 300, intensityFactor: null, trainingStressScore: null },
      ],
    );

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
    const result = computeWorkoutFixture(
      {
        durationSeconds: 300,
        samples: Array.from({ length: 300 }, (_, elapsedSeconds) => ({
          elapsedSeconds,
          powerWatts: elapsedSeconds >= 100 && elapsedSeconds < 120 ? 400 : 120,
        })),
        thresholdWatts: 250,
        settings: null,
        intervals: [],
      },
      { normalizedPowerWatts: 174.2, intensityFactor: 0.697, trainingStressScore: 4 },
    );

    expect(result).toMatchSnapshot();
    expect(result.intervalSource).toBe("none");
    expect(result.intervals).toEqual([]);
    expect(result.intervalDetection).toBeNull();
  });
});
