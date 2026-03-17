import { describe, expect, it } from "vitest";
import { DURATION_LABELS } from "./duration-labels.ts";

describe("DURATION_LABELS", () => {
  it("maps standard durations to human-readable labels", () => {
    expect(DURATION_LABELS[5]).toBe("5s");
    expect(DURATION_LABELS[60]).toBe("1min");
    expect(DURATION_LABELS[300]).toBe("5min");
    expect(DURATION_LABELS[3600]).toBe("60min");
  });

  it("covers all standard power curve durations", () => {
    const expectedDurations = [
      5, 15, 30, 60, 120, 180, 300, 420, 600, 1200, 1800, 3600, 5400, 7200,
    ];
    for (const d of expectedDurations) {
      expect(DURATION_LABELS[d]).toBeDefined();
    }
  });
});
