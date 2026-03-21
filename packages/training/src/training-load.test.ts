import { describe, expect, it } from "vitest";
import {
  type ActivityRow,
  buildTssModel,
  computeHrTss,
  computePowerTss,
  computeTrimp,
  estimateFtp,
} from "./training-load.ts";

describe("computeTrimp", () => {
  it("computes Bannister TRIMP from HR data", () => {
    // 60 min, avgHr=150, maxHr=190, restingHr=50, default constants
    const trimp = computeTrimp(60, 150, 190, 50);
    expect(trimp).toBeGreaterThan(0);
    // deltaHrRatio = (150-50)/(190-50) = 100/140 ≈ 0.714
    // trimp = 60 * 0.714 * 0.64 * e^(1.92*0.714) ≈ 60 * 0.714 * 0.64 * e^1.371 ≈ 107.8
    expect(trimp).toBeCloseTo(107.8, 0);
  });

  it("returns 0 when maxHr <= restingHr", () => {
    expect(computeTrimp(60, 150, 50, 50)).toBe(0);
    expect(computeTrimp(60, 150, 40, 50)).toBe(0);
  });

  it("returns 0 when duration is 0", () => {
    expect(computeTrimp(0, 150, 190, 50)).toBe(0);
  });

  it("returns 0 when avgHr <= restingHr", () => {
    expect(computeTrimp(60, 50, 190, 50)).toBe(0);
    expect(computeTrimp(60, 40, 190, 50)).toBe(0);
  });

  it("accepts custom gender factor and exponent", () => {
    const defaultTrimp = computeTrimp(60, 150, 190, 50);
    const customTrimp = computeTrimp(60, 150, 190, 50, 1.0, 1.5);
    expect(customTrimp).not.toBe(defaultTrimp);
    expect(customTrimp).toBeGreaterThan(0);
  });
});

describe("computeHrTss", () => {
  it("normalizes TRIMP to 1hr at threshold", () => {
    const tss = computeHrTss(60, 150, 190, 50);
    expect(tss).toBeGreaterThan(0);
    // Should be roughly in TSS range (0-200 typical)
    expect(tss).toBeLessThan(300);
  });

  it("returns 0 for invalid inputs", () => {
    expect(computeHrTss(0, 150, 190, 50)).toBe(0);
    expect(computeHrTss(60, 50, 190, 50)).toBe(0);
    expect(computeHrTss(60, 150, 50, 50)).toBe(0);
  });
});

describe("computePowerTss", () => {
  it("computes TSS from NP, FTP, and duration", () => {
    // NP=200, FTP=250, 60min → IF=0.8, TSS = 0.8^2 * 1.0 * 100 = 64
    const tss = computePowerTss(200, 250, 60);
    expect(tss).toBeCloseTo(64, 0);
  });

  it("scales with IF squared and duration", () => {
    const tss1hr = computePowerTss(250, 250, 60); // IF=1.0, 1hr → 100 TSS
    expect(tss1hr).toBeCloseTo(100, 0);

    const tss2hr = computePowerTss(250, 250, 120); // IF=1.0, 2hr → 200 TSS
    expect(tss2hr).toBeCloseTo(200, 0);
  });

  it("returns 0 for invalid inputs", () => {
    expect(computePowerTss(0, 250, 60)).toBe(0);
    expect(computePowerTss(200, 0, 60)).toBe(0);
    expect(computePowerTss(200, 250, 0)).toBe(0);
  });
});

describe("buildTssModel", () => {
  it("returns null with fewer than 10 paired activities", () => {
    const paired = Array.from({ length: 9 }, (_, i) => ({
      trimp: 50 + i * 10,
      powerTss: 40 + i * 8,
    }));
    expect(buildTssModel(paired)).toBeNull();
  });

  it("builds model from 10+ paired activities with good fit", () => {
    // Linear relationship: powerTss ≈ 0.8 * trimp + 5
    const paired = Array.from({ length: 15 }, (_, i) => ({
      trimp: 50 + i * 10,
      powerTss: 45 + i * 8, // ~0.8x slope
    }));
    const model = buildTssModel(paired);
    expect(model).not.toBeNull();
    if (model) {
      expect(model.slope).toBeGreaterThan(0);
      expect(model.r2).toBeGreaterThanOrEqual(0.3);
    }
  });

  it("returns null for poor fit (random data)", () => {
    const paired = Array.from({ length: 15 }, (_, i) => ({
      trimp: 50 + i * 10,
      powerTss: i % 2 === 0 ? 200 : 10, // no correlation
    }));
    const model = buildTssModel(paired);
    // May be null due to poor R² or negative slope
    if (model) {
      expect(model.r2).toBeGreaterThanOrEqual(0.3);
    }
  });
});

describe("estimateFtp", () => {
  it("returns 95% of best avg_power from qualifying activities", () => {
    const activities: ActivityRow[] = [
      {
        id: "1",
        date: "2024-01-01",
        duration_min: 30,
        avg_hr: 150,
        max_hr: 180,
        avg_power: 250,
        power_samples: 1800,
        hr_samples: 1800,
      },
      {
        id: "2",
        date: "2024-01-02",
        duration_min: 25,
        avg_hr: 155,
        max_hr: 185,
        avg_power: 280,
        power_samples: 1500,
        hr_samples: 1500,
      },
      {
        id: "3",
        date: "2024-01-03",
        duration_min: 45,
        avg_hr: 140,
        max_hr: 175,
        avg_power: 230,
        power_samples: 2700,
        hr_samples: 2700,
      },
    ];
    // Best = 280, FTP = 280 * 0.95 = 266
    expect(estimateFtp(activities)).toBe(266);
  });

  it("excludes activities shorter than 20 minutes", () => {
    const activities: ActivityRow[] = [
      {
        id: "1",
        date: "2024-01-01",
        duration_min: 15,
        avg_hr: 170,
        max_hr: 190,
        avg_power: 400,
        power_samples: 900,
        hr_samples: 900,
      },
      {
        id: "2",
        date: "2024-01-02",
        duration_min: 30,
        avg_hr: 150,
        max_hr: 180,
        avg_power: 200,
        power_samples: 1800,
        hr_samples: 1800,
      },
    ];
    // 400W excluded (< 20min), 200W qualifies → FTP = 200 * 0.95 = 190
    expect(estimateFtp(activities)).toBe(190);
  });

  it("returns null when no qualifying activities", () => {
    expect(estimateFtp([])).toBeNull();
    expect(
      estimateFtp([
        {
          id: "1",
          date: "2024-01-01",
          duration_min: 30,
          avg_hr: 150,
          max_hr: 180,
          avg_power: null,
          power_samples: 0,
          hr_samples: 1800,
        },
      ]),
    ).toBeNull();
  });
});
