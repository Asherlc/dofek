import { describe, expect, it } from "vitest";
import { formatHealthspanTrendContext } from "./healthspan-context.ts";

describe("formatHealthspanTrendContext", () => {
  it.each([
    ["improving", "Improving"],
    ["declining", "Declining"],
    ["stable", "Stable"],
  ] as const)("names the recorded-score basis for %s trends", (trend, label) => {
    expect(formatHealthspanTrendContext(trend)).toBe(
      `Weekly trend across your recorded scores: ${label}`,
    );
  });
});
