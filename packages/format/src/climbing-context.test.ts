import { describe, expect, it } from "vitest";
import {
  formatClimbingLocationPath,
  formatClimbingResultStyle,
  formatClimbingStyle,
  formatClimbingWallAngle,
} from "./climbing-context.ts";

describe("climbing context labels", () => {
  it("displays the full location path in source order", () => {
    expect(
      formatClimbingLocationPath(
        ["Country", "Region", "District", "Town", "Crag", "Face"].map((name) => ({
          name,
          externalId: null,
          kind: null,
        })),
      ),
    ).toBe("Country > Region > District > Town > Crag > Face");
    expect(formatClimbingLocationPath([])).toBeNull();
  });

  it.each([
    ["lead", "Lead"],
    ["top-rope", "Top rope"],
    ["follow", "Follow"],
    ["solo", "Solo"],
    ["aid", "Aid"],
    [null, null],
  ] as const)("formats method %s as %s", (style, label) => {
    expect(formatClimbingStyle(style)).toBe(label);
  });

  it.each([
    ["Fell/Hung", "Fell or hung"],
    ["fell/hung", "Fell or hung"],
    ["Onsight", "Onsight"],
    ["Frenchfree", "Frenchfree"],
    ["A future result", "A future result"],
    [null, "Result unknown"],
  ])("formats the recorded result %s", (result, label) => {
    expect(formatClimbingResultStyle(result)).toBe(label);
  });

  it("labels unverified units without displaying a degree symbol", () => {
    expect(formatClimbingWallAngle({ value: -20, unit: null })).toBe(
      "Wall angle: −20 (units unknown)",
    );
    expect(formatClimbingWallAngle({ value: 40, unit: null })).toBe(
      "Wall angle: 40 (units unknown)",
    );
  });

  it("renders recorded degree angles including zero", () => {
    expect(formatClimbingWallAngle({ value: 0, unit: "degrees" })).toBe("Wall angle: 0°");
    expect(formatClimbingWallAngle({ value: -20, unit: "degrees" })).toBe("Wall angle: −20°");
    expect(formatClimbingWallAngle(null)).toBeNull();
  });

  it("preserves the exponent sign of a small positive angle", () => {
    expect(formatClimbingWallAngle({ value: 1e-7, unit: null })).toBe(
      "Wall angle: 1e-7 (units unknown)",
    );
  });
});
