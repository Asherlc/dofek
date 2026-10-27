import { describe, expect, it } from "vitest";
import { formatConditionalEffectLabel, NO_OBSERVED_DIFFERENCE } from "./conditional-effect.ts";

describe("formatConditionalEffectLabel", () => {
  it("uses a neutral label for an exact zero difference", () => {
    expect(formatConditionalEffectLabel(2, 2, "next-day HRV")).toBe(NO_OBSERVED_DIFFERENCE);
  });

  it("uses an absolute value when the baseline is near zero", () => {
    expect(formatConditionalEffectLabel(0.75, 0.5, "monthly weight change")).toBe("0.25 kg higher");
  });

  it("uses absolute units just below the generic baseline cutoff", () => {
    expect(formatConditionalEffectLabel(1.49, 0.99, "next-day HRV")).toBe("0.50 ms higher");
  });

  it("uses a percentage at and above the generic baseline cutoff", () => {
    expect(formatConditionalEffectLabel(1.5, 1, "next-day HRV")).toBe("50% higher");
  });

  it("uses the absolute value and lower direction for a negative near-zero effect", () => {
    expect(formatConditionalEffectLabel(0.25, 0.5, "next-day HRV")).toBe("0.25 ms lower");
  });

  it("preserves lower direction for a negative baseline", () => {
    expect(formatConditionalEffectLabel(-0.75, -0.5, "next-day HRV")).toBe("0.25 ms lower");
  });

  it("uses absolute units when a negative baseline would make a percentage misleading", () => {
    expect(formatConditionalEffectLabel(-2.5, -2, "next-day HRV")).toBe("0.50 ms lower");
  });

  it("keeps the exact negative-baseline boundary in absolute units", () => {
    expect(formatConditionalEffectLabel(-1.5, -1, "next-day HRV")).toBe("0.50 ms lower");
  });

  it("uses absolute units when the means cross zero", () => {
    expect(formatConditionalEffectLabel(-0.5, 2, "next-day HRV")).toBe("2.50 ms lower");
  });

  it("uses absolute units when the means cross zero in the other direction", () => {
    expect(formatConditionalEffectLabel(0.5, -2, "next-day HRV")).toBe("2.50 ms higher");
  });

  it("does not treat an exact zero mean as crossing zero", () => {
    expect(formatConditionalEffectLabel(0, 2, "next-day HRV")).toBe("100% lower");
  });

  it("omits a unit when the metric has no configured unit", () => {
    expect(formatConditionalEffectLabel(0.75, 0.5, "unconfigured metric")).toBe("0.25 higher");
  });

  it("uses a percentage for non-signed daily metrics when the baseline is not near zero", () => {
    expect(formatConditionalEffectLabel(2.6, 2, "next-day HRV")).toBe("30% higher");
  });

  it("uses percentage-point differences for percent-valued metrics", () => {
    expect(formatConditionalEffectLabel(89, 85, "sleep efficiency that night")).toBe(
      "4.00 % higher",
    );
  });

  it("keeps monthly weight change in absolute kilograms at the old cutoff boundary", () => {
    expect(formatConditionalEffectLabel(1.6, 1, "monthly weight change")).toBe("0.60 kg higher");
  });

  it("uses absolute units for monthly body composition changes", () => {
    expect(formatConditionalEffectLabel(1.25, 1, "monthly body fat change")).toBe("0.25 % higher");
  });

  it("treats rounded-zero absolute differences as unavailable neutral evidence", () => {
    expect(formatConditionalEffectLabel(0.004, 0, "next-day HRV")).toBe(NO_OBSERVED_DIFFERENCE);
  });

  it("keeps the first displayed nonzero absolute difference", () => {
    expect(formatConditionalEffectLabel(0.005, 0, "next-day HRV")).toBe("0.01 ms higher");
  });

  it("uses an absolute unit for a nonzero zero-baseline difference", () => {
    expect(formatConditionalEffectLabel(0.25, 0, "next-day HRV")).toBe("0.25 ms higher");
  });

  it("treats rounded-zero percentage differences as no observed difference", () => {
    expect(formatConditionalEffectLabel(100.004, 100, "next-day HRV")).toBe(NO_OBSERVED_DIFFERENCE);
  });
});
