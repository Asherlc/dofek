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
        "A descriptive view of endurance training time across the Karvonen five-zone heart-rate model. It does not classify training polarization.",
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
        z1Seconds: 1,
        z2Seconds: 10,
        z3Seconds: 10,
        polarizationIndex: DEFAULT_POLARIZATION_THRESHOLD,
      }),
    ).toMatchObject({
      status: "not_polarized",
      statusLabel: "Does not match polarized-pattern heuristic",
    });

    expect(
      buildTreffPolarizationWeek({
        week: "2026-07-13",
        z1Seconds: 1,
        z2Seconds: 10,
        z3Seconds: 10,
        polarizationIndex: DEFAULT_POLARIZATION_THRESHOLD + 0.001,
      }),
    ).toMatchObject({
      status: "polarized",
      statusLabel: "Matches polarized-pattern heuristic",
    });
  });

  it("returns an explicit insufficient-data status when the index cannot be computed", () => {
    const result = buildTreffPolarizationWeek({
      week: "2026-07-20",
      z1Seconds: 3600,
      z2Seconds: 0,
      z3Seconds: 600,
      polarizationIndex: null,
    });

    expect(result).toMatchObject({
      totalSeconds: 4200,
      zonePercentages: { z1: 85.7, z2: 0, z3: 14.3 },
      status: "insufficient_data",
      statusLabel: "Not calculated",
      explanation:
        "The index is not calculated because Dofek requires recorded cycling time in all three Treff heart-rate zones.",
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

  it("returns layman-readable percentages and an explanation for a computed week", () => {
    const result = buildTreffPolarizationWeek({
      week: "2026-07-20",
      z1Seconds: 4800,
      z2Seconds: 600,
      z3Seconds: 600,
      polarizationIndex: 2.123,
    });

    expect(result).toMatchObject({
      totalSeconds: 6000,
      zonePercentages: { z1: 80, z2: 10, z3: 10 },
      explanation:
        "This week's recorded cycling distribution is above Treff's descriptive 2.00 heuristic. It is not a physiological or medical assessment.",
    });
  });
});
