import { describe, expect, it } from "vitest";
import { buildClimbingStrengths, type ClimbingStrengthsObservation } from "./climbing-strengths.ts";

const observation = (
  patch: Partial<ClimbingStrengthsObservation> = {},
): ClimbingStrengthsObservation => ({
  identity: "climb",
  contextKey: "boulder",
  laneKey: "boulder",
  gradeSystem: "v_scale",
  contextLabel: "Bouldering · V scale",
  setting: "indoor",
  grade: "V4",
  gradeSortValue: 4,
  wallAngle: null,
  holdType: null,
  outcome: "not_sent",
  example: {
    logEntryId: "log",
    activityId: null,
    name: "Problem",
    grade: "V4",
    date: "2026-10-20",
    providerId: "kaya",
    sourceName: "KAYA",
    sourceUrl: null,
    outcome: "not_sent",
  },
  ...patch,
});
const window = { startDate: "2026-08-15", endDate: "2026-10-20" };
const analyze = (observations: ClimbingStrengthsObservation[]) =>
  buildClimbingStrengths(observations, window);
const dated = (date: string, patch: Partial<ClimbingStrengthsObservation> = {}) => {
  const entry = observation(patch);
  return { ...entry, example: { ...entry.example, date } };
};
describe("climbing strengths", () => {
  it("labels a single grading system by climbing context without redundant system text", () => {
    const result = analyze([
      observation({ contextLabel: "Bouldering · V Scale" }),
      observation({
        contextKey: "lead",
        laneKey: "lead",
        contextLabel: "Lead · Yosemite Decimal System",
        gradeSystem: "yds",
        grade: "5.8",
      }),
    ]);
    expect(result.panels.find((panel) => panel.contextKey === "boulder")?.contextLabel).toBe(
      "Bouldering",
    );
    expect(result.panels.find((panel) => panel.contextKey === "lead")?.contextLabel).toBe("Lead");
  });

  it("retains grading system labels when the same climbing lane has different systems", () => {
    const result = analyze([
      observation({ contextKey: "v", contextLabel: "Bouldering · V Scale" }),
      observation({
        contextKey: "font",
        gradeSystem: "font",
        grade: "6b",
        contextLabel: "Bouldering · Fontainebleau",
      }),
    ]);
    expect(result.panels.find((panel) => panel.contextKey === "v")?.contextLabel).toBe(
      "Bouldering · V Scale",
    );
    expect(result.panels.find((panel) => panel.contextKey === "font")?.contextLabel).toBe(
      "Bouldering · Fontainebleau",
    );
  });
  it("pools distinct climbs across grades using counts and independent monthly outcomes", () => {
    const entries = [
      ...Array.from({ length: 5 }, (_, index) =>
        dated("2026-08-16", {
          identity: `easy-${index}`,
          grade: "V3",
          gradeSortValue: 3,
          holdType: index === 4 ? null : "crimp",
        }),
      ),
      dated("2026-08-16", { identity: "hard", grade: "V5", gradeSortValue: 5, holdType: "crimp" }),
      dated("2026-10-20", {
        identity: "hard",
        grade: "V5",
        gradeSortValue: 5,
        holdType: "crimp",
        outcome: "sent",
      }),
      dated("2026-10-20", { identity: "unknown", outcome: null, holdType: "crimp" }),
    ];
    const result = analyze(entries);
    const panel = result.panels.find((item) => item.dimension === "hold_type");
    expect(panel?.allGrades.grades).toEqual([
      { grade: "All grades", gradeSortValue: 0, sends: 1, climbs: 6, successRate: 17 },
    ]);
    expect(panel?.allGrades.rows[0]?.cells[0]).toMatchObject({
      grade: "All grades",
      sends: 1,
      climbs: 5,
      successRate: 20,
      differencePercentagePoints: 3,
      sampleStatus: "available",
    });
    expect(panel?.allGrades.rows[0]?.cells[0]?.examples).toHaveLength(3);
    expect(panel?.allGrades.progress[0]?.rows[0]?.cells[0]).toMatchObject({
      sends: 0,
      climbs: 5,
      successRate: 0,
    });
    expect(panel?.allGrades.progress[1]?.rows[0]?.cells[0]).toMatchObject({
      sends: 0,
      climbs: 0,
      successRate: null,
      sampleStatus: "no_data",
    });
    expect(panel?.allGrades.progress[2]?.rows[0]?.cells[0]).toMatchObject({
      sends: 1,
      climbs: 1,
      successRate: 100,
    });
    expect(panel?.grades.map((item) => item.grade)).toEqual(["V3", "V5"]);
  });
  it("projects independent monthly outcomes after whole-window context and trait resolution", () => {
    const result = analyze([
      dated("2026-08-15", { holdType: "crimp", wallAngle: { value: 0, unit: "degrees" } }),
      dated("2026-08-31", { outcome: null }),
      dated("2026-09-01", {
        grade: null,
        gradeSystem: null,
        contextKey: "missing",
        outcome: "sent",
        setting: null,
      }),
      dated("2026-10-20", { outcome: null }),
    ]);
    const panel = result.panels.find((candidatePanel) => candidatePanel.dimension === "hold_type");
    expect(panel?.rows[0]?.cells[0]).toMatchObject({ sends: 1, climbs: 1, successRate: 100 });
    expect(panel?.progress).toEqual([
      {
        startDate: "2026-08-15",
        endDate: "2026-08-31",
        rows: [
          {
            key: "crimp",
            cells: [{ grade: "V4", sends: 0, climbs: 1, successRate: 0, sampleStatus: "limited" }],
          },
        ],
      },
      {
        startDate: "2026-09-01",
        endDate: "2026-09-30",
        rows: [
          {
            key: "crimp",
            cells: [
              { grade: "V4", sends: 1, climbs: 1, successRate: 100, sampleStatus: "limited" },
            ],
          },
        ],
      },
      {
        startDate: "2026-10-01",
        endDate: "2026-10-20",
        rows: [
          {
            key: "crimp",
            cells: [
              { grade: "V4", sends: 0, climbs: 0, successRate: null, sampleStatus: "no_data" },
            ],
          },
        ],
      },
    ]);
    expect(
      result.panels.find((candidatePanel) => candidatePanel.dimension === "wall_angle")?.progress[1]
        ?.rows[0]?.key,
    ).toBe("0°");
  });
  it("retains empty clipped months, grade order and row keys while excluding global grade conflicts", () => {
    const result = analyze([
      dated("2026-08-16", { identity: "conflict" }),
      dated("2026-09-02", { identity: "conflict", grade: "V5", outcome: "sent" }),
      dated("2026-10-20", { identity: "kept", outcome: "sent", grade: "V3", gradeSortValue: 3 }),
      dated("2026-10-20", { identity: "failed", grade: "V4", gradeSortValue: 4 }),
    ]);
    const panel = result.panels.find((candidatePanel) => candidatePanel.dimension === "setting");
    expect(result.coverage.missingGrades).toBe(2);
    expect(panel?.progress[0]).toEqual({
      startDate: "2026-08-15",
      endDate: "2026-08-31",
      rows: [
        {
          key: "indoor",
          cells: [
            { grade: "V3", sends: 0, climbs: 0, successRate: null, sampleStatus: "no_data" },
            { grade: "V4", sends: 0, climbs: 0, successRate: null, sampleStatus: "no_data" },
          ],
        },
        {
          key: "outdoor",
          cells: [
            { grade: "V3", sends: 0, climbs: 0, successRate: null, sampleStatus: "no_data" },
            { grade: "V4", sends: 0, climbs: 0, successRate: null, sampleStatus: "no_data" },
          ],
        },
      ],
    });
    expect(panel?.progress[1]?.rows[0]?.cells[1]).toMatchObject({ climbs: 0, successRate: null });
    expect(panel?.progress[2]?.rows[0]?.cells[1]).toMatchObject({
      climbs: 1,
      sends: 0,
      successRate: 0,
    });
  });
  it("keeps monthly styles, grades and settings independent while deduplicating known outcomes", () => {
    const result = analyze([
      dated("2026-08-16", {
        identity: "sloper-high",
        holdType: "sloper",
        grade: "V10",
        gradeSortValue: 10,
        outcome: null,
      }),
      dated("2026-08-17", {
        identity: "crimp-high",
        holdType: "crimp",
        grade: "V10",
        gradeSortValue: 10,
        outcome: "sent",
      }),
      dated("2026-08-18", { identity: "sloper-low", holdType: "sloper" }),
      dated("2026-09-01", { identity: "sloper-low", holdType: "sloper", outcome: "sent" }),
      dated("2026-09-30", {
        identity: "sloper-high",
        holdType: "sloper",
        grade: "V10",
        gradeSortValue: 10,
        outcome: "sent",
      }),
      ...Array.from({ length: 5 }, (_, index) =>
        dated("2026-08-19", {
          identity: `crimp-low-${index}`,
          holdType: "crimp",
          outcome: index < 2 ? "sent" : "not_sent",
        }),
      ),
      dated("2026-08-20", { identity: "crimp-low-0", holdType: "crimp", outcome: null }),
      dated("2026-08-21", { identity: "crimp-low-0", holdType: "crimp" }),
      dated("2026-10-20", { identity: "crimp-low-0", holdType: "crimp", outcome: null }),
      dated("2026-08-20", {
        identity: "outdoor",
        holdType: "crimp",
        setting: "outdoor",
        outcome: "sent",
      }),
      dated("2026-08-20", {
        identity: "missing-trait",
        grade: "V8",
        gradeSortValue: 8,
        outcome: "sent",
      }),
    ]);
    const panel = result.panels.find(
      (panel) => panel.dimension === "hold_type" && panel.setting === "indoor",
    );
    expect(panel?.rows).toEqual([
      {
        key: "crimp",
        label: "Crimp",
        cells: [
          expect.objectContaining({
            grade: "V4",
            sends: 2,
            climbs: 5,
            successRate: 40,
            sampleStatus: "available",
          }),
          expect.objectContaining({
            grade: "V8",
            sends: 0,
            climbs: 0,
            successRate: null,
            differencePercentagePoints: null,
            sampleStatus: "no_data",
          }),
          expect.objectContaining({
            grade: "V10",
            sends: 1,
            climbs: 1,
            successRate: 100,
            sampleStatus: "limited",
          }),
        ],
      },
      {
        key: "sloper",
        label: "Sloper",
        cells: [
          expect.objectContaining({
            grade: "V4",
            sends: 1,
            climbs: 1,
            successRate: 100,
            sampleStatus: "limited",
          }),
          expect.objectContaining({
            grade: "V8",
            sends: 0,
            climbs: 0,
            successRate: null,
            differencePercentagePoints: null,
            sampleStatus: "no_data",
          }),
          expect.objectContaining({
            grade: "V10",
            sends: 1,
            climbs: 1,
            successRate: 100,
            sampleStatus: "limited",
          }),
        ],
      },
    ]);
    expect(panel?.progress).toEqual([
      {
        startDate: "2026-08-15",
        endDate: "2026-08-31",
        rows: [
          {
            key: "crimp",
            cells: [
              { grade: "V4", sends: 2, climbs: 5, successRate: 40, sampleStatus: "available" },
              { grade: "V8", sends: 0, climbs: 0, successRate: null, sampleStatus: "no_data" },
              { grade: "V10", sends: 1, climbs: 1, successRate: 100, sampleStatus: "limited" },
            ],
          },
          {
            key: "sloper",
            cells: [
              { grade: "V4", sends: 0, climbs: 1, successRate: 0, sampleStatus: "limited" },
              { grade: "V8", sends: 0, climbs: 0, successRate: null, sampleStatus: "no_data" },
              { grade: "V10", sends: 0, climbs: 0, successRate: null, sampleStatus: "no_data" },
            ],
          },
        ],
      },
      {
        startDate: "2026-09-01",
        endDate: "2026-09-30",
        rows: [
          {
            key: "crimp",
            cells: [
              { grade: "V4", sends: 0, climbs: 0, successRate: null, sampleStatus: "no_data" },
              { grade: "V8", sends: 0, climbs: 0, successRate: null, sampleStatus: "no_data" },
              { grade: "V10", sends: 0, climbs: 0, successRate: null, sampleStatus: "no_data" },
            ],
          },
          {
            key: "sloper",
            cells: [
              { grade: "V4", sends: 1, climbs: 1, successRate: 100, sampleStatus: "limited" },
              { grade: "V8", sends: 0, climbs: 0, successRate: null, sampleStatus: "no_data" },
              { grade: "V10", sends: 1, climbs: 1, successRate: 100, sampleStatus: "limited" },
            ],
          },
        ],
      },
      {
        startDate: "2026-10-01",
        endDate: "2026-10-20",
        rows: [
          {
            key: "crimp",
            cells: [
              { grade: "V4", sends: 0, climbs: 0, successRate: null, sampleStatus: "no_data" },
              { grade: "V8", sends: 0, climbs: 0, successRate: null, sampleStatus: "no_data" },
              { grade: "V10", sends: 0, climbs: 0, successRate: null, sampleStatus: "no_data" },
            ],
          },
          {
            key: "sloper",
            cells: [
              { grade: "V4", sends: 0, climbs: 0, successRate: null, sampleStatus: "no_data" },
              { grade: "V8", sends: 0, climbs: 0, successRate: null, sampleStatus: "no_data" },
              { grade: "V10", sends: 0, climbs: 0, successRate: null, sampleStatus: "no_data" },
            ],
          },
        ],
      },
    ]);
  });
  it("keeps globally conflicting settings outside setting-specific monthly samples", () => {
    const result = analyze([
      dated("2026-08-16", {
        identity: "conflict",
        setting: "indoor",
        holdType: "crimp",
        outcome: "sent",
      }),
      dated("2026-09-16", { identity: "conflict", setting: "outdoor", holdType: "crimp" }),
      dated("2026-08-20", { identity: "kept", holdType: "crimp" }),
    ]);
    const panel = result.panels.find(
      (panel) => panel.dimension === "hold_type" && panel.setting === "indoor",
    );
    expect(panel?.rows[0]?.cells[0]).toMatchObject({ sends: 0, climbs: 1, successRate: 0 });
    expect(panel?.progress[0]?.rows[0]?.cells[0]).toEqual({
      grade: "V4",
      sends: 0,
      climbs: 1,
      successRate: 0,
      sampleStatus: "limited",
    });
    expect(panel?.progress[1]?.rows[0]?.cells[0]).toEqual({
      grade: "V4",
      sends: 0,
      climbs: 0,
      successRate: null,
      sampleStatus: "no_data",
    });
    expect(result.panels.find((panel) => panel.dimension === "setting")?.grades[0]).toMatchObject({
      sends: 1,
      climbs: 2,
    });
  });
  it("returns empty coverage without inventing panels for an empty response", () => {
    expect(analyze([])).toEqual({
      panels: [],
      coverage: { unknownOutcomes: 0, missingGrades: 0, missingIdentity: 0 },
    });
  });
  it("clips a leap-year month and keeps a single-day window", () => {
    const entries = [dated("2024-02-29")];
    expect(
      buildClimbingStrengths(entries, {
        startDate: "2024-02-29",
        endDate: "2024-03-01",
      }).panels[0]?.progress.map(({ startDate, endDate }) => ({ startDate, endDate })),
    ).toEqual([
      { startDate: "2024-02-29", endDate: "2024-02-29" },
      { startDate: "2024-03-01", endDate: "2024-03-01" },
    ]);
    expect(
      buildClimbingStrengths(entries, { startDate: "2024-02-29", endDate: "2024-02-29" }).panels[0]
        ?.progress,
    ).toHaveLength(1);
  });
  it("counts each identified climb once and a send overrides repeated failures", () => {
    const result = analyze([
      observation(),
      observation(),
      observation({ outcome: "sent" }),
      observation({ identity: "other" }),
    ]);
    expect(
      result.panels.find((candidatePanel) => candidatePanel.dimension === "setting")?.grades[0],
    ).toMatchObject({
      climbs: 2,
      sends: 1,
      successRate: 50,
    });
  });
  it("excludes unknown-only outcomes and missing identity or grade visibly", () => {
    const result = analyze([
      observation({ outcome: null }),
      observation({ identity: null }),
      observation({ identity: "ungraded", grade: null }),
    ]);
    expect(result.coverage).toEqual({ unknownOutcomes: 1, missingIdentity: 1, missingGrades: 1 });
  });
  it("keeps settings separate, unknown units missing, and zero/no-data/limited distinct", () => {
    const result = analyze([
      observation({ wallAngle: { value: 20, unit: null } }),
      observation({
        identity: "out",
        setting: "outdoor",
        grade: "V5",
        gradeSortValue: 5,
        holdType: "crimp",
      }),
    ]);
    const indoor = result.panels.find(
      (candidatePanel) =>
        candidatePanel.dimension === "wall_angle" && candidatePanel.setting === "indoor",
    );
    expect(indoor?.coverage.missingTraits).toBe(1);
    const settings = result.panels.find((candidatePanel) => candidatePanel.dimension === "setting");
    expect(settings?.rows[0]?.cells[0]).toMatchObject({ successRate: 0, sampleStatus: "limited" });
    expect(settings?.rows[0]?.cells[1]).toMatchObject({
      successRate: null,
      sampleStatus: "no_data",
    });
    expect(
      result.panels.find(
        (candidatePanel) =>
          candidatePanel.dimension === "hold_type" && candidatePanel.setting === "outdoor",
      )?.rows[0]?.label,
    ).toBe("Crimp");
  });
  it("marks five climbs available, computes same-grade differences and caps examples", () => {
    const entries = Array.from({ length: 5 }, (_, index) =>
      observation({
        identity: `climb-${index}`,
        outcome: index < 2 ? "sent" : "not_sent",
        holdType: "crimp",
        wallAngle: { value: 0, unit: "degrees" },
      }),
    );
    const result = analyze([
      ...entries,
      observation({ identity: "sloper", holdType: "sloper", outcome: "sent" }),
    ]);
    const panel = result.panels.find((panel) => panel.dimension === "hold_type");
    expect(panel?.grades[0]).toMatchObject({ successRate: 50, climbs: 6 });
    expect(panel?.rows.find((row) => row.key === "crimp")?.cells[0]).toMatchObject({
      sampleStatus: "available",
      successRate: 40,
      differencePercentagePoints: -10,
    });
    expect(panel?.rows.find((row) => row.key === "crimp")?.cells[0]?.examples).toHaveLength(3);
  });
  it("keeps distinct climbs and semantic contexts independent and unknown does not erase known failure", () => {
    const result = analyze([
      observation({ outcome: null }),
      observation(),
      observation({ contextKey: "pitch", contextLabel: "Pitch", outcome: "sent" }),
      observation({ identity: "other", grade: "V5", gradeSortValue: 5, outcome: "sent" }),
    ]);
    const panel = result.panels.find(
      (panel) => panel.dimension === "setting" && panel.contextKey === "boulder",
    );
    expect(panel?.grades).toMatchObject([
      { grade: "V4", sends: 0, climbs: 1 },
      { grade: "V5", sends: 1, climbs: 1 },
    ]);
    expect(result.coverage.unknownOutcomes).toBe(0);
    expect(result.panels.some((panel) => panel.contextKey === "pitch")).toBe(true);
  });
  it("merges known setting and traits across observations without duplicating the climb", () => {
    const result = analyze([
      observation({ setting: null, outcome: "sent" }),
      observation({ holdType: "crimp", wallAngle: { value: 20, unit: "degrees" } }),
    ]);
    expect(result.panels.find((panel) => panel.dimension === "setting")?.grades[0]?.climbs).toBe(1);
    expect(
      result.panels.find((panel) => panel.dimension === "hold_type")?.rows[0]?.cells[0],
    ).toMatchObject({ sends: 1, climbs: 1 });
    expect(result.panels.find((panel) => panel.dimension === "wall_angle")?.rows[0]?.key).toBe(
      "20°",
    );
  });
  it("leaves conflicting recorded traits unknown", () => {
    const result = analyze([
      observation({
        outcome: "sent",
        holdType: "crimp",
        wallAngle: { value: 20, unit: "degrees" },
      }),
      observation({ holdType: "jug", wallAngle: { value: 30, unit: "degrees" } }),
    ]);
    expect(
      result.panels.find((panel) => panel.dimension === "wall_angle")?.coverage.missingTraits,
    ).toBe(1);
    expect(
      result.panels.find((panel) => panel.dimension === "hold_type")?.coverage.missingTraits,
    ).toBe(1);
  });
  it("excludes conflicting recognized grades for one identity with visible record coverage", () => {
    const result = analyze([
      observation(),
      observation({ grade: "V5", gradeSortValue: 5, outcome: "sent" }),
    ]);
    expect(result.coverage.missingGrades).toBe(2);
    expect(result.panels).toEqual([]);
  });
  it("uses a unique recognized grade from another observation without losing a send", () => {
    const result = analyze([
      observation({
        grade: null,
        gradeSystem: null,
        contextKey: "missing-system",
        contextLabel: "Grade missing",
        outcome: "sent",
      }),
      observation(),
    ]);
    expect(result.coverage.missingGrades).toBe(0);
    const panel = result.panels.find((panel) => panel.dimension === "setting");
    expect(panel).toMatchObject({ contextKey: "boulder", contextLabel: "Bouldering" });
    expect(panel?.grades[0]).toMatchObject({ grade: "V4", sends: 1, climbs: 1 });
    expect(panel?.rows[0]?.cells[0]?.examples[0]).toMatchObject({ grade: "V4", outcome: "sent" });
  });
  it("does not assign a send with a missing grade when two recognized grade systems remain possible", () => {
    const result = analyze([
      observation({ contextKey: "v", laneKey: "lane", gradeSystem: "v_scale" }),
      observation({ contextKey: "font", laneKey: "lane", gradeSystem: "font", grade: "6b" }),
      observation({
        contextKey: "unknown",
        laneKey: "lane",
        gradeSystem: null,
        grade: null,
        outcome: "sent",
      }),
    ]);
    expect(result.coverage.missingGrades).toBe(1);
    expect(
      result.panels
        .filter((panel) => panel.dimension === "setting")
        .map((panel) => panel.grades[0]?.sends),
    ).toEqual([0, 0]);
  });
  it("keeps a missing-system send isolated from another semantic lane for the same climb", () => {
    const result = analyze([
      observation(),
      observation({
        laneKey: "pitch",
        contextKey: "pitch-missing-system",
        contextLabel: "Pitch · Grade missing",
        gradeSystem: null,
        grade: null,
        outcome: "sent",
      }),
    ]);
    expect(result.coverage.missingGrades).toBe(1);
    const panels = result.panels.filter((panel) => panel.dimension === "setting");
    expect(panels).toHaveLength(1);
    expect(panels[0]).toMatchObject({ contextKey: "boulder", grades: [{ climbs: 1, sends: 0 }] });
  });
  it("excludes unidentified and missing-system observations without recognized grade evidence", () => {
    const result = analyze([
      observation({ identity: null }),
      observation({
        grade: null,
        gradeSystem: null,
        contextKey: "missing-system",
        outcome: "sent",
      }),
    ]);
    expect(result.coverage).toEqual({ missingIdentity: 1, missingGrades: 1, unknownOutcomes: 0 });
    expect(result.panels).toEqual([]);
  });
  it("requires an actual recognized grade before a declared system can establish ambiguity", () => {
    const result = analyze([
      observation(),
      observation({ contextKey: "font", gradeSystem: "font", grade: null }),
      observation({
        contextKey: "missing-system",
        gradeSystem: null,
        grade: null,
        outcome: "sent",
      }),
    ]);
    expect(result.coverage.missingGrades).toBe(1);
    const panels = result.panels.filter((panel) => panel.dimension === "setting");
    expect(panels).toHaveLength(1);
    expect(panels[0]).toMatchObject({
      contextKey: "boulder",
      grades: [{ climbs: 1, sends: 1, successRate: 100 }],
    });
  });
});
