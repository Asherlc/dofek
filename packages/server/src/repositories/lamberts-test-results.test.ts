import { describe, expect, it } from "vitest";
import type { CyclingEffortSample } from "./cycling-effort-metrics.ts";
import { calculateLambertsTestResults } from "./lamberts-test-results.ts";

function testSamples(): CyclingEffortSample[] {
  return Array.from({ length: 1_020 }, (_, elapsedSeconds) => {
    const recovery = elapsedSeconds >= 930;
    const powerWatts =
      elapsedSeconds < 60 ||
      (elapsedSeconds >= 360 && elapsedSeconds < 450) ||
      (elapsedSeconds >= 750 && elapsedSeconds < 810)
        ? 800
        : elapsedSeconds < 360
          ? 120
          : elapsedSeconds < 750
            ? 225
            : 280;
    return {
      elapsedSeconds,
      powerWatts: recovery ? 0 : powerWatts,
      heartRateBpm: elapsedSeconds >= 974 ? 125 : elapsedSeconds >= 914 ? 170 : 155,
      cadenceRpm: recovery ? 0 : 90,
      speedMetersPerSecond: recovery ? 0 : 8,
    };
  });
}

describe("calculateLambertsTestResults", () => {
  it("uses only the prescribed stage and recovery windows", () => {
    const result = calculateLambertsTestResults(testSamples());
    expect(result.stages.map((stage) => stage.mean_power_watts)).toEqual([120, 225, 280]);
    expect(result.stages[0]).toMatchObject({
      stage: 1,
      target_maximum_heart_rate_pct: 60,
      mean_cadence_rpm: 90,
      mean_speed_meters_per_second: 8,
      perceived_exertion: null,
    });
    expect(result.recovery).toEqual({
      observed_heart_rate_drop_bpm: 45,
      non_pedaling: true,
      seated_upright: null,
    });
  });

  it("withholds a stage mean for a dropped channel while keeping the other observed metrics", () => {
    const samples = testSamples().map((sample) =>
      sample.elapsedSeconds >= 450 && sample.elapsedSeconds < 470
        ? { ...sample, powerWatts: null }
        : sample,
    );
    const result = calculateLambertsTestResults(samples);
    expect(result.stages.map((stage) => stage.mean_power_watts)).toEqual([120, null, 280]);
    expect(result.stages[1]?.mean_heart_rate_bpm).toBe(155);
  });

  it("withholds the recovery drop when pedaling is recorded or cadence is unobserved", () => {
    const pedaling = testSamples().map((sample) =>
      sample.elapsedSeconds === 975 ? { ...sample, cadenceRpm: 60 } : sample,
    );
    expect(calculateLambertsTestResults(pedaling).recovery).toMatchObject({
      observed_heart_rate_drop_bpm: null,
      non_pedaling: false,
    });
    const noCadence = testSamples().map(({ cadenceRpm: _cadence, ...sample }) => sample);
    expect(calculateLambertsTestResults(noCadence).recovery).toMatchObject({
      observed_heart_rate_drop_bpm: null,
      non_pedaling: null,
    });
  });

  it("keeps the start of recovery unknown when cadence starts after the stage boundary", () => {
    const samples = testSamples().map((sample) => {
      if (sample.elapsedSeconds !== 930) return sample;
      const { cadenceRpm: _cadence, ...otherSamples } = sample;
      return otherSamples;
    });
    expect(calculateLambertsTestResults(samples).recovery).toMatchObject({
      observed_heart_rate_drop_bpm: null,
      non_pedaling: null,
    });
  });
});
