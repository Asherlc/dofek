import { describe, expect, it } from "vitest";
import { summarizeCyclingDecoupling } from "./cycling-decoupling.ts";

describe("summarizeCyclingDecoupling", () => {
  it.each([
    [100, 125, 20],
    [100, 100, 0],
    [125, 100, -25],
  ])("compares the paired ratios at %i and %i bpm", (first, second, percent) => {
    const power = Array<number>(1200).fill(200);
    const heartRate = Array<number>(1200).fill(second).fill(first, 0, 600);
    expect(summarizeCyclingDecoupling(power, heartRate).percent).toBe(percent);
  });

  it("counts recorded zero power and excludes invalid or missing pairs", () => {
    const power = Array<number | null>(1200).fill(200);
    const heartRate = Array<number | null>(1200).fill(100);
    power[0] = 0;
    power[1] = null;
    heartRate[2] = Number.NaN;
    expect(summarizeCyclingDecoupling(power, heartRate).firstHalf).toMatchObject({
      pairedSeconds: 598,
      meanWatts: 199.7,
      meanBpm: 100,
      coveragePct: 99.7,
    });
    expect(summarizeCyclingDecoupling(power.fill(0, 0, 600), heartRate).percent).toBeNull();
  });

  it.each([0, 600])("requires coverage in the half starting at second %i", (start) => {
    const power = Array<number | null>(1200)
      .fill(200)
      .fill(null, start, start + 66);
    expect(summarizeCyclingDecoupling(power, Array<number>(1200).fill(100)).percent).toBeNull();
  });

  it.each([
    ["negative power", (power: Array<number | null>) => (power[0] = -1)],
    ["infinite power", (power: Array<number | null>) => (power[0] = Number.POSITIVE_INFINITY)],
    ["missing power", (power: Array<number | null>) => (power[0] = null)],
  ])("excludes %s from the paired samples", (_name, mutate) => {
    const power = Array<number | null>(1200).fill(200);
    mutate(power);
    expect(
      summarizeCyclingDecoupling(power, Array<number>(1200).fill(100)).firstHalf.pairedSeconds,
    ).toBe(599);
  });

  it.each([
    ["zero heart rate", 0],
    ["negative heart rate", -5],
    ["infinite heart rate", Number.POSITIVE_INFINITY],
    ["missing heart rate", null],
  ])("excludes %s from the paired samples", (_name, bpm) => {
    const heartRate = Array<number | null>(1200).fill(100);
    heartRate[0] = bpm;
    expect(
      summarizeCyclingDecoupling(Array<number>(1200).fill(200), heartRate).firstHalf.pairedSeconds,
    ).toBe(599);
  });

  it("requires at least 1,200 elapsed seconds", () => {
    const heartRate = (length: number) =>
      Array<number>(length)
        .fill(100)
        .fill(125, length / 2);
    expect(
      summarizeCyclingDecoupling(Array<number>(1198).fill(200), heartRate(1198)).percent,
    ).toBeNull();
    expect(summarizeCyclingDecoupling(Array<number>(1200).fill(200), heartRate(1200)).percent).toBe(
      20,
    );
  });

  it("accepts coverage of exactly 90% in each half and rejects less", () => {
    const heartRate = Array<number>(1200).fill(100);
    const withGap = (start: number, count: number) =>
      Array<number | null>(1200)
        .fill(200)
        .fill(null, start, start + count);
    expect(summarizeCyclingDecoupling(withGap(0, 60), heartRate).percent).toBe(0);
    expect(summarizeCyclingDecoupling(withGap(600, 60), heartRate).percent).toBe(0);
    expect(summarizeCyclingDecoupling(withGap(0, 61), heartRate).percent).toBeNull();
    expect(summarizeCyclingDecoupling(withGap(600, 61), heartRate).percent).toBeNull();
  });

  it("gives the extra elapsed second of an odd-length ride to the second half", () => {
    const result = summarizeCyclingDecoupling(
      Array<number>(1201).fill(200),
      Array<number>(1201).fill(100),
    );
    expect(result.firstHalf.pairedSeconds).toBe(600);
    expect(result.secondHalf.pairedSeconds).toBe(601);
    expect(result.secondHalf.coveragePct).toBe(100);
  });

  it("reports empty halves as unknown rather than zero", () => {
    const result = summarizeCyclingDecoupling([], []);
    expect(result.percent).toBeNull();
    expect(result.firstHalf).toEqual({
      ratio: null,
      pairedSeconds: 0,
      meanWatts: null,
      meanBpm: null,
      coveragePct: 0,
    });
  });
});
