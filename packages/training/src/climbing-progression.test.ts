import { describe, expect, it } from "vitest";
import {
  type ClimbingGradeProgressionLane,
  type ClimbingProgressionSetting,
  climbingProgressionGradeColor,
  climbingProgressionLaneLabel,
  climbingProgressionPeriodLabel,
  climbingProgressionValueLabel,
} from "./climbing-progression.ts";

const boulderingLane: ClimbingGradeProgressionLane = {
  style: "boulder",
  climbType: "boulder",
  gradeSystem: "v_scale",
  grades: [],
  settings: ["indoor"],
  axisMax: 1,
  axisInterval: 1,
  axisTicks: [0, 1],
  periods: [],
};

describe("climbingProgressionLaneLabel", () => {
  it("uses the style label when matching lanes share a grade scale", () => {
    expect(climbingProgressionLaneLabel(boulderingLane, [boulderingLane])).toBe("Bouldering");
    expect(climbingProgressionLaneLabel(boulderingLane, [boulderingLane, boulderingLane])).toBe(
      "Bouldering",
    );
  });

  it("qualifies both scales when a style retains different grade systems", () => {
    const fontLane: ClimbingGradeProgressionLane = { ...boulderingLane, gradeSystem: "font" };
    const lanes = [boulderingLane, fontLane];
    expect(climbingProgressionLaneLabel(boulderingLane, lanes)).toBe("Bouldering · V Scale");
    expect(climbingProgressionLaneLabel(fontLane, lanes)).toBe("Bouldering · Fontainebleau");
  });

  it("keeps different styles concise even when their grade systems differ", () => {
    const leadLane: ClimbingGradeProgressionLane = {
      ...boulderingLane,
      style: "lead",
      climbType: "route",
      gradeSystem: "yds",
    };
    const lanes = [boulderingLane, leadLane];
    expect(climbingProgressionLaneLabel(boulderingLane, lanes)).toBe("Bouldering");
    expect(climbingProgressionLaneLabel(leadLane, lanes)).toBe("Lead");
  });
});

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

  it("omits years by default for compact axis labels", () => {
    expect(climbingProgressionPeriodLabel({ startDate: "2026-07-01", endDate: "2026-08-31" })).toBe(
      "Jul–Aug",
    );
  });
});

describe("climbingProgressionGradeColor", () => {
  it.each([
    [0, 1, "hsl(160, 65%, 52%)"],
    [0, 5, "hsl(215, 16%, 65%)"],
    [2, 5, "hsl(188, 41%, 59%)"],
    [4, 5, "hsl(160, 65%, 52%)"],
  ])("keeps the grade palette consistent at position %i of %i", (index, gradeCount, color) => {
    expect(climbingProgressionGradeColor(index, gradeCount)).toBe(color);
  });

  it("distinguishes every grade in a dense lane", () => {
    const colors = Array.from({ length: 12 }, (_, index) =>
      climbingProgressionGradeColor(index, 12),
    );
    expect(new Set(colors).size).toBe(12);
  });
});

describe("climbingProgressionValueLabel", () => {
  const setting: ClimbingProgressionSetting = {
    setting: "indoor",
    climbingDays: 4,
    sends: 9,
    unknownOutcomes: 0,
    sendsPerDay: 2.25,
    segments: [{ grade: "V4", sends: 3, sendsPerDay: 0.75, stackStart: 0, stackEnd: 0.75 }],
  };

  it("formats the server's setting totals with one decimal place", () => {
    expect(climbingProgressionValueLabel(setting)).toBe(
      "2.3 sends/day · 9 sends · 4 recorded days",
    );
  });

  it("uses the selected grade's send count and rate with the setting's recorded days", () => {
    expect(climbingProgressionValueLabel(setting, setting.segments[0])).toBe(
      "0.8 sends/day · 3 sends · 4 recorded days",
    );
  });

  it("distinguishes known zero sends from no recorded days", () => {
    expect(climbingProgressionValueLabel({ ...setting, sends: 0, sendsPerDay: 0 })).toBe(
      "0.0 sends/day · 0 sends · 4 recorded days",
    );
    const missingSetting = { ...setting, climbingDays: 0, sends: 0, sendsPerDay: null };
    expect(climbingProgressionValueLabel(missingSetting)).toBe("No recorded days");
    expect(
      climbingProgressionValueLabel(missingSetting, {
        grade: "V4",
        sends: 0,
        sendsPerDay: null,
        stackStart: null,
        stackEnd: null,
      }),
    ).toBe("No recorded days");
  });

  it("uses singular labels and preserves an unrecorded-outcome qualifier", () => {
    expect(
      climbingProgressionValueLabel({
        ...setting,
        climbingDays: 1,
        sends: 1,
        sendsPerDay: 1,
        unknownOutcomes: 1,
      }),
    ).toBe("1.0 sends/day · 1 send · 1 recorded day · 1 outcome unrecorded");
  });

  it("pluralizes multiple unrecorded outcomes", () => {
    expect(climbingProgressionValueLabel({ ...setting, unknownOutcomes: 2 })).toBe(
      "2.3 sends/day · 9 sends · 4 recorded days · 2 outcomes unrecorded",
    );
  });
});
