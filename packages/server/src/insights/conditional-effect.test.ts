import { describe, expect, it } from "vitest";
import { formatConditionalEffectLabel, NO_OBSERVED_DIFFERENCE } from "./conditional-effect.ts";

describe("formatConditionalEffectLabel", () => {
  it("uses a neutral label for an exact zero difference", () => {
    expect(formatConditionalEffectLabel(2, 2, "next-day HRV")).toBe(NO_OBSERVED_DIFFERENCE);
  });

  it("uses an absolute value when the baseline is near zero", () => {
    expect(formatConditionalEffectLabel(0.75, 0.5, "monthly weight change")).toBe("0.25 kg higher");
  });

  it("uses the absolute value and lower direction for a negative near-zero effect", () => {
    expect(formatConditionalEffectLabel(0.25, 0.5, "next-day HRV")).toBe("0.25 ms lower");
  });

  it("omits a unit when the metric has no configured unit", () => {
    expect(formatConditionalEffectLabel(0.75, 0.5, "unconfigured metric")).toBe("0.25 higher");
  });

  it("uses a percentage when the baseline is not near zero", () => {
    expect(formatConditionalEffectLabel(2.6, 2, "monthly weight change")).toBe("30% higher");
  });

  it("uses a percentage at the near-zero boundary", () => {
    expect(formatConditionalEffectLabel(1.25, 1, "monthly weight change")).toBe("25% higher");
  });

  it("treats rounded-zero absolute differences as unavailable neutral evidence", () => {
    expect(formatConditionalEffectLabel(0.004, 0, "next-day HRV")).toBe(NO_OBSERVED_DIFFERENCE);
  });

  it("treats rounded-zero percentage differences as no observed difference", () => {
    expect(formatConditionalEffectLabel(100.004, 100, "next-day HRV")).toBe(NO_OBSERVED_DIFFERENCE);
  });
});
