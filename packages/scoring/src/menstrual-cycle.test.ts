import { describe, expect, it } from "vitest";
import { CYCLE_TRACKING_SAFETY_NOTICE, computePhase } from "./menstrual-cycle.ts";

describe("computePhase", () => {
  it("uses days 1 through 5 as the menstrual phase", () => {
    expect(computePhase(1, 28)).toBe("menstrual");
    expect(computePhase(5, 28)).toBe("menstrual");
  });

  it("uses the estimated ovulation day plus or minus one", () => {
    expect(computePhase(12, 28)).toBe("follicular");
    expect(computePhase(13, 28)).toBe("ovulatory");
    expect(computePhase(15, 28)).toBe("ovulatory");
    expect(computePhase(16, 28)).toBe("luteal");
  });

  it("handles the inclusive regular-cycle boundaries", () => {
    expect(computePhase(6, 21)).toBe("ovulatory");
    expect(computePhase(21, 35)).toBe("ovulatory");
  });
});

describe("CYCLE_TRACKING_SAFETY_NOTICE", () => {
  it("keeps the shared tracking-only safety boundary", () => {
    expect(CYCLE_TRACKING_SAFETY_NOTICE).toBe(
      "Tracking estimates only. Do not use for birth control or diagnosis.",
    );
  });
});
