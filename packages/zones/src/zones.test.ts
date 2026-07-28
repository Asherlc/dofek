import { statusColors, textColors } from "@dofek/scoring/colors";
import { describe, expect, it } from "vitest";
import {
  classifyHeartRateZone,
  classifyPowerZone,
  computeHrRange,
  computePolarizationIndex,
  createZoneDistributionRows,
  formatHeartRateZoneRangeLabel,
  formatPowerZoneRangeLabel,
  HEART_RATE_ZONE_COLORS,
  HEART_RATE_ZONES,
  hasZoneDistributionData,
  heartRateZoneBoundaries,
  mapHrZones,
  mapPowerZones,
  POLARIZATION_ZONES,
  POWER_ZONE_COLORS,
  POWER_ZONES,
  powerZoneBoundaries,
  ZONE_BOUNDARIES_FTP,
  ZONE_BOUNDARIES_HRR,
} from "./zones.ts";

describe("createZoneDistributionRows", () => {
  it("builds display rows with shared labels, percentages, and colors", () => {
    const rows = createZoneDistributionRows(
      [
        { zone: 0, label: "Below Zone 1", seconds: 0, percent: 0 },
        { zone: 1, label: "Recovery", seconds: 300, percent: 10.4 },
      ],
      ["#111111", "#222222"],
    );

    expect(rows).toEqual([
      {
        key: "0",
        primaryLabel: "Below Zone 1",
        subordinateLabel: null,
        axisLabel: "Below Zone 1",
        percentLabel: "0%",
        color: "#111111",
        zone: { zone: 0, label: "Below Zone 1", seconds: 0, percent: 0 },
      },
      {
        key: "1",
        primaryLabel: "Zone 1",
        subordinateLabel: "Recovery",
        axisLabel: "Zone 1\nRecovery",
        percentLabel: "10%",
        color: "#222222",
        zone: { zone: 1, label: "Recovery", seconds: 300, percent: 10.4 },
      },
    ]);
  });

  it("uses the fallback color when a zone does not have a matching color", () => {
    const rows = createZoneDistributionRows(
      [{ zone: 3, label: "Tempo", seconds: 120, percent: 100 }],
      [],
      "#333333",
    );

    expect(rows[0]?.color).toBe("#333333");
  });
});

describe("hasZoneDistributionData", () => {
  it("returns true when any zone has a positive percentage", () => {
    expect(
      hasZoneDistributionData([
        { zone: 0, label: "Below Zone 1", seconds: 0, percent: 0 },
        { zone: 1, label: "Recovery", seconds: 60, percent: 100 },
      ]),
    ).toBe(true);
  });

  it("returns false when all zones are empty", () => {
    expect(
      hasZoneDistributionData([
        { zone: 0, label: "Below Zone 1", seconds: 0, percent: 0 },
        { zone: 1, label: "Recovery", seconds: 0, percent: 0 },
      ]),
    ).toBe(false);
  });
});

describe("formatHeartRateZoneRangeLabel", () => {
  it("formats heart rate zone ranges in layman-readable text", () => {
    expect(
      formatHeartRateZoneRangeLabel({
        zone: 2,
        label: "Aerobic",
        minPct: 60,
        maxPct: 70,
        seconds: 600,
        percent: 50,
      }),
    ).toBe("60-70% Heart Rate Reserve");
  });
});

describe("formatPowerZoneRangeLabel", () => {
  it("formats bounded power zones with threshold power and watt ranges", () => {
    expect(
      formatPowerZoneRangeLabel(
        { zone: 2, label: "Endurance", minPct: 55, maxPct: 75, seconds: 600, percent: 50 },
        250,
      ),
    ).toBe("55-75% Threshold Power (138-188 W)");
  });

  it("formats open-ended power zones", () => {
    expect(
      formatPowerZoneRangeLabel(
        { zone: 7, label: "Neuromuscular", minPct: 150, maxPct: null, seconds: 60, percent: 10 },
        250,
      ),
    ).toBe(">150% Threshold Power (>375 W)");
  });
});

describe("HEART_RATE_ZONES", () => {
  it("defines zone 0 plus the 5 Karvonen training zones", () => {
    expect(HEART_RATE_ZONES).toHaveLength(6);
  });

  it("has zones numbered 0-5 with labels and %HRR boundaries", () => {
    expect(HEART_RATE_ZONES[0]).toEqual({
      zone: 0,
      label: "Below Zone 1",
      minPctHrr: 0,
      maxPctHrr: 0.5,
      color: textColors.neutral,
    });
    expect(HEART_RATE_ZONES[1]).toEqual({
      zone: 1,
      label: "Recovery",
      minPctHrr: 0.5,
      maxPctHrr: 0.6,
      color: statusColors.info,
    });
    expect(HEART_RATE_ZONES[5]).toEqual({
      zone: 5,
      label: "VO2max",
      minPctHrr: 0.9,
      maxPctHrr: 1.0,
      color: statusColors.danger,
    });
  });

  it("has contiguous boundaries from Z0 to Z5", () => {
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
  it("has 5 boundaries derived from zone maxPctHrr values", () => {
    expect(ZONE_BOUNDARIES_HRR).toEqual([0.5, 0.6, 0.7, 0.8, 0.9]);
  });

  it("matches the maxPctHrr of zones 0-4", () => {
    for (let i = 0; i < 5; i++) {
      expect(ZONE_BOUNDARIES_HRR[i]).toBe(HEART_RATE_ZONES[i]?.maxPctHrr);
    }
  });
});

describe("HEART_RATE_ZONE_COLORS", () => {
  it("has 6 hex color strings matching zone definitions", () => {
    expect(HEART_RATE_ZONE_COLORS).toHaveLength(6);
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
    expect(boundaries).toHaveLength(6);

    // Z0: below 50% HRR
    expect(boundaries[0]).toEqual(expect.objectContaining({ zone: 0, minBpm: 50, maxBpm: 120 }));
    // Z1: 50 + 140*0.5 = 120 to 50 + 140*0.6 = 134
    expect(boundaries[1]).toEqual(expect.objectContaining({ zone: 1, minBpm: 120, maxBpm: 134 }));
    // Z2: 50 + 140*0.6 = 134 to 50 + 140*0.7 = 148
    expect(boundaries[2]).toEqual(expect.objectContaining({ zone: 2, minBpm: 134, maxBpm: 148 }));
    // Z5: 50 + 140*0.9 = 176 to 50 + 140*1.0 = 190
    expect(boundaries[5]).toEqual(expect.objectContaining({ zone: 5, minBpm: 176, maxBpm: 190 }));
  });

  it("includes labels and colors in output", () => {
    const boundaries = heartRateZoneBoundaries(180, 60);
    expect(boundaries[1]?.label).toBe("Recovery");
    expect(boundaries[1]?.color).toBe(statusColors.info);
  });
});

describe("classifyHeartRateZone", () => {
  // maxHr=190, restingHr=50, reserve=140
  const maxHr = 190;
  const restingHr = 50;

  it("classifies Z0 for HR below Z1 (< 50% HRR)", () => {
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

  it("handles zone 0 (below 50% HRR)", () => {
    const range = computeHrRange(190, 50, 0);
    expect(range).toEqual({ min: 50, max: 120 });
  });

  it("handles zone 5 (up to 100% HRR)", () => {
    const range = computeHrRange(190, 50, 5);
    expect(range).toEqual({ min: 176, max: 190 });
  });
});

describe("mapHrZones", () => {
  it("maps raw zone rows to full zone 0 through zone 5 structure", () => {
    const rows = [
      { zone: 0, seconds: 120 },
      { zone: 1, seconds: 120 },
      { zone: 3, seconds: 300 },
      { zone: 5, seconds: 60 },
    ];
    const result = mapHrZones(rows);
    expect(result).toHaveLength(6);
    expect(result[0]).toEqual({
      zone: 0,
      label: "Below Zone 1",
      minPct: 0,
      maxPct: 50,
      seconds: 120,
      percent: 20,
    });
    expect(result[1]).toEqual({
      zone: 1,
      label: "Recovery",
      minPct: 50,
      maxPct: 60,
      seconds: 120,
      percent: 20,
    });
    // Zone 2 has no data → 0 seconds
    expect(result[2]).toEqual({
      zone: 2,
      label: "Aerobic",
      minPct: 60,
      maxPct: 70,
      seconds: 0,
      percent: 0,
    });
    expect(result[3]?.seconds).toBe(300);
    expect(result[5]?.seconds).toBe(60);
  });

  it("returns all zeros when no rows", () => {
    const result = mapHrZones([]);
    expect(result).toHaveLength(6);
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
  it("computes Treff PI = log10((f1/f2)*f3*100) for valid inputs", () => {
    // 80/10/10 split → f1=0.8, f2=0.1, f3=0.1
    // PI = log10((0.8 / 0.1) * 0.1 * 100) = log10(80) ≈ 1.903
    const result = computePolarizationIndex(800, 100, 100);
    expect(result).toBe(1.903);
  });

  it("returns exactly 2.00 for Treff's 60/15/25 boundary distribution", () => {
    expect(computePolarizationIndex(600, 150, 250)).toBe(2);
  });

  it("returns null when any zone has zero time", () => {
    expect(computePolarizationIndex(0, 100, 100)).toBeNull();
    expect(computePolarizationIndex(800, 0, 100)).toBeNull();
    expect(computePolarizationIndex(800, 100, 0)).toBeNull();
  });

  it("returns null when Zone 3 exceeds Zone 1 because Treff defines the index as invalid", () => {
    expect(computePolarizationIndex(200, 100, 700)).toBeNull();
  });

  it("calculates the index when Zone 3 equals Zone 1", () => {
    expect(computePolarizationIndex(400, 200, 400)).toBe(1.903);
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

describe("POWER_ZONES", () => {
  it("defines exactly 7 power zones", () => {
    expect(POWER_ZONES).toHaveLength(7);
  });

  it("has contiguous boundaries from Z1 to Z7", () => {
    for (let i = 1; i < POWER_ZONES.length; i++) {
      const prev = POWER_ZONES[i - 1];
      const curr = POWER_ZONES[i];
      expect(curr?.minPctFtp).toBe(prev?.maxPctFtp);
    }
  });

  it("starts at 0 and has an open-ended top zone", () => {
    expect(POWER_ZONES[0]?.minPctFtp).toBe(0);
    expect(POWER_ZONES[6]?.maxPctFtp).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("ZONE_BOUNDARIES_FTP", () => {
  it("has 6 boundaries derived from zone maxPctFtp values", () => {
    expect(ZONE_BOUNDARIES_FTP).toEqual([0.55, 0.75, 0.9, 1.05, 1.2, 1.5]);
  });
});

describe("POWER_ZONE_COLORS", () => {
  it("has 7 hex color strings matching zone definitions", () => {
    expect(POWER_ZONE_COLORS).toHaveLength(7);
    for (const color of POWER_ZONE_COLORS) {
      expect(color).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });
});

describe("powerZoneBoundaries", () => {
  it("computes absolute watt boundaries from FTP", () => {
    // ftp=250
    const boundaries = powerZoneBoundaries(250);
    expect(boundaries).toHaveLength(7);
    expect(boundaries[0]).toEqual(expect.objectContaining({ zone: 1, minWatts: 0, maxWatts: 138 }));
    expect(boundaries[3]).toEqual(
      expect.objectContaining({ zone: 4, minWatts: 225, maxWatts: 263 }),
    );
    expect(boundaries[6]).toEqual(
      expect.objectContaining({ zone: 7, minWatts: 375, maxWatts: null }),
    );
  });
});

describe("classifyPowerZone", () => {
  const ftp = 250;

  it("classifies Z1 below 55% FTP", () => {
    expect(classifyPowerZone(100, ftp)).toBe(1);
    expect(classifyPowerZone(0, ftp)).toBe(1);
  });

  it("classifies Z4 at FTP", () => {
    expect(classifyPowerZone(250, ftp)).toBe(4);
  });

  it("classifies Z7 for power above 150% FTP", () => {
    expect(classifyPowerZone(400, ftp)).toBe(7);
  });

  it("uses lower-inclusive boundaries", () => {
    // Z2 starts at 55% * 250 = 137.5 → 138 should be Z2
    expect(classifyPowerZone(138, ftp)).toBe(2);
  });
});

describe("mapPowerZones", () => {
  it("maps raw zone rows to full 7-zone structure", () => {
    const rows = [
      { zone: 2, seconds: 600 },
      { zone: 4, seconds: 120 },
    ];
    const result = mapPowerZones(rows);
    expect(result).toHaveLength(7);
    expect(result[1]).toEqual({
      zone: 2,
      label: "Endurance",
      minPct: 55,
      maxPct: 75,
      seconds: 600,
      percent: 83.3,
    });
    expect(result[0]?.seconds).toBe(0);
    expect(result[3]?.seconds).toBe(120);
  });

  it("returns null maxPct for open-ended Z7", () => {
    const result = mapPowerZones([]);
    expect(result[6]?.maxPct).toBeNull();
  });
});
