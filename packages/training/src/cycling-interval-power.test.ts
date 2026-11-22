import { describe, expect, it } from "vitest";
import { selectIntervalSamples, summarizeIntervalPower } from "./cycling-interval-power.ts";

describe("summarizeIntervalPower", () => {
  it("excludes the sample at the exclusive end boundary", () => {
    expect(
      summarizeIntervalPower([100, 100, 300], { startOffsetSeconds: 0, endOffsetSeconds: 2 }),
    ).toMatchObject({ averagePowerWatts: 100, startOffsetSeconds: 0, endOffsetSeconds: 2 });
  });

  it("includes the sample at the inclusive start boundary", () => {
    expect(
      summarizeIntervalPower([100, 300, 300], { startOffsetSeconds: 1, endOffsetSeconds: 3 })
        .averagePowerWatts,
    ).toBe(300);
  });

  it("keeps a measured zero and skips missing seconds", () => {
    expect(
      summarizeIntervalPower([0, 0, 0], { startOffsetSeconds: 0, endOffsetSeconds: 3 })
        .averagePowerWatts,
    ).toBe(0);
    expect(
      summarizeIntervalPower([200, null, null, 100], { startOffsetSeconds: 0, endOffsetSeconds: 4 })
        .averagePowerWatts,
    ).toBe(150);
  });

  it("treats a lap ending before the stream as empty, not as a slice from the end", () => {
    expect(
      summarizeIntervalPower([100, 200, 300], { startOffsetSeconds: -40, endOffsetSeconds: -10 }),
    ).toEqual({
      startOffsetSeconds: 0,
      endOffsetSeconds: 0,
      meanPowerWatts: null,
      averagePowerWatts: null,
    });
  });

  it("returns null without measured samples and clips to the stream", () => {
    expect(
      summarizeIntervalPower([null, null], { startOffsetSeconds: 0, endOffsetSeconds: 2 })
        .averagePowerWatts,
    ).toBeNull();
    expect(
      summarizeIntervalPower([100], { startOffsetSeconds: -5, endOffsetSeconds: 50 }),
    ).toMatchObject({ startOffsetSeconds: 0, endOffsetSeconds: 1, averagePowerWatts: 100 });
  });
});

describe("exact lap bounds select 1 Hz timestamps in [start, end)", () => {
  const power = [10, 20, 30, 40, 50];

  it("includes the last eligible sample at t=2 for an end of 2.4", () => {
    expect(
      summarizeIntervalPower(power, { startOffsetSeconds: 0, endOffsetSeconds: 2.4 }),
    ).toMatchObject({ startOffsetSeconds: 0, endOffsetSeconds: 3, averagePowerWatts: 20 });
  });

  it("starts at the first timestamp at or after a fractional start", () => {
    expect(
      summarizeIntervalPower(power, { startOffsetSeconds: 0.5, endOffsetSeconds: 3 }),
    ).toMatchObject({ startOffsetSeconds: 1, endOffsetSeconds: 3, averagePowerWatts: 25 });
  });

  it("partitions touching fractional laps without overlap or loss", () => {
    const first = selectIntervalSamples(5, { startOffsetSeconds: 0, endOffsetSeconds: 2.4 });
    const second = selectIntervalSamples(5, { startOffsetSeconds: 2.4, endOffsetSeconds: 4 });

    expect(first).toEqual({ startOffsetSeconds: 0, endOffsetSeconds: 3 });
    expect(second).toEqual({ startOffsetSeconds: 3, endOffsetSeconds: 4 });
  });

  it.each([
    [2, 2, 2],
    [2, 2.000001, 2],
    [2.000001, 4, 3],
  ])("handles near-exact bounds [%s, %s) for the sample at t=2", (start, end, expectedStart) => {
    const selected = selectIntervalSamples(5, { startOffsetSeconds: start, endOffsetSeconds: end });
    expect(selected.startOffsetSeconds).toBe(expectedStart);
    expect(selected.startOffsetSeconds <= 2 && 2 < selected.endOffsetSeconds).toBe(
      start <= 2 && 2 < end,
    );
  });

  it("returns null power for a valid window that contains no 1 Hz timestamp", () => {
    expect(
      summarizeIntervalPower(power, { startOffsetSeconds: 2.1, endOffsetSeconds: 2.4 }),
    ).toMatchObject({ averagePowerWatts: null, meanPowerWatts: null });
  });
});
