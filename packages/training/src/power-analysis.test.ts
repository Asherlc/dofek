import { describe, expect, it } from "vitest";
import { DURATION_LABELS, STANDARD_DURATIONS } from "./power-analysis.ts";

describe("STANDARD_DURATIONS", () => {
  it("contains the standard power curve durations in ascending order", () => {
    expect(STANDARD_DURATIONS).toEqual([
      5, 15, 30, 60, 120, 180, 300, 420, 600, 1200, 1800, 3600, 5400, 7200,
    ]);
    for (let i = 1; i < STANDARD_DURATIONS.length; i++) {
      expect(STANDARD_DURATIONS[i]).toBeGreaterThan(STANDARD_DURATIONS[i - 1] ?? 0);
    }
  });
});

describe("DURATION_LABELS", () => {
  it("has a label for every standard duration", () => {
    for (const d of STANDARD_DURATIONS) {
      expect(DURATION_LABELS[d]).toBeDefined();
    }
  });

  it("uses human-readable format", () => {
    expect(DURATION_LABELS[60]).toBe("1min");
    expect(DURATION_LABELS[3600]).toBe("60min");
    expect(DURATION_LABELS[5]).toBe("5s");
  });
});
