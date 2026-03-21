import { describe, expect, it } from "vitest";
import {
  computeKarvonenZones,
  computeMaxHrZones,
  getZoneForHeartRate,
  HR_ZONE_COLORS,
  HR_ZONE_LABELS,
  KARVONEN_ZONE_DEFINITIONS,
  MAX_HR_ZONE_DEFINITIONS,
} from "./heart-rate-zones.ts";

describe("computeKarvonenZones", () => {
  it("returns 5 zones with correct boundaries for maxHr=200, restingHr=60", () => {
    const zones = computeKarvonenZones(200, 60);
    // HRR = 200 - 60 = 140
    // Z1: resting + HRR * 0.5 to resting + HRR * 0.6 => 130 to 144
    // Z2: resting + HRR * 0.6 to resting + HRR * 0.7 => 144 to 158
    // Z3: resting + HRR * 0.7 to resting + HRR * 0.8 => 158 to 172
    // Z4: resting + HRR * 0.8 to resting + HRR * 0.9 => 172 to 186
    // Z5: resting + HRR * 0.9 to maxHr => 186 to 200
    expect(zones).toHaveLength(5);
    expect(zones).toEqual([
      { zone: 1, label: "Recovery", minPct: 0.5, maxPct: 0.6, minHr: 130, maxHr: 144 },
      { zone: 2, label: "Aerobic", minPct: 0.6, maxPct: 0.7, minHr: 144, maxHr: 158 },
      { zone: 3, label: "Tempo", minPct: 0.7, maxPct: 0.8, minHr: 158, maxHr: 172 },
      { zone: 4, label: "Threshold", minPct: 0.8, maxPct: 0.9, minHr: 172, maxHr: 186 },
      { zone: 5, label: "Anaerobic", minPct: 0.9, maxPct: 1.0, minHr: 186, maxHr: 200 },
    ]);
  });

  it("returns correct boundaries for maxHr=185, restingHr=50", () => {
    const zones = computeKarvonenZones(185, 50);
    // HRR = 185 - 50 = 135
    // Z1: 50 + 135*0.5=117.5, 50 + 135*0.6=131
    // Z2: 131, 50 + 135*0.7=144.5
    // Z3: 144.5, 50 + 135*0.8=158
    // Z4: 158, 50 + 135*0.9=171.5
    // Z5: 171.5, 185
    expect(zones[0]).toEqual({
      zone: 1,
      label: "Recovery",
      minPct: 0.5,
      maxPct: 0.6,
      minHr: 117.5,
      maxHr: 131,
    });
    expect(zones[4]).toEqual({
      zone: 5,
      label: "Anaerobic",
      minPct: 0.9,
      maxPct: 1.0,
      minHr: 171.5,
      maxHr: 185,
    });
  });

  it("handles equal maxHr and restingHr (edge case)", () => {
    const zones = computeKarvonenZones(100, 100);
    // HRR = 0, so all zones collapse to resting HR
    expect(zones[0]?.minHr).toBe(100);
    expect(zones[0]?.maxHr).toBe(100);
    expect(zones[4]?.minHr).toBe(100);
    expect(zones[4]?.maxHr).toBe(100);
  });
});

describe("computeMaxHrZones", () => {
  it("returns 3 zones with correct %HRmax boundaries for maxHr=200", () => {
    const zones = computeMaxHrZones(200);
    expect(zones).toHaveLength(3);
    expect(zones).toEqual([
      { zone: 1, label: "Easy", minPct: 0, maxPct: 0.8, minHr: 0, maxHr: 160 },
      { zone: 2, label: "Threshold", minPct: 0.8, maxPct: 0.9, minHr: 160, maxHr: 180 },
      { zone: 3, label: "High Intensity", minPct: 0.9, maxPct: 1.0, minHr: 180, maxHr: 200 },
    ]);
  });

  it("returns correct boundaries for maxHr=190", () => {
    const zones = computeMaxHrZones(190);
    expect(zones[0]).toEqual({
      zone: 1,
      label: "Easy",
      minPct: 0,
      maxPct: 0.8,
      minHr: 0,
      maxHr: 152,
    });
    expect(zones[1]).toEqual({
      zone: 2,
      label: "Threshold",
      minPct: 0.8,
      maxPct: 0.9,
      minHr: 152,
      maxHr: 171,
    });
    expect(zones[2]).toEqual({
      zone: 3,
      label: "High Intensity",
      minPct: 0.9,
      maxPct: 1.0,
      minHr: 171,
      maxHr: 190,
    });
  });
});

describe("getZoneForHeartRate", () => {
  const karvonenZones = computeKarvonenZones(200, 60);
  // Z1: 130-144, Z2: 144-158, Z3: 158-172, Z4: 172-186, Z5: 186-200

  it("returns the correct zone for a value in the middle of a zone", () => {
    expect(getZoneForHeartRate(137, karvonenZones)).toBe(1); // middle of Z1
    expect(getZoneForHeartRate(150, karvonenZones)).toBe(2); // middle of Z2
    expect(getZoneForHeartRate(165, karvonenZones)).toBe(3); // middle of Z3
    expect(getZoneForHeartRate(180, karvonenZones)).toBe(4); // middle of Z4
    expect(getZoneForHeartRate(195, karvonenZones)).toBe(5); // middle of Z5
  });

  it("assigns the lower boundary to the zone (inclusive lower bound)", () => {
    expect(getZoneForHeartRate(130, karvonenZones)).toBe(1); // exactly at Z1 lower
    expect(getZoneForHeartRate(144, karvonenZones)).toBe(2); // at Z2 lower (Z1 upper exclusive)
    expect(getZoneForHeartRate(158, karvonenZones)).toBe(3); // at Z3 lower
    expect(getZoneForHeartRate(172, karvonenZones)).toBe(4); // at Z4 lower
    expect(getZoneForHeartRate(186, karvonenZones)).toBe(5); // at Z5 lower
  });

  it("returns 0 for HR below the lowest zone boundary", () => {
    expect(getZoneForHeartRate(100, karvonenZones)).toBe(0);
    expect(getZoneForHeartRate(129.9, karvonenZones)).toBe(0);
  });

  it("returns the highest zone for HR at maxHr", () => {
    expect(getZoneForHeartRate(200, karvonenZones)).toBe(5);
  });

  it("returns the highest zone for HR above maxHr", () => {
    expect(getZoneForHeartRate(210, karvonenZones)).toBe(5);
  });

  it("works with maxHr zones (3-zone model)", () => {
    const maxHrZones = computeMaxHrZones(200);
    // Z1: 0-160, Z2: 160-180, Z3: 180-200
    expect(getZoneForHeartRate(100, maxHrZones)).toBe(1);
    expect(getZoneForHeartRate(159, maxHrZones)).toBe(1);
    expect(getZoneForHeartRate(160, maxHrZones)).toBe(2); // boundary goes to higher zone
    expect(getZoneForHeartRate(179, maxHrZones)).toBe(2);
    expect(getZoneForHeartRate(180, maxHrZones)).toBe(3);
    expect(getZoneForHeartRate(200, maxHrZones)).toBe(3);
    expect(getZoneForHeartRate(210, maxHrZones)).toBe(3); // above max
  });
});

describe("HR_ZONE_COLORS", () => {
  it("has 5 colors for the 5-zone Karvonen model", () => {
    expect(HR_ZONE_COLORS).toHaveLength(5);
  });

  it("contains valid hex color strings", () => {
    for (const color of HR_ZONE_COLORS) {
      expect(color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});

describe("HR_ZONE_LABELS", () => {
  it("has 5 labels for the 5-zone Karvonen model", () => {
    expect(HR_ZONE_LABELS).toHaveLength(5);
  });

  it("contains human-readable zone names", () => {
    expect(HR_ZONE_LABELS).toEqual(["Recovery", "Aerobic", "Tempo", "Threshold", "Anaerobic"]);
  });
});

describe("KARVONEN_ZONE_DEFINITIONS", () => {
  it("has 5 zone definitions", () => {
    expect(KARVONEN_ZONE_DEFINITIONS).toHaveLength(5);
  });

  it("has contiguous percentage boundaries", () => {
    for (let i = 1; i < KARVONEN_ZONE_DEFINITIONS.length; i++) {
      const prev = KARVONEN_ZONE_DEFINITIONS[i - 1];
      const curr = KARVONEN_ZONE_DEFINITIONS[i];
      expect(curr?.minPct).toBe(prev?.maxPct);
    }
  });

  it("starts at 50% and ends at 100%", () => {
    expect(KARVONEN_ZONE_DEFINITIONS[0]?.minPct).toBe(0.5);
    expect(KARVONEN_ZONE_DEFINITIONS[4]?.maxPct).toBe(1.0);
  });
});

describe("MAX_HR_ZONE_DEFINITIONS", () => {
  it("has 3 zone definitions", () => {
    expect(MAX_HR_ZONE_DEFINITIONS).toHaveLength(3);
  });

  it("has contiguous percentage boundaries", () => {
    for (let i = 1; i < MAX_HR_ZONE_DEFINITIONS.length; i++) {
      const prev = MAX_HR_ZONE_DEFINITIONS[i - 1];
      const curr = MAX_HR_ZONE_DEFINITIONS[i];
      expect(curr?.minPct).toBe(prev?.maxPct);
    }
  });

  it("starts at 0% and ends at 100%", () => {
    expect(MAX_HR_ZONE_DEFINITIONS[0]?.minPct).toBe(0);
    expect(MAX_HR_ZONE_DEFINITIONS[2]?.maxPct).toBe(1.0);
  });
});
