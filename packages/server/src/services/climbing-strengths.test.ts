import type { ClimbingTag } from "@dofek/training/climbing-tags";
import { describe, expect, it } from "vitest";
import { buildClimbingStrengths } from "./climbing-strengths.ts";
import {
  analyze,
  dated,
  mixedSettingObservations,
  observation,
  progressCell,
} from "./climbing-strengths-test-helpers.ts";

const recordedTag = (patch: Partial<ClimbingTag> = {}): ClimbingTag => ({
  providerId: "kaya",
  sourceKey: "technical",
  label: "Technical",
  categoryKey: "style",
  categoryLabel: "Style",
  ...patch,
});

describe("recorded tag strengths", () => {
  it("unions recorded tags across repeated observations and counts each climb once per tag", () => {
    const technical = recordedTag();
    const balance = recordedTag({ sourceKey: "balance", label: "Balance" });
    const result = analyze([
      dated("2026-08-20", { tags: [technical, technical] }),
      dated("2026-09-01", { tags: [balance], outcome: "sent" }),
      dated("2026-10-20", { tags: [technical], outcome: null }),
      observation({ identity: "other", tags: [technical] }),
    ]);
    const panel = result.tagPanels?.[0];
    expect(panel).toMatchObject({
      dimension: "tag",
      category: { providerId: "kaya", key: "style", label: "Style" },
      grades: [{ grade: "V4", climbs: 2, sends: 1, unknownOutcomes: 0, successRate: 50 }],
      coverage: { missingTraits: 0, unknownOutcomes: 0 },
    });
    expect(
      panel?.rows.map((row) => [row.label, row.cells[0]?.climbs, row.cells[0]?.sends]),
    ).toEqual([
      ["Balance", 1, 1],
      ["Technical", 2, 1],
    ]);
    expect(panel?.progress.map((month) => month.rows[0]?.cells[0])).toEqual([
      progressCell("V4", 0, 1, 0, 0, "limited"),
      progressCell("V4", 1, 1, 0, 100, "limited"),
      progressCell("V4", 0, 1, 1, null, "limited"),
    ]);
    expect(panel?.allGrades.rows[0]?.cells[0]).toMatchObject({ climbs: 1, sends: 1 });
    expect(result.panels.map((panel) => panel.dimension)).toEqual([
      "wall_angle",
      "hold_type",
      "setting",
    ]);
  });

  it("keeps source and category identities distinct even when tag keys and labels collide", () => {
    const result = analyze([
      observation({
        tags: [
          recordedTag(),
          recordedTag({ categoryKey: "movement", categoryLabel: "Movement" }),
          recordedTag({ providerId: "other" }),
          recordedTag({ categoryKey: null, categoryLabel: null }),
        ],
      }),
    ]);
    expect(result.tagPanels).toHaveLength(4);
    expect(new Set(result.tagPanels?.map((panel) => panel.key)).size).toBe(4);
    expect(
      new Set(result.tagPanels?.flatMap((panel) => panel.rows.map((row) => row.key))).size,
    ).toBe(4);
    expect(result.tagPanels?.map((panel) => panel.category)).toEqual(
      expect.arrayContaining([
        { providerId: "kaya", key: "style", label: "Style" },
        { providerId: "kaya", key: "movement", label: "Movement" },
        { providerId: "other", key: "style", label: "Style" },
        { providerId: "kaya", key: null, label: "Uncategorized tags" },
      ]),
    );
  });

  it("uses all selected climbs for grade baselines and excludes unknown results from rates", () => {
    const result = analyze([
      observation({ identity: "low-tag", tags: [recordedTag()], outcome: "sent" }),
      observation({ identity: "low-other" }),
      observation({
        identity: "high-tag",
        grade: "V5",
        gradeSortValue: 5,
        tags: [recordedTag()],
        outcome: "sent",
      }),
      observation({
        identity: "high-unknown",
        grade: "V5",
        gradeSortValue: 5,
        tags: [recordedTag()],
        outcome: null,
      }),
    ]);
    const panel = result.tagPanels?.[0];
    expect(panel?.coverage).toEqual({ missingTraits: 1, unknownOutcomes: 1 });
    expect(panel?.rows[0]?.cells).toMatchObject([
      { climbs: 1, sends: 1, successRate: 100, differencePercentagePoints: 50 },
      { climbs: 2, sends: 1, unknownOutcomes: 1, successRate: 100, differencePercentagePoints: 0 },
    ]);
    expect(panel?.gradeAdjustedStrengths[0]).toMatchObject({
      expectedSuccessRate: 75,
      differencePercentagePoints: 25,
      sampleStatus: "limited",
    });
    expect(panel?.allGrades.rows[0]?.cells[0]).toMatchObject({
      climbs: 3,
      sends: 2,
      unknownOutcomes: 1,
      successRate: 100,
    });
  });

  it("keeps semantic lane baselines independent and excludes unresolved grades and identities", () => {
    const result = analyze([
      observation({ tags: [recordedTag()], outcome: "sent" }),
      observation({ identity: "boulder-other", outcome: "sent" }),
      observation({ contextKey: "lead", laneKey: "lead", tags: [recordedTag()] }),
      observation({ identity: "lead-other", contextKey: "lead", laneKey: "lead" }),
      observation({ identity: null, tags: [recordedTag()] }),
      observation({ identity: "ungraded", grade: null, tags: [recordedTag()] }),
    ]);
    expect(result.tagPanels?.[0]?.gradeAdjustedStrengths[0]).toMatchObject({
      expectedSuccessRate: 50,
      differencePercentagePoints: 0,
    });
    expect(result.coverage).toEqual({ missingIdentity: 1, missingGrades: 1, unknownOutcomes: 0 });
    expect(result.tagPanels?.[0]?.allGrades.rows[0]?.cells[0]).toMatchObject({
      climbs: 2,
      sends: 1,
    });
  });
});

it.each(["Lead", "Bouldering · V scale"])(
  "combines selected types while retaining their same-grade baselines (%s)",
  (contextLabel) => {
    const result = analyze([
      ...["b1", "b2", "b3"].map((identity, index) =>
        observation({ identity, outcome: "sent", holdTypes: [index < 2 ? "crimp" : "jug"] }),
      ),
      ...["l1", "l2", "l3", "l4"].map((identity, index) =>
        observation({
          identity,
          contextKey: "lead",
          contextLabel,
          laneKey: "lead",
          holdTypes: [index === 0 ? "crimp" : "jug"],
          outcome: "not_sent",
        }),
      ),
    ]);
    const panels = result.panels.filter((panel) => panel.dimension === "hold_type");
    expect(panels).toHaveLength(1);
    expect(panels[0]?.allGrades.rows.find((row) => row.key === "crimp")?.cells[0]).toMatchObject({
      climbs: 3,
      sends: 2,
      successRate: 67,
    });
    expect(
      panels[0]?.allGrades.progress.at(-1)?.rows.find((row) => row.key === "crimp")?.cells[0],
    ).toMatchObject({ climbs: 3, sends: 2, successRate: 67 });
    expect(panels[0]?.gradeAdjustedStrengths.find((row) => row.key === "crimp")).toMatchObject({
      expectedSuccessRate: 66.7,
      differencePercentagePoints: 0,
    });
  },
);

describe("climbing strengths", () => {
  it("counts each grip once while preserving distinct-climb grade baselines and monthly counts", () => {
    const result = analyze([
      observation({
        holdTypes: ["crimp", "sloper", "crimp"],
        wallAngle: { category: "slab" },
        outcome: "sent",
      }),
      observation({
        holdTypes: ["sloper", "crimp"],
        wallAngle: { category: "slab" },
        outcome: "sent",
      }),
      observation({ identity: "other", holdTypes: ["jug"] }),
    ]);
    const panel = result.panels.find((panel) => panel.dimension === "hold_type");
    expect(panel?.grades[0]).toMatchObject({ climbs: 2, sends: 1, successRate: 50 });
    expect(panel?.gradeAdjustedStrengths).toEqual([
      {
        key: "crimp",
        expectedSuccessRate: 50,
        differencePercentagePoints: 50,
        sampleStatus: "limited",
      },
      {
        key: "jug",
        expectedSuccessRate: 50,
        differencePercentagePoints: -50,
        sampleStatus: "limited",
      },
      {
        key: "sloper",
        expectedSuccessRate: 50,
        differencePercentagePoints: 50,
        sampleStatus: "limited",
      },
    ]);
    expect(panel?.allGrades.grades[0]).toMatchObject({ climbs: 2, sends: 1 });
    for (const key of ["crimp", "sloper"]) {
      expect(panel?.rows.find((row) => row.key === key)?.cells[0]).toMatchObject({
        climbs: 1,
        sends: 1,
      });
      expect(panel?.progress.at(-1)?.rows.find((row) => row.key === key)?.cells[0]).toMatchObject({
        climbs: 1,
        sends: 1,
      });
    }
    const angle = result.panels.find((panel) => panel.dimension === "wall_angle");
    expect(angle?.rows[0]).toMatchObject({
      key: "slab",
      label: "Slab",
      cells: [{ climbs: 1, sends: 1 }],
    });
  });

  it("keeps a known grip set with missing metadata but excludes contradictory sets", () => {
    const panel = analyze([
      observation({ holdTypes: ["crimp", "sloper"] }),
      observation({ holdTypes: null }),
      observation({ identity: "conflict", holdTypes: ["crimp", "sloper"] }),
      observation({ identity: "conflict", holdTypes: ["crimp"] }),
    ]).panels.find((panel) => panel.dimension === "hold_type");
    expect(panel?.coverage.missingTraits).toBe(1);
    expect(panel?.grades[0]?.climbs).toBe(2);
    expect(panel?.rows.map((row) => [row.key, row.cells[0]?.climbs])).toEqual([
      ["crimp", 1],
      ["sloper", 1],
    ]);
  });

  it("retains grades with unknown outcomes and computes rates only from known results", () => {
    const result = analyze([
      observation({ identity: "sent", outcome: "sent" }),
      observation({ identity: "failed" }),
      observation({ identity: "unknown", outcome: null }),
      observation({ identity: "unknown-grade", grade: "V6", gradeSortValue: 6, outcome: null }),
    ]);
    const panel = result.panels.find((panel) => panel.dimension === "setting");
    expect(panel?.grades).toMatchObject([
      { grade: "V4", sends: 1, climbs: 3, unknownOutcomes: 1, successRate: 50 },
      { grade: "V6", sends: 0, climbs: 1, unknownOutcomes: 1, successRate: null },
    ]);
    expect(panel?.allGrades.grades[0]).toMatchObject({
      sends: 1,
      climbs: 4,
      unknownOutcomes: 2,
      successRate: 50,
    });
    expect(panel?.rows[0]?.cells[1]).toMatchObject({
      climbs: 1,
      unknownOutcomes: 1,
      successRate: null,
      sampleStatus: "limited",
      examples: [{ outcome: null }],
    });
  });

  it("retains unknown results only in months with actual observations", () => {
    const result = analyze([
      dated("2026-09-15", { outcome: null }),
      dated("2026-09-16", { outcome: null }),
    ]);
    const panel = result.panels.find((panel) => panel.dimension === "setting");
    expect(panel?.progress.map((month) => month.rows[0]?.cells[0])).toMatchObject([
      { climbs: 0, unknownOutcomes: 0, successRate: null, sampleStatus: "no_data" },
      { climbs: 1, unknownOutcomes: 1, successRate: null, sampleStatus: "limited" },
      { climbs: 0, unknownOutcomes: 0, successRate: null, sampleStatus: "no_data" },
    ]);
  });

  it("shows genuinely unknown settings without dropping their known or unknown results", () => {
    const result = analyze([
      observation({ identity: "unknown", setting: null, outcome: null, holdTypes: ["crimp"] }),
      observation({ identity: "known", setting: null, outcome: "sent", holdTypes: ["crimp"] }),
    ]);
    const settings = result.panels.find((panel) => panel.dimension === "setting");
    expect(settings?.rows.find((row) => row.key === "unknown")).toMatchObject({
      label: "Unknown setting",
      cells: [{ sends: 1, climbs: 2, unknownOutcomes: 1, successRate: 100 }],
    });
    const holds = result.panels.find((panel) => panel.dimension === "hold_type");
    expect(holds?.rows[0]?.cells[0]).toMatchObject({
      sends: 1,
      climbs: 2,
      unknownOutcomes: 1,
      successRate: 100,
    });
  });

  it("resolves a known result without counting repeated unknown observations twice", () => {
    const result = analyze([
      observation({ outcome: null }),
      observation({ outcome: null }),
      observation({ outcome: "sent" }),
    ]);
    const panel = result.panels.find((panel) => panel.dimension === "setting");
    expect(panel?.grades[0]).toMatchObject({
      sends: 1,
      climbs: 1,
      unknownOutcomes: 0,
      successRate: 100,
    });
    expect(result.coverage.unknownOutcomes).toBe(0);
  });
  it("pools distinct climbs across grades using counts and independent monthly outcomes", () => {
    const entries = [
      ...Array.from({ length: 5 }, (_, index) =>
        dated("2026-08-16", {
          identity: `easy-${index}`,
          grade: "V3",
          gradeSortValue: 3,
          holdTypes: index === 4 ? null : ["crimp"],
        }),
      ),
      dated("2026-08-16", {
        identity: "hard",
        grade: "V5",
        gradeSortValue: 5,
        holdTypes: ["crimp"],
      }),
      dated("2026-10-20", {
        identity: "hard",
        grade: "V5",
        gradeSortValue: 5,
        holdTypes: ["crimp"],
        outcome: "sent",
      }),
      dated("2026-10-20", { identity: "unknown", outcome: null, holdTypes: ["crimp"] }),
    ];
    const result = analyze(entries);
    const panel = result.panels.find((item) => item.dimension === "hold_type");
    expect(panel?.allGrades.grades).toEqual([
      {
        grade: "All grades",
        gradeSortValue: 0,
        sends: 1,
        climbs: 7,
        unknownOutcomes: 1,
        successRate: 17,
      },
    ]);
    expect(panel?.allGrades.rows[0]?.cells[0]).toMatchObject({
      grade: "All grades",
      sends: 1,
      climbs: 6,
      unknownOutcomes: 1,
      successRate: 20,
      differencePercentagePoints: 3,
      sampleStatus: "available",
    });
    expect(panel?.allGrades.rows[0]?.cells[0]?.examples).toHaveLength(3);
    expect(panel?.allGrades.progress[0]?.rows[0]?.cells[0]).toMatchObject({
      sends: 0,
      climbs: 5,
      unknownOutcomes: 0,
      successRate: 0,
    });
    expect(panel?.allGrades.progress[1]?.rows[0]?.cells[0]).toMatchObject({
      sends: 0,
      climbs: 0,
      unknownOutcomes: 0,
      successRate: null,
      sampleStatus: "no_data",
    });
    expect(panel?.allGrades.progress[2]?.rows[0]?.cells[0]).toMatchObject({
      sends: 1,
      climbs: 2,
      unknownOutcomes: 1,
      successRate: 100,
    });
    expect(panel?.grades.map((item) => item.grade)).toEqual(["V3", "V4", "V5"]);
  });
  it("projects independent monthly outcomes after whole-window context and trait resolution", () => {
    const result = analyze([
      dated("2026-08-15", { holdTypes: ["crimp"], wallAngle: { value: 0, unit: "degrees" } }),
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
    expect(panel?.rows[0]?.cells[0]).toMatchObject({
      sends: 1,
      climbs: 1,
      unknownOutcomes: 0,
      successRate: 100,
    });
    expect(panel?.progress).toEqual([
      {
        startDate: "2026-08-15",
        endDate: "2026-08-31",
        rows: [
          {
            key: "crimp",
            cells: [progressCell("V4", 0, 1, 0, 0, "limited")],
          },
        ],
      },
      {
        startDate: "2026-09-01",
        endDate: "2026-09-30",
        rows: [
          {
            key: "crimp",
            cells: [progressCell("V4", 1, 1, 0, 100, "limited")],
          },
        ],
      },
      {
        startDate: "2026-10-01",
        endDate: "2026-10-20",
        rows: [
          {
            key: "crimp",
            cells: [progressCell("V4", 0, 1, 1, null, "limited")],
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
            progressCell("V3", 0, 0, 0, null, "no_data"),
            progressCell("V4", 0, 0, 0, null, "no_data"),
          ],
        },
        {
          key: "outdoor",
          cells: [
            progressCell("V3", 0, 0, 0, null, "no_data"),
            progressCell("V4", 0, 0, 0, null, "no_data"),
          ],
        },
      ],
    });
    expect(panel?.progress[1]?.rows[0]?.cells[1]).toMatchObject({
      climbs: 0,
      unknownOutcomes: 0,
      successRate: null,
    });
    expect(panel?.progress[2]?.rows[0]?.cells[1]).toMatchObject({
      climbs: 1,
      sends: 0,
      successRate: 0,
    });
  });
  it("keeps monthly styles and grades independent across the selected cohort while deduplicating known outcomes", () => {
    const result = analyze([
      dated("2026-08-16", {
        identity: "sloper-high",
        holdTypes: ["sloper"],
        grade: "V10",
        gradeSortValue: 10,
        outcome: null,
      }),
      dated("2026-08-17", {
        identity: "crimp-high",
        holdTypes: ["crimp"],
        grade: "V10",
        gradeSortValue: 10,
        outcome: "sent",
      }),
      dated("2026-08-18", { identity: "sloper-low", holdTypes: ["sloper"] }),
      dated("2026-09-01", { identity: "sloper-low", holdTypes: ["sloper"], outcome: "sent" }),
      dated("2026-09-30", {
        identity: "sloper-high",
        holdTypes: ["sloper"],
        grade: "V10",
        gradeSortValue: 10,
        outcome: "sent",
      }),
      ...Array.from({ length: 5 }, (_, index) =>
        dated("2026-08-19", {
          identity: `crimp-low-${index}`,
          holdTypes: ["crimp"],
          outcome: index < 2 ? "sent" : "not_sent",
        }),
      ),
      dated("2026-08-20", { identity: "crimp-low-0", holdTypes: ["crimp"], outcome: null }),
      dated("2026-08-21", { identity: "crimp-low-0", holdTypes: ["crimp"] }),
      dated("2026-10-20", { identity: "crimp-low-0", holdTypes: ["crimp"], outcome: null }),
      dated("2026-08-20", {
        identity: "outdoor",
        holdTypes: ["crimp"],
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
    const panel = result.panels.find((panel) => panel.dimension === "hold_type");
    expect(panel?.rows).toEqual([
      {
        key: "crimp",
        label: "Crimp",
        cells: [
          expect.objectContaining(progressCell("V4", 3, 6, 0, 50, "available")),
          expect.objectContaining({
            grade: "V8",
            sends: 0,
            climbs: 0,
            unknownOutcomes: 0,
            successRate: null,
            differencePercentagePoints: null,
            sampleStatus: "no_data",
          }),
          expect.objectContaining(progressCell("V10", 1, 1, 0, 100, "limited")),
        ],
      },
      {
        key: "sloper",
        label: "Sloper",
        cells: [
          expect.objectContaining(progressCell("V4", 1, 1, 0, 100, "limited")),
          expect.objectContaining({
            grade: "V8",
            sends: 0,
            climbs: 0,
            unknownOutcomes: 0,
            successRate: null,
            differencePercentagePoints: null,
            sampleStatus: "no_data",
          }),
          expect.objectContaining(progressCell("V10", 1, 1, 0, 100, "limited")),
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
              progressCell("V4", 3, 6, 0, 50, "available"),
              progressCell("V8", 0, 0, 0, null, "no_data"),
              progressCell("V10", 1, 1, 0, 100, "limited"),
            ],
          },
          {
            key: "sloper",
            cells: [
              progressCell("V4", 0, 1, 0, 0, "limited"),
              progressCell("V8", 0, 0, 0, null, "no_data"),
              progressCell("V10", 0, 1, 1, null, "limited"),
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
              progressCell("V4", 0, 0, 0, null, "no_data"),
              progressCell("V8", 0, 0, 0, null, "no_data"),
              progressCell("V10", 0, 0, 0, null, "no_data"),
            ],
          },
          {
            key: "sloper",
            cells: [
              progressCell("V4", 1, 1, 0, 100, "limited"),
              progressCell("V8", 0, 0, 0, null, "no_data"),
              progressCell("V10", 1, 1, 0, 100, "limited"),
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
              progressCell("V4", 0, 1, 1, null, "limited"),
              progressCell("V8", 0, 0, 0, null, "no_data"),
              progressCell("V10", 0, 0, 0, null, "no_data"),
            ],
          },
          {
            key: "sloper",
            cells: [
              progressCell("V4", 0, 0, 0, null, "no_data"),
              progressCell("V8", 0, 0, 0, null, "no_data"),
              progressCell("V10", 0, 0, 0, null, "no_data"),
            ],
          },
        ],
      },
    ]);
  });
  it("keeps observations with conflicting setting facts in the selected cohort", () => {
    const result = analyze([
      dated("2026-08-16", {
        identity: "conflict",
        setting: "indoor",
        holdTypes: ["crimp"],
        outcome: "sent",
      }),
      dated("2026-09-16", { identity: "conflict", setting: "outdoor", holdTypes: ["crimp"] }),
      dated("2026-08-20", { identity: "kept", holdTypes: ["crimp"] }),
    ]);
    const panel = result.panels.find((panel) => panel.dimension === "hold_type");
    expect(panel?.rows[0]?.cells[0]).toMatchObject({
      sends: 1,
      climbs: 2,
      unknownOutcomes: 0,
      successRate: 50,
    });
    expect(panel?.progress[0]?.rows[0]?.cells[0]).toEqual(
      progressCell("V4", 1, 2, 0, 50, "limited"),
    );
    expect(panel?.progress[1]?.rows[0]?.cells[0]).toEqual(
      progressCell("V4", 0, 1, 0, 0, "limited"),
    );
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
  it("keeps unknown units missing and zero/no-data/limited distinct in the selected cohort", () => {
    const result = analyze([
      observation({ wallAngle: { value: 20, unit: null } }),
      observation({
        identity: "out",
        setting: "outdoor",
        grade: "V5",
        gradeSortValue: 5,
        holdTypes: ["crimp"],
      }),
    ]);
    const indoor = result.panels.find(
      (candidatePanel) => candidatePanel.dimension === "wall_angle",
    );
    expect(indoor?.coverage.missingTraits).toBe(2);
    const settings = result.panels.find((candidatePanel) => candidatePanel.dimension === "setting");
    expect(settings?.rows[0]?.cells[0]).toMatchObject({ successRate: 0, sampleStatus: "limited" });
    expect(settings?.rows[0]?.cells[1]).toMatchObject({
      successRate: null,
      sampleStatus: "no_data",
    });
    expect(
      result.panels.find((candidatePanel) => candidatePanel.dimension === "hold_type")?.rows[0]
        ?.label,
    ).toBe("Crimp");
  });
  it("marks five climbs available, computes same-grade differences and caps examples", () => {
    const entries = Array.from({ length: 5 }, (_, index) =>
      observation({
        identity: `climb-${index}`,
        outcome: index < 2 ? "sent" : "not_sent",
        holdTypes: ["crimp"],
        wallAngle: { value: 0, unit: "degrees" },
      }),
    );
    const result = analyze([
      ...entries,
      observation({ identity: "sloper", holdTypes: ["sloper"], outcome: "sent" }),
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
    const panel = result.panels.find((panel) => panel.dimension === "setting");
    expect(panel?.grades).toMatchObject([
      { grade: "V4 · Bouldering · V scale", sends: 0, climbs: 1 },
      { grade: "V4 · Pitch", sends: 1, climbs: 1 },
      { grade: "V5 · Bouldering · V scale", sends: 1, climbs: 1 },
    ]);
    expect(result.coverage.unknownOutcomes).toBe(0);
  });
  it("merges known setting and traits across observations without duplicating the climb", () => {
    const result = analyze([
      observation({ setting: null, outcome: "sent" }),
      observation({ holdTypes: ["crimp"], wallAngle: { value: 20, unit: "degrees" } }),
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
        holdTypes: ["crimp"],
        wallAngle: { value: 20, unit: "degrees" },
      }),
      observation({ holdTypes: ["jug"], wallAngle: { value: 30, unit: "degrees" } }),
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
        .flatMap((panel) => panel.grades.map((grade) => grade.sends)),
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

it("builds one selected-cohort profile across the settings selected by the filter", () => {
  const result = analyze(mixedSettingObservations());
  for (const dimension of ["wall_angle", "hold_type"]) {
    const panels = result.panels.filter((panel) => panel.dimension === dimension);
    expect(panels).toHaveLength(1);
    expect(panels[0]?.rows[0]?.cells[0]).toMatchObject({ climbs: 2, sends: 1, successRate: 50 });
    expect(panels[0]?.gradeAdjustedStrengths[0]).toMatchObject({ differencePercentagePoints: 0 });
  }
});
