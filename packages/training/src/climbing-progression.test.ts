import { describe, expect, it } from "vitest";
import { climbingProgressionPeriodLabel } from "./climbing-progression.ts";

describe("climbingProgressionPeriodLabel", () => {
  it.each([
    ["2026-07-01", "2026-07-31", "Jul", "Jul 2026"],
    ["2026-07-01", "2026-08-31", "Jul–Aug", "Jul–Aug 2026"],
    ["2025-12-01", "2026-01-31", "Dec–Jan", "Dec 2025–Jan 2026"],
  ])("formats calendar months without time zone shifts", (startDate, endDate, short, long) => {
    expect(climbingProgressionPeriodLabel({ startDate, endDate }, false, "en-US")).toBe(short);
    expect(climbingProgressionPeriodLabel({ startDate, endDate }, true, "en-US")).toBe(long);
  });
  it("uses the viewer's locale", () => {
    expect(
      climbingProgressionPeriodLabel(
        { startDate: "2026-07-01", endDate: "2026-07-31" },
        true,
        "fr-FR",
      ),
    ).toBe("juil. 2026");
  });
});
