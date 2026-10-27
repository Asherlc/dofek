import { describe, expect, it } from "vitest";
import {
  formatClimbingAttemptCount,
  formatClimbingHoldTypes,
  formatClimbingLocationPath,
  formatClimbingRecordedOutcome,
  formatClimbingRopeMethod,
  formatClimbingWallAngle,
} from "./climbing-context.ts";

describe("climbing context labels", () => {
  it("formats every explicit grip with readable labels", () => {
    expect(formatClimbingHoldTypes(["crimp", "volume", "no_grips"])).toBe(
      "Hold types: crimp, volume, no grips",
    );
    expect(formatClimbingHoldTypes(null)).toBeNull();
  });
  it.each(["slab", "vertical", "overhang", "roof"] as const)(
    "formats the %s category without inventing degrees",
    (category) => {
      expect(formatClimbingWallAngle({ category })).toBe(
        `Wall angle: ${category[0]?.toUpperCase()}${category.slice(1)}`,
      );
    },
  );

  it("displays the full location path in source order", () => {
    expect(
      formatClimbingLocationPath(
        ["Country", "Region", "District", "Town", "Crag", "Face"].map((name) => ({
          name,
        })),
      ),
    ).toBe("Country > Region > District > Town > Crag > Face");
    expect(formatClimbingLocationPath([])).toBeNull();
  });

  it.each([
    ["lead", "Lead"],
    ["top_rope", "Top rope"],
    ["follow", "Follow"],
    ["unroped", "Unroped"],
    [null, null],
  ] as const)("formats method %s as %s", (style, label) => {
    expect(formatClimbingRopeMethod(style)).toBe(label);
  });

  it.each([
    ["climb", "completed", "Whole climb completed"],
    ["pitch", "completed", "Pitch completed"],
    ["climb", "failed", "Whole climb failed"],
    ["pitch", null, "Pitch outcome unknown"],
  ] as const)("formats the recorded %s result", (scope, result, label) => {
    expect(formatClimbingRecordedOutcome(scope, result)).toBe(label);
  });

  it("formats server-supplied recorded counts with singular and plural labels", () => {
    expect(formatClimbingAttemptCount(1)).toBe("1 recorded attempt");
    expect(formatClimbingAttemptCount(3)).toBe("3 recorded attempts");
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
