import { statusColors } from "@dofek/scoring/colors";
import { describe, expect, it } from "vitest";
import {
  classifyHeartRateZone,
  computeHrRange,
  computePolarizationIndex,
  HEART_RATE_ZONE_COLORS,
  HEART_RATE_ZONES,
  heartRateZoneBoundaries,
  mapHrZones,
  POLARIZATION_ZONES,
  ZONE_BOUNDARIES_HRR,
} from "./zones.ts";

describe("HEART_RATE_ZONES", () => {
  it("defines exactly 5 zones", () => {
    expect(HEART_RATE_ZONES).toHaveLength(5);
  });

  it("has zones numbered 1-5 with labels and %HRR boundaries", () => {
    expect(HEART_RATE_ZONES[0]).toEqual({
      zone: 1,
      label: "Recovery",
      minPctHrr: 0.5,
      maxPctHrr: 0.6,
      color: statusColors.info,
    });
    expect(HEART_RATE_ZONES[4]).toEqual({
      zone: 5,
      label: "VO2max",
      minPctHrr: 0.9,
      maxPctHrr: 1.0,
      color: statusColors.danger,
    });
  });

  it("has contiguous boundaries (no gaps from Z2 to Z5)", () => {
    for (let i = 1; i < HEART_RATE_ZONES.length; i++) {
      const prev = HEART_RATE_ZONES[i - 1];
      const curr = HEART_RATE_ZONES[i];
      expect(curr).toBeDefined();
      expect(prev).toBeDefined();
      expect(curr?.minPctHrr).toBe(prev?.maxPctHrr);
    }
  });
});

describe("ZONE_BOUNDARIES_HRR", () => {
  it("has 4 boundaries derived from zone maxPctHrr values", () => {
    expect(ZONE_BOUNDARIES_HRR).toEqual([0.6, 0.7, 0.8, 0.9]);
  });

  it("matches the maxPctHrr of zones 1-4", () => {
    for (let i = 0; i < 4; i++) {
      expect(ZONE_BOUNDARIES_HRR[i]).toBe(HEART_RATE_ZONES[i]?.maxPctHrr);
    }
  });
});

describe("HEART_RATE_ZONE_COLORS", () => {
  it("has 5 hex color strings matching zone definitions", () => {
    expect(HEART_RATE_ZONE_COLORS).toHaveLength(5);
    for (const color of HEART_RATE_ZONE_COLORS) {
      expect(color).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(HEART_RATE_ZONE_COLORS).toEqual(HEART_RATE_ZONES.map((z) => z.color));
  });
});

describe("heartRateZoneBoundaries", () => {
  it("computes absolute BPM boundaries from max HR and resting HR", () => {
    // maxHr=190, restingHr=50 → reserve=140
    const boundaries = heartRateZoneBoundaries(190, 50);
    expect(boundaries).toHaveLength(5);

    // Z1: 50 + 140*0.5 = 120 to 50 + 140*0.6 = 134
    expect(boundaries[0]).toEqual(expect.objectContaining({ zone: 1, minBpm: 120, maxBpm: 134 }));
    // Z2: 50 + 140*0.6 = 134 to 50 + 140*0.7 = 148
    expect(boundaries[1]).toEqual(expect.objectContaining({ zone: 2, minBpm: 134, maxBpm: 148 }));
    // Z5: 50 + 140*0.9 = 176 to 50 + 140*1.0 = 190
    expect(boundaries[4]).toEqual(expect.objectContaining({ zone: 5, minBpm: 176, maxBpm: 190 }));
  });

  it("includes labels and colors in output", () => {
    const boundaries = heartRateZoneBoundaries(180, 60);
    expect(boundaries[0]?.label).toBe("Recovery");
    expect(boundaries[0]?.color).toBe(statusColors.info);
  });
});

describe("classifyHeartRateZone", () => {
  // maxHr=190, restingHr=50, reserve=140
  const maxHr = 190;
  const restingHr = 50;

  it("returns 0 for HR below Z1 (< 50% HRR)", () => {
    // 50 + 140*0.5 = 120 → anything below 120 is zone 0
    expect(classifyHeartRateZone(100, maxHr, restingHr)).toBe(0);
    expect(classifyHeartRateZone(119, maxHr, restingHr)).toBe(0);
  });

  it("classifies Z1 (50-60% HRR)", () => {
    expect(classifyHeartRateZone(120, maxHr, restingHr)).toBe(1);
    expect(classifyHeartRateZone(133, maxHr, restingHr)).toBe(1);
  });

  it("classifies Z2 (60-70% HRR)", () => {
    expect(classifyHeartRateZone(134, maxHr, restingHr)).toBe(2);
    expect(classifyHeartRateZone(147, maxHr, restingHr)).toBe(2);
  });

  it("classifies Z3 (70-80% HRR)", () => {
    expect(classifyHeartRateZone(148, maxHr, restingHr)).toBe(3);
    expect(classifyHeartRateZone(161, maxHr, restingHr)).toBe(3);
  });

  it("classifies Z4 (80-90% HRR)", () => {
    expect(classifyHeartRateZone(162, maxHr, restingHr)).toBe(4);
    expect(classifyHeartRateZone(175, maxHr, restingHr)).toBe(4);
  });

  it("classifies Z5 (90-100% HRR)", () => {
    expect(classifyHeartRateZone(176, maxHr, restingHr)).toBe(5);
    expect(classifyHeartRateZone(190, maxHr, restingHr)).toBe(5);
  });

  it("classifies Z5 for HR above max", () => {
    expect(classifyHeartRateZone(200, maxHr, restingHr)).toBe(5);
  });

  it("returns on exact boundaries (lower inclusive)", () => {
    // Z2 starts at 134 → exactly 134 should be Z2
    expect(classifyHeartRateZone(134, maxHr, restingHr)).toBe(2);
  });
});

describe("computeHrRange", () => {
  it("computes absolute BPM range for a given zone", () => {
    // maxHr=190, restingHr=50, reserve=140
    const range = computeHrRange(190, 50, 2);
    // Z2: 50 + 140*0.6 = 134, 50 + 140*0.7 = 148
    expect(range).toEqual({ min: 134, max: 148 });
  });

  it("returns null when maxHr or restingHr is null", () => {
    expect(computeHrRange(null, 50, 2)).toBeNull();
    expect(computeHrRange(190, null, 2)).toBeNull();
  });

  it("handles zone 1 (starts at 50% HRR)", () => {
    const range = computeHrRange(190, 50, 1);
    expect(range).toEqual({ min: 120, max: 134 });
  });

  it("handles zone 5 (up to 100% HRR)", () => {
    const range = computeHrRange(190, 50, 5);
    expect(range).toEqual({ min: 176, max: 190 });
  });
});

describe("mapHrZones", () => {
  it("maps raw zone rows to full 5-zone structure", () => {
    const rows = [
      { zone: 1, seconds: 120 },
      { zone: 3, seconds: 300 },
      { zone: 5, seconds: 60 },
    ];
    const result = mapHrZones(rows);
    expect(result).toHaveLength(5);
    expect(result[0]).toEqual({
      zone: 1,
      label: "Recovery",
      minPct: 50,
      maxPct: 60,
      seconds: 120,
    });
    // Zone 2 has no data → 0 seconds
    expect(result[1]).toEqual({
      zone: 2,
      label: "Aerobic",
      minPct: 60,
      maxPct: 70,
      seconds: 0,
    });
    expect(result[2]?.seconds).toBe(300);
    expect(result[4]?.seconds).toBe(60);
  });

  it("returns all zeros when no rows", () => {
    const result = mapHrZones([]);
    expect(result).toHaveLength(5);
    for (const zone of result) {
      expect(zone.seconds).toBe(0);
    }
  });
});

describe("POLARIZATION_ZONES", () => {
  it("defines 3 Treff zones based on %HRmax", () => {
    expect(POLARIZATION_ZONES).toHaveLength(3);
    expect(POLARIZATION_ZONES[0]).toEqual(
      expect.objectContaining({ zone: 1, label: "Easy", maxPctHrmax: 0.8 }),
    );
    expect(POLARIZATION_ZONES[1]).toEqual(
      expect.objectContaining({ zone: 2, label: "Threshold", minPctHrmax: 0.8, maxPctHrmax: 0.9 }),
    );
    expect(POLARIZATION_ZONES[2]).toEqual(
      expect.objectContaining({ zone: 3, label: "High Intensity", minPctHrmax: 0.9 }),
    );
  });
});

describe("computePolarizationIndex", () => {
  it("computes PI = log10((f1/(f2*f3))*100) for valid inputs", () => {
    // 80/10/10 split → f1=0.8, f2=0.1, f3=0.1
    // PI = log10((0.8 / (0.1 * 0.1)) * 100) = log10(8000) ≈ 3.903
    const result = computePolarizationIndex(800, 100, 100);
    expect(result).toBeCloseTo(3.903, 2);
  });

  it("returns null when any zone has zero time", () => {
    expect(computePolarizationIndex(0, 100, 100)).toBeNull();
    expect(computePolarizationIndex(800, 0, 100)).toBeNull();
    expect(computePolarizationIndex(800, 100, 0)).toBeNull();
  });

  it("returns higher values for more polarized distributions", () => {
    const polarized = computePolarizationIndex(900, 50, 50);
    const unpolarized = computePolarizationIndex(400, 300, 300);
    expect(polarized).not.toBeNull();
    expect(unpolarized).not.toBeNull();
    if (polarized != null && unpolarized != null) {
      expect(polarized).toBeGreaterThan(unpolarized);
    }
  });

  it("rounds to 3 decimal places", () => {
    const result = computePolarizationIndex(800, 100, 100);
    expect(result).not.toBeNull();
    if (result != null) {
      const decimalPlaces = result.toString().split(".")[1]?.length ?? 0;
      expect(decimalPlaces).toBeLessThanOrEqual(3);
    }
  });
});
