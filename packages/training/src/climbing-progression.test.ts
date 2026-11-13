import { describe, expect, it } from "vitest";
import {
  type ClimbingGradeProgressionData,
  type ClimbingProgressionGrade,
  type ClimbingProgressionPeriod,
  climbingGradeProgressionSchema,
  climbingProgressionGradeColor,
  climbingProgressionGradeLabel,
  climbingProgressionLaneKey,
  climbingProgressionPeriodLabel,
  climbingProgressionValueLabel,
} from "./climbing-progression.ts";

const boulderGrade: ClimbingProgressionGrade = {
  key: '["boulder","v_scale","V4"]',
  climbKind: "boulder",
  gradeSystem: "v_scale",
  grade: "V4",
  gradeSortValue: 65,
};
describe("climbingProgressionGradeLabel", () => {
  it("preserves native grade labels when no other scale uses that label", () => {
    const routeGrade: ClimbingProgressionGrade = {
      key: '["route","yds","5.10a"]',
      climbKind: "route",
      gradeSystem: "yds",
      grade: "5.10a",
      gradeSortValue: 61,
    };
    const grades = [boulderGrade, routeGrade];
    expect(climbingProgressionGradeLabel(boulderGrade, grades)).toBe("V4");
    expect(climbingProgressionGradeLabel(routeGrade, grades)).toBe("5.10a");
  });
  it("qualifies identical native labels with their grading scales", () => {
    const font: ClimbingProgressionGrade = {
      ...boulderGrade,
      key: "font-6A",
      grade: "6A",
      gradeSystem: "font",
    };
    const french: ClimbingProgressionGrade = {
      ...font,
      key: "french-6A",
      climbKind: "route",
      gradeSystem: "french",
    };
    expect(climbingProgressionGradeLabel(font, [font, french])).toBe("6A · Fontainebleau");
    expect(climbingProgressionGradeLabel(french, [font, french])).toBe("6A · French");
  });
});

describe("climbingGradeProgressionSchema", () => {
  const chart: ClimbingGradeProgressionData = {
    grades: [boulderGrade],
    axisMax: 1,
    axisInterval: 1,
    axisTicks: [0, 1],
    periods: [],
  };
  it("accepts the server-computed combined chart", () => {
    expect(climbingGradeProgressionSchema.parse(chart)).toEqual(chart);
  });
  const populatedChart: ClimbingGradeProgressionData = {
    ...chart,
    axisMax: 3,
    axisTicks: [0, 1, 2, 3],
    periods: [
      {
        startDate: "2026-01-01",
        endDate: "2026-01-31",
        climbingDays: 4,
        sends: 9,
        unknownOutcomes: 2,
        sendsPerDay: 2.25,
        segments: [
          {
            gradeKey: boulderGrade.key,
            sends: 9,
            sendsPerDay: 2.25,
            stackStart: 0,
            stackEnd: 2.25,
          },
        ],
      },
      {
        startDate: "2026-02-01",
        endDate: "2026-02-28",
        climbingDays: 0,
        sends: 0,
        unknownOutcomes: 0,
        sendsPerDay: null,
        segments: [
          {
            gradeKey: boulderGrade.key,
            sends: 0,
            sendsPerDay: null,
            stackStart: null,
            stackEnd: null,
          },
        ],
      },
    ],
  };
  it("accepts populated grade stacks and null rates for unrecorded periods", () => {
    expect(climbingGradeProgressionSchema.parse(populatedChart)).toEqual(populatedChart);
  });
  it("requires every grade segment's send count", () => {
    const result = climbingGradeProgressionSchema.safeParse({
      ...populatedChart,
      periods: populatedChart.periods.map((period) => ({
        ...period,
        segments: period.segments.map((segment) => ({ ...segment, sends: undefined })),
      })),
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("Missing segment count accepted");
    expect(result.error.issues[0]?.path).toEqual(["periods", 0, "segments", 0, "sends"]);
  });
  it.each([-1, 0.5, null])("rejects an invalid recorded-day count %s", (climbingDays) => {
    const result = climbingGradeProgressionSchema.safeParse({
      ...populatedChart,
      periods: populatedChart.periods.map((period) => ({ ...period, climbingDays })),
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("Invalid recorded-day count accepted");
    expect(result.error.issues[0]?.path).toEqual(["periods", 0, "climbingDays"]);
  });
  it("checks each grade's scale against its climb kind", () => {
    const result = climbingGradeProgressionSchema.safeParse({
      ...chart,
      grades: [{ ...boulderGrade, gradeSystem: "yds" }],
    });
    expect(result.success).toBe(false);
    if (result.success) throw new Error("Invalid grade scale accepted");
    expect(result.error.issues[0]?.path).toEqual(["grades", 0, "gradeSystem"]);
  });
});

describe("climbingProgressionLaneKey", () => {
  it("retains independent method, solo, aid and scope identities for strengths", () => {
    const lane = {
      climbKind: "route" as const,
      attemptScope: "climb" as const,
      ropeMethod: "lead" as const,
      solo: false,
      usedAid: false,
    };
    expect(climbingProgressionLaneKey(lane)).toBe('["route","climb","lead",false,false]');
    expect(
      climbingProgressionLaneKey({ ...lane, attemptScope: "pitch", solo: true, usedAid: true }),
    ).toBe('["route","pitch","lead",true,true]');
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
  const setting: ClimbingProgressionPeriod = {
    startDate: "2026-01-01",
    endDate: "2026-01-31",
    climbingDays: 4,
    sends: 9,
    unknownOutcomes: 0,
    sendsPerDay: 2.25,
    segments: [
      { gradeKey: boulderGrade.key, sends: 3, sendsPerDay: 0.75, stackStart: 0, stackEnd: 0.75 },
    ],
  };

  it("formats the server's period totals with one decimal place", () => {
    expect(climbingProgressionValueLabel(setting)).toBe(
      "2.3 sends/day · 9 sends · 4 recorded days",
    );
  });

  it("uses the selected grade's send count and rate with the period's recorded days", () => {
    expect(climbingProgressionValueLabel(setting, setting.segments[0])).toBe(
      "0.8 sends/day · 3 sends · 4 recorded days",
    );
  });

  it("keeps period-wide unrecorded outcomes out of grade-specific labels", () => {
    expect(
      climbingProgressionValueLabel({ ...setting, unknownOutcomes: 2 }, setting.segments[0]),
    ).toBe("0.8 sends/day · 3 sends · 4 recorded days");
  });

  it("distinguishes known zero sends from no recorded days", () => {
    expect(climbingProgressionValueLabel({ ...setting, sends: 0, sendsPerDay: 0 })).toBe(
      "0.0 sends/day · 0 sends · 4 recorded days",
    );
    const missingSetting = { ...setting, climbingDays: 0, sends: 0, sendsPerDay: null };
    expect(climbingProgressionValueLabel(missingSetting)).toBe("No recorded days");
    expect(
      climbingProgressionValueLabel(missingSetting, {
        gradeKey: boulderGrade.key,
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
