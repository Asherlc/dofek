import { describe, expect, it } from "vitest";
import { formatCorrelationComparison, formatCorrelationLagOption } from "./correlation-lag.ts";

describe("formatCorrelationLagOption", () => {
  it.each([
    [-1, "-1 calendar day"],
    [0, "Same day"],
    [1, "+1 calendar day"],
    [3, "+3 calendar days"],
  ])("formats lag %i as an explicit calendar-day option", (lag, expected) => {
    expect(formatCorrelationLagOption(lag)).toBe(expected);
  });
});

describe("formatCorrelationComparison", () => {
  it("states which metric leads for a positive lag", () => {
    expect(
      formatCorrelationComparison({
        xLabel: "Protein",
        yLabel: "Heart Rate Variability",
        lag: 1,
      }),
    ).toBe("Protein today vs Heart Rate Variability 1 calendar day later");
  });

  it("describes a zero lag as the same calendar day", () => {
    expect(
      formatCorrelationComparison({
        xLabel: "Protein",
        yLabel: "Heart Rate Variability",
        lag: 0,
      }),
    ).toBe("Protein vs Heart Rate Variability on the same calendar day");
  });

  it("states when the outcome precedes the input for a negative lag", () => {
    expect(
      formatCorrelationComparison({
        xLabel: "Protein",
        yLabel: "Heart Rate Variability",
        lag: -1,
      }),
    ).toBe("Protein today vs Heart Rate Variability 1 calendar day earlier");
  });
});
