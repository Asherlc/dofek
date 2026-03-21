import { describe, expect, it } from "vitest";
import { DURATION_LABELS, fitCriticalPower, STANDARD_DURATIONS } from "./power-analysis.ts";

describe("STANDARD_DURATIONS", () => {
  it("has 14 durations from 5s to 7200s", () => {
    expect(STANDARD_DURATIONS).toHaveLength(14);
    expect(STANDARD_DURATIONS[0]).toBe(5);
    expect(STANDARD_DURATIONS[STANDARD_DURATIONS.length - 1]).toBe(7200);
  });

  it("is sorted ascending", () => {
    for (let i = 1; i < STANDARD_DURATIONS.length; i++) {
      const prev = STANDARD_DURATIONS[i - 1];
      const curr = STANDARD_DURATIONS[i];
      if (prev != null && curr != null) {
        expect(curr).toBeGreaterThan(prev);
      }
    }
  });
});

describe("DURATION_LABELS", () => {
  it("has a label for each standard duration", () => {
    for (const d of STANDARD_DURATIONS) {
      expect(DURATION_LABELS[d]).toBeDefined();
    }
  });

  it("formats durations in human-readable form", () => {
    expect(DURATION_LABELS[5]).toBe("5s");
    expect(DURATION_LABELS[60]).toBe("1min");
    expect(DURATION_LABELS[3600]).toBe("60min");
  });
});

describe("fitCriticalPower", () => {
  it("fits a CP model from power curve points (120-600s range)", () => {
    // Simulate a power curve: P(t) = 300 + 20000/t
    // CP=300, W'=20000
    const points = [
      { durationSeconds: 120, bestPower: 300 + 20000 / 120 }, // 467W
      { durationSeconds: 180, bestPower: 300 + 20000 / 180 }, // 411W
      { durationSeconds: 300, bestPower: 300 + 20000 / 300 }, // 367W
      { durationSeconds: 420, bestPower: 300 + 20000 / 420 }, // 348W
      { durationSeconds: 600, bestPower: 300 + 20000 / 600 }, // 333W
    ];

    const model = fitCriticalPower(points);
    expect(model).not.toBeNull();
    if (model) {
      expect(model.cp).toBeCloseTo(300, 0);
      expect(model.wPrime).toBeCloseTo(20000, -2); // within ~100J
      expect(model.r2).toBeGreaterThan(0.99);
    }
  });

  it("filters out durations outside 120-600s", () => {
    const points = [
      { durationSeconds: 5, bestPower: 1000 }, // excluded
      { durationSeconds: 120, bestPower: 400 },
      { durationSeconds: 300, bestPower: 350 },
      { durationSeconds: 600, bestPower: 320 },
      { durationSeconds: 7200, bestPower: 250 }, // excluded
    ];
    const model = fitCriticalPower(points);
    expect(model).not.toBeNull();
  });

  it("returns null with fewer than 3 valid points", () => {
    const points = [
      { durationSeconds: 120, bestPower: 400 },
      { durationSeconds: 300, bestPower: 350 },
    ];
    expect(fitCriticalPower(points)).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(fitCriticalPower([])).toBeNull();
  });
});
