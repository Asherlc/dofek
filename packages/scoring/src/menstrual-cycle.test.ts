import { describe, expect, it } from "vitest";
import { type CyclePhase, computePhase } from "./menstrual-cycle.ts";

describe("computePhase", () => {
  it("returns menstrual phase for days 1-5", () => {
    expect(computePhase(1, 28)).toBe("menstrual");
    expect(computePhase(5, 28)).toBe("menstrual");
  });

  it("returns follicular phase for days 6 to ovulation window start", () => {
    expect(computePhase(6, 28)).toBe("follicular");
    // 28-day cycle: ovulation=14, window=13-15. Day 12 is still follicular.
    expect(computePhase(12, 28)).toBe("follicular");
  });

  it("returns ovulatory phase around mid-cycle (ovulation ±1)", () => {
    // For 28-day cycle, ovulation at day 14, window = 13-15
    expect(computePhase(13, 28)).toBe("ovulatory");
    expect(computePhase(14, 28)).toBe("ovulatory");
    expect(computePhase(15, 28)).toBe("ovulatory");
  });

  it("returns luteal phase after ovulatory window", () => {
    expect(computePhase(16, 28)).toBe("luteal");
    expect(computePhase(28, 28)).toBe("luteal");
  });

  it("handles short cycles", () => {
    // 21-day cycle: ovulation = 21-14 = 7, window = 6-8
    expect(computePhase(1, 21)).toBe("menstrual");
    // Day 6 is in ovulatory window for this short cycle
    expect(computePhase(6, 21)).toBe("ovulatory");
    expect(computePhase(7, 21)).toBe("ovulatory");
    expect(computePhase(8, 21)).toBe("ovulatory");
    expect(computePhase(9, 21)).toBe("luteal");
    expect(computePhase(15, 21)).toBe("luteal");
  });

  it("handles long cycles", () => {
    // 35-day cycle: ovulation around day 21
    expect(computePhase(1, 35)).toBe("menstrual");
    expect(computePhase(10, 35)).toBe("follicular");
    expect(computePhase(21, 35)).toBe("ovulatory");
    expect(computePhase(30, 35)).toBe("luteal");
  });

  it("returns the correct phase type", () => {
    const phases: CyclePhase[] = ["menstrual", "follicular", "ovulatory", "luteal"];
    const result = computePhase(1, 28);
    expect(phases).toContain(result);
  });
});
