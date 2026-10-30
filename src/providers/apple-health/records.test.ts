import { describe, expect, it } from "vitest";
import { parseRecord } from "./records.ts";

describe("parseRecord", () => {
  it.each(["Infinity", "-Infinity", "1e309", "-1e309", "NaN"])(
    "rejects nonfinite quantity %s before import classification",
    (value) => {
      expect(parseRecord({ type: "HKQuantityTypeIdentifierRunningPower", value })).toBeNull();
    },
  );

  it.each([
    ["0", 0],
    ["250.5", 250.5],
    ["1e3", 1000],
  ])("retains finite quantity %s", (value, expected) => {
    expect(
      parseRecord({ type: "HKQuantityTypeIdentifierRunningPower", value: String(value) })?.value,
    ).toBe(expected);
  });
});
