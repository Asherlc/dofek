import { describe, expect, it } from "vitest";
import {
  buildKarvonenIntensityDistribution,
  buildTreffPolarizationWeek,
  DEFAULT_POLARIZATION_THRESHOLD,
} from "./training-distribution.ts";

describe("buildKarvonenIntensityDistribution", () => {
  it("returns server-ready totals and percentages for every Karvonen zone", () => {
    const result = buildKarvonenIntensityDistribution([
      {
        zone0: 100,
        zone1: 200,
        zone2: 300,
        zone3: 150,
        zone4: 50,
        zone5: 200,
      },
      {
        zone0: 0,
        zone1: 100,
        zone2: 100,
        zone3: 100,
        zone4: 100,
        zone5: 0,
      },
    ]);

    expect(result).toEqual({
      model: "karvonen-five-zone",
      activityScope: "endurance",
      totalSeconds: 1400,
      zones: [
        { zone: 0, label: "Below Zone 1", seconds: 100, percent: 7.1 },
        { zone: 1, label: "Recovery", seconds: 300, percent: 21.4 },
        { zone: 2, label: "Aerobic", seconds: 400, percent: 28.6 },
        { zone: 3, label: "Tempo", seconds: 250, percent: 17.9 },
        { zone: 4, label: "Threshold", seconds: 150, percent: 10.7 },
        { zone: 5, label: "VO2max", seconds: 200, percent: 14.3 },
      ],
      explanation:
        "A descriptive view of endurance training time across the Karvonen five-zone heart-rate model.",
    });
  });

  it("returns zero percentages when no zone time is available", () => {
    const result = buildKarvonenIntensityDistribution([]);

    expect(result.totalSeconds).toBe(0);
    expect(result.zones.map((zone) => zone.percent)).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

describe("buildTreffPolarizationWeek", () => {
  it("classifies only an index strictly above the shared threshold as polarized", () => {
    expect(
      buildTreffPolarizationWeek({
        week: "2026-07-06",
        z1Seconds: 60,
        z2Seconds: 15,
        z3Seconds: 25,
        polarizationIndex: DEFAULT_POLARIZATION_THRESHOLD,
      }),
    ).toMatchObject({
      status: "not_polarized",
      statusLabel: "Does not match polarized-pattern heuristic",
    });

    expect(
      buildTreffPolarizationWeek({
        week: "2026-07-13",
        z1Seconds: 60,
        z2Seconds: 14.995,
        z3Seconds: 25.005,
        polarizationIndex: 2.0002316,
      }),
    ).toMatchObject({
      status: "polarized",
      statusLabel: "Matches polarized-pattern heuristic",
      polarizationIndex: 2,
    });
  });

  it("returns a numeric index without labeling an easy and high tie polarized", () => {
    expect(
      buildTreffPolarizationWeek({
        week: "2026-07-06",
        z1Seconds: 49.5,
        z2Seconds: 1,
        z3Seconds: 49.5,
        polarizationIndex: 3.3892104,
      }),
    ).toMatchObject({ polarizationIndex: 3.389, status: "not_polarized" });
  });

  it("returns an explicit insufficient-data status when the index cannot be computed", () => {
    const result = buildTreffPolarizationWeek({
      week: "2026-07-20",
      z1Seconds: 99,
      z2Seconds: 0,
      z3Seconds: 1,
      polarizationIndex: null,
    });

    expect(result).toMatchObject({
      totalSeconds: 100,
      zonePercentages: { z1: 99, z2: 0, z3: 1 },
      status: "insufficient_data",
      statusLabel: "Not calculated",
      explanation: expect.stringContaining("more than 1%"),
    });
  });

  it("explains the Treff validity condition when Zone 3 exceeds Zone 1", () => {
    const result = buildTreffPolarizationWeek({
      week: "2026-07-20",
      z1Seconds: 1200,
      z2Seconds: 600,
      z3Seconds: 1800,
      polarizationIndex: null,
    });

    expect(result).toMatchObject({
      status: "insufficient_data",
      statusLabel: "Not calculated",
      explanation:
        "The index is not calculated because recorded Zone 3 time exceeds Zone 1, which is outside Treff's valid definition.",
    });
  });

  it("does not treat Zone 3 equal to Zone 1 as the invalid Zone 3 > Zone 1 case", () => {
    expect(
      buildTreffPolarizationWeek({
        week: "2026-07-20",
        z1Seconds: 50,
        z2Seconds: 0,
        z3Seconds: 50,
        polarizationIndex: null,
      }).explanation,
    ).toBe("With zero middle-zone time, Treff's adjustment requires more than 1% high-zone time.");
  });

  it("explains an empty week", () => {
    expect(
      buildTreffPolarizationWeek({
        week: "2026-07-20",
        z1Seconds: 0,
        z2Seconds: 0,
        z3Seconds: 0,
        polarizationIndex: null,
      }).explanation,
    ).toBe("This week has no recorded cycling heart-rate coverage in the selected dates.");
  });

  it("uses the generic explanation when the index is unavailable for other reasons", () => {
    const base = { week: "2026-07-20", polarizationIndex: null };
    const generic = "The index is unavailable for this distribution.";
    expect(
      buildTreffPolarizationWeek({ ...base, z1Seconds: 80, z2Seconds: 0, z3Seconds: 0 })
        .explanation,
    ).toBe(generic);
    expect(
      buildTreffPolarizationWeek({ ...base, z1Seconds: 80, z2Seconds: 10, z3Seconds: 10 })
        .explanation,
    ).toBe(generic);
  });

  it("requires strict easy > high > middle ordering to label a week polarized", () => {
    const ordering =
      "Treff's polarized pattern requires easy-zone time to exceed high-zone time, with the least time in the middle zone.";
    const week = (z1Seconds: number, z2Seconds: number, z3Seconds: number) =>
      buildTreffPolarizationWeek({
        week: "2026-07-20",
        z1Seconds,
        z2Seconds,
        z3Seconds,
        polarizationIndex: 2.5,
      });

    // high == middle
    expect(week(60, 20, 20)).toMatchObject({ status: "not_polarized", explanation: ordering });
    // easy == high
    expect(week(40, 20, 40)).toMatchObject({ status: "not_polarized", explanation: ordering });
    // middle largest
    expect(week(20, 60, 20)).toMatchObject({ status: "not_polarized", explanation: ordering });
    expect(week(60, 10, 30)).toMatchObject({ status: "polarized" });
  });

  it("returns layman-readable percentages and an explanation for a computed week", () => {
    const result = buildTreffPolarizationWeek({
      week: "2026-07-20",
      z1Seconds: 4800,
      z2Seconds: 300,
      z3Seconds: 900,
      polarizationIndex: 2.123,
    });

    expect(result).toMatchObject({
      totalSeconds: 6000,
      zonePercentages: { z1: 80, z2: 5, z3: 15 },
      explanation:
        "This week's recorded cycling distribution is above Treff's descriptive 2.00 heuristic.",
    });
  });
});
