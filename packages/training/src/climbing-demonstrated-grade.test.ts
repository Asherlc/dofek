import { describe, expect, it } from "vitest";
import {
  buildDemonstratedGrade,
  climbingDemonstratedGradeSchema,
  type DemonstratedGradeObservation,
  demonstratedGradeInputSchema,
  demonstratedGradeObservationSchema,
  demonstratedGradeWindow,
} from "./climbing-demonstrated-grade.ts";
import { DEFAULT_CLIMBING_GRADE_PREFERENCE, gradeSortValue } from "./climbing-grades.ts";

/**
 * Behavioral contract for the 3:3:3 insight. These cases are written before the
 * implementation so the shared result shape, the exact-grade aggregation and the
 * evidence/identity rules are pinned by tests rather than inferred from charts.
 *
 * A `DemonstratedGradeObservation` is one recorded *attempt*. Clean execution,
 * rope method and the original ascent label all live on that same attempt; the
 * repository must not combine facts from different attempts of one log.
 */
function observation(
  overrides: Partial<DemonstratedGradeObservation> = {},
): DemonstratedGradeObservation {
  return demonstratedGradeObservationSchema.parse({
    attemptId: "attempt-1",
    targetId: "kaya:climb-1",
    provider: "kaya",
    providerId: "climb-kaya",
    climbKind: "boulder",
    climbSetting: "indoor",
    ropeMethod: null,
    attemptScope: "climb",
    cleanFreeSend: true,
    compatibilityBlank: false,
    ascentStyle: "Flash",
    climbedOn: "2026-11-12",
    gradeComponents: [{ value: "V4", system: "v_scale" }],
    displayName: "Blue Arete",
    logEntryId: "log-1",
    activityId: "activity-1",
    climbExternalId: "climb-1",
    sourceUrl: "https://example.test/climb-1",
    ...overrides,
  });
}

function gradeSet(observations: DemonstratedGradeObservation[], endDate = "2026-11-21") {
  const result = buildDemonstratedGrade({
    endDate,
    preference: DEFAULT_CLIMBING_GRADE_PREFERENCE,
    coverage: { fullWindow: true, startDate: "2026-08-22", endDate },
    observations,
  });
  return climbingDemonstratedGradeSchema.parse(result);
}

function cell(
  result: ReturnType<typeof gradeSet>,
  type: "bouldering" | "lead" | "top_rope" | "unroped",
  setting: "indoor" | "outdoor",
) {
  const found = result.cells.find((entry) => entry.type === type && entry.setting === setting);
  if (!found) throw new Error(`Missing cell ${type}/${setting}`);
  return found;
}

describe("demonstratedGradeWindow", () => {
  it.each([
    ["2026-11-21", "2026-08-22"],
    ["2026-05-31", "2026-03-01"],
    ["2026-03-31", "2026-01-01"],
    ["2024-02-28", "2023-11-29"],
  ])("uses the trailing three calendar months ending %s", (endDate, startDate) => {
    expect(demonstratedGradeWindow(endDate)).toEqual({ startDate, endDate });
  });
});

describe("climbingDemonstratedGrade contracts", () => {
  it("preserves the climbing progression tool's evidence filters", () => {
    const input = {
      endDate: "2026-11-21",
      filters: { types: ["top_rope", "follow"], setting: ["outdoor"] },
      sources: ["climb-kaya"],
      locations: ["Pacific Pipe"],
      gradeSystems: ["v_scale"],
    };
    expect(demonstratedGradeInputSchema.parse(input)).toEqual(input);
  });

  it("always returns eight camelCase cells, the window and a partial-access qualifier", () => {
    const result = gradeSet([]);
    expect(result.startDate).toBe("2026-08-22");
    expect(result.endDate).toBe("2026-11-21");
    expect(result.coverage.fullWindow).toBe(true);
    expect(result.cells).toHaveLength(8);
    expect(result.method).toContain("IRCRA 3:3:3");
    expect(result.minimumDistinctClimbs).toBe(3);
    expect(result.cells.every((entry) => entry.grades.length === 0)).toBe(true);
    expect(
      climbingDemonstratedGradeSchema.parse({
        ...result,
        coverage: { fullWindow: false, startDate: "2026-10-01", endDate: result.endDate },
      }).coverage.fullWindow,
    ).toBe(false);
  });
});

describe("buildDemonstratedGrade evidence selection", () => {
  it("qualifies three different targets at one exact grade with clean free sends", () => {
    const result = gradeSet([
      observation({ attemptId: "a1", targetId: "k:1", ascentStyle: "Flash" }),
      observation({
        attemptId: "a2",
        targetId: "k:2",
        ascentStyle: "Redpoint",
        climbedOn: "2026-10-24",
      }),
      observation({ attemptId: "a3", targetId: "k:3", ascentStyle: null, climbedOn: "2026-09-18" }),
    ]);
    const indoorBoulder = cell(result, "bouldering", "indoor");
    expect(indoorBoulder.grades).toHaveLength(1);
    expect(indoorBoulder.grades[0]).toMatchObject({
      grade: "V4",
      gradeSystem: "v_scale",
      count: 3,
    });
    expect(indoorBoulder.grades[0].sends.map((send) => send.displayName)).toEqual([
      "Blue Arete",
      "Blue Arete",
      "Blue Arete",
    ]);
    expect(indoorBoulder.grades[0].sends.map((send) => send.ascentStyle)).toEqual([
      "Flash",
      "Redpoint",
      null,
    ]);
    expect(cell(result, "bouldering", "outdoor").grades).toHaveLength(0);
  });

  it("leaves the demonstrated grade in place when isolated harder sends appear", () => {
    const result = gradeSet([
      observation({ targetId: "k:1" }),
      observation({ targetId: "k:2" }),
      observation({ targetId: "k:3" }),
      observation({
        targetId: "k:hard-1",
        attemptId: "h1",
        gradeComponents: [{ value: "V6", system: "v_scale" }],
      }),
      observation({
        targetId: "k:hard-2",
        attemptId: "h2",
        gradeComponents: [{ value: "V6", system: "v_scale" }],
      }),
    ]);
    expect(cell(result, "bouldering", "indoor").grades.map((grade) => grade.grade)).toEqual(["V4"]);
  });

  it.each([
    [
      "three repeats of one target",
      [
        observation({ targetId: "k:1", attemptId: "a1", climbedOn: "2026-11-01" }),
        observation({ targetId: "k:1", attemptId: "a2", climbedOn: "2026-10-01" }),
        observation({ targetId: "k:1", attemptId: "a3", climbedOn: "2026-09-01" }),
      ],
    ],
    [
      "three different exact grades",
      [
        observation({ targetId: "k:1" }),
        observation({ targetId: "k:2", gradeComponents: [{ value: "V5", system: "v_scale" }] }),
        observation({ targetId: "k:3", gradeComponents: [{ value: "V6", system: "v_scale" }] }),
      ],
    ],
    [
      "dabs, aid, falls, pitch-only, blank compatibility and unresolved outcomes",
      [
        observation({ targetId: "k:1", cleanFreeSend: false, ascentStyle: "Dab" }),
        observation({ targetId: "k:2", cleanFreeSend: false, ascentStyle: "Aid" }),
        observation({ targetId: "k:3", cleanFreeSend: false, ascentStyle: "Fall" }),
        observation({ targetId: "k:4", attemptScope: "pitch" }),
        observation({ targetId: "k:5", compatibilityBlank: true }),
        observation({ targetId: "k:6", cleanFreeSend: null, ascentStyle: null }),
      ],
    ],
    [
      "unknown setting or unknown method",
      [
        observation({ targetId: "k:1", climbSetting: null }),
        observation({ targetId: "k:2", climbSetting: null }),
        observation({ targetId: "k:3", climbSetting: null }),
        observation({ targetId: "k:4", ropeMethod: null, climbKind: "route" }),
        observation({ targetId: "k:5", ropeMethod: null, climbKind: "route" }),
        observation({ targetId: "k:6", ropeMethod: null, climbKind: "route" }),
      ],
    ],
  ] as const)("does not establish a grade from %s", (_label, observations) => {
    const result = gradeSet(demonstratedGradeObservationSchema.array().parse(observations));
    expect(result.cells.every((entry) => entry.grades.length === 0)).toBe(true);
  });

  it("requires clean execution and the pooled method on the same attempt id", () => {
    const result = gradeSet([
      // Clean send carries no method; the top-rope attempt is not a clean send.
      observation({ attemptId: "clean", targetId: "k:1", ropeMethod: null, cleanFreeSend: true }),
      observation({
        attemptId: "tr",
        targetId: "k:1",
        ropeMethod: "top_rope",
        cleanFreeSend: false,
      }),
      observation({ attemptId: "clean2", targetId: "k:2", ropeMethod: null, cleanFreeSend: true }),
      observation({
        attemptId: "tr2",
        targetId: "k:2",
        ropeMethod: "top_rope",
        cleanFreeSend: false,
      }),
      observation({ attemptId: "clean3", targetId: "k:3", ropeMethod: null, cleanFreeSend: true }),
      observation({
        attemptId: "tr3",
        targetId: "k:3",
        ropeMethod: "top_rope",
        cleanFreeSend: false,
      }),
    ]);
    expect(cell(result, "top_rope", "indoor").grades).toHaveLength(0);
  });

  it("pools clean top-rope and follow sends on the same climb once into Top rope", () => {
    const result = gradeSet([
      observation({
        attemptId: "a1",
        targetId: "k:1",
        climbKind: "route",
        ropeMethod: "top_rope",
        gradeComponents: [{ value: "5.10a", system: "yds" }],
      }),
      observation({
        attemptId: "a2",
        targetId: "k:2",
        climbKind: "route",
        ropeMethod: "top_rope",
        gradeComponents: [{ value: "5.10a", system: "yds" }],
      }),
      observation({
        attemptId: "a3",
        targetId: "k:3",
        climbKind: "route",
        ropeMethod: "follow",
        gradeComponents: [{ value: "5.10a", system: "yds" }],
      }),
      // The same target under both methods still contributes one distinct target.
      observation({
        attemptId: "a4",
        targetId: "k:3",
        climbKind: "route",
        ropeMethod: "top_rope",
        gradeComponents: [{ value: "5.10a", system: "yds" }],
      }),
    ]);
    expect(cell(result, "top_rope", "indoor").grades[0]).toMatchObject({
      grade: "5.10a",
      count: 3,
    });
    expect(
      cell(result, "top_rope", "indoor").grades[0].sends.map((send) => send.ropeMethod),
    ).toEqual(["top_rope", "top_rope", "follow"]);
    expect(cell(result, "lead", "indoor").grades).toHaveLength(0);
  });

  it("keeps separate settings and types independent", () => {
    const result = gradeSet([
      observation({ targetId: "k:1", climbSetting: "indoor" }),
      observation({ targetId: "k:2", climbSetting: "indoor" }),
      observation({ targetId: "k:3", climbSetting: "indoor" }),
      observation({ targetId: "k:4", climbSetting: "outdoor" }),
      observation({ targetId: "k:5", climbSetting: "outdoor" }),
    ]);
    expect(cell(result, "bouldering", "indoor").grades[0].count).toBe(3);
    expect(cell(result, "bouldering", "outdoor").grades).toHaveLength(0);
  });

  it("uses the native board problem id so angles and mirror states are one target", () => {
    const board = (attemptId: string, targetId: string) =>
      observation({
        attemptId,
        targetId,
        provider: "boardsesh",
        providerId: "boardsesh",
        gradeComponents: [{ value: "V4", system: "v_scale" }],
      });
    const short = gradeSet([
      board("b1", "boardsesh:kilter:problem-1"),
      board("b2", "boardsesh:kilter:problem-1"),
      board("b3", "boardsesh:kilter:problem-2"),
    ]);
    expect(cell(short, "bouldering", "indoor").grades).toHaveLength(0);

    const qualified = gradeSet([
      board("b1", "boardsesh:kilter:problem-1"),
      board("b2", "boardsesh:kilter:problem-1"),
      board("b3", "boardsesh:kilter:problem-2"),
      board("b4", "boardsesh:kilter:problem-3"),
    ]);
    expect(cell(qualified, "bouldering", "indoor").grades[0].count).toBe(3);
  });

  it("ranks the precise Font consensus before v_scale display filtering", () => {
    const at = (targetId: string, difficulty: number, label: string, font: string) =>
      observation({
        attemptId: targetId,
        targetId,
        provider: "boardsesh",
        providerId: "boardsesh",
        gradeComponents: [
          {
            value: "V4",
            system: "v_scale",
            identity: `boardsesh:kilter:${difficulty}:${label}`,
            publishedLabel: label,
            rankingValue: gradeSortValue(font, "font") ?? undefined,
          },
        ],
      });
    // The lower grade is inserted last: without precise ranking it would win
    // the equal-v_scale tie purely by insertion order and system preference.
    const result = gradeSet([
      at("high-1", 19, "6b+/V4", "6b+"),
      at("high-2", 19, "6b+/V4", "6b+"),
      at("high-3", 19, "6b+/V4", "6b+"),
      at("low-1", 18, "6b/V4", "6b"),
      at("low-2", 18, "6b/V4", "6b"),
      at("low-3", 18, "6b/V4", "6b"),
    ]);
    expect(cell(result, "bouldering", "indoor").grades).toEqual([
      expect.objectContaining({
        grade: "V4",
        gradeSystem: "v_scale",
        publishedLabel: "6b+/V4",
        count: 3,
      }),
    ]);
  });
});

describe("buildDemonstratedGrade grade semantics", () => {
  it("evaluates all published components but presents one preferred-system result per target", () => {
    const both = (targetId: string) =>
      observation({
        targetId,
        gradeComponents: [
          { value: "V4", system: "v_scale" },
          { value: "6A", system: "font" },
        ],
      });
    const result = gradeSet([both("k:1"), both("k:2"), both("k:3")]);
    const grades = cell(result, "bouldering", "indoor").grades;
    expect(grades.map((grade) => [grade.grade, grade.gradeSystem])).toEqual([["V4", "v_scale"]]);
    expect(grades[0].count).toBe(3);
    expect(grades[0].sends).toHaveLength(3);
  });

  it("keeps only the highest qualifying grade when three sends support each of two grades", () => {
    const at = (targetId: string, value: string) =>
      observation({ targetId, gradeComponents: [{ value, system: "v_scale" }] });
    const result = gradeSet([
      at("k:v4-1", "V4"),
      at("k:v4-2", "V4"),
      at("k:v4-3", "V4"),
      at("k:v6-1", "V6"),
      at("k:v6-2", "V6"),
      at("k:v6-3", "V6"),
    ]);
    expect(cell(result, "bouldering", "indoor").grades.map((grade) => grade.grade)).toEqual(["V6"]);
  });

  it("retains the original published identity when distinct grades share a display label", () => {
    const at = (targetId: string, value: string, system: "v_scale" | "font") =>
      observation({ targetId, gradeComponents: [{ value, system }] });
    const result = gradeSet([
      at("k:font-1", "7A", "font"),
      at("k:font-2", "7A", "font"),
      at("k:font-3", "7A", "font"),
      at("k:v-1", "V6", "v_scale"),
      at("k:v-2", "V6", "v_scale"),
      at("k:v-3", "V6", "v_scale"),
    ]);
    // Font 7A and V6 both present around V6/7A, but only 7A is the exact winner.
    expect(cell(result, "bouldering", "indoor").grades).toEqual([
      expect.objectContaining({ grade: "7A", gradeSystem: "font", count: 3 }),
    ]);
  });

  it("does not qualify from an empty published component set", () => {
    const result = gradeSet([
      observation({ targetId: "k:1", gradeComponents: [] }),
      observation({ targetId: "k:2", gradeComponents: [] }),
      observation({ targetId: "k:3", gradeComponents: [] }),
    ]);
    expect(cell(result, "bouldering", "indoor").grades).toHaveLength(0);
  });

  it("does not merge exact consensus grades that share a coarse V label", () => {
    const published = (targetId: string, difficulty: number, label: string) =>
      observation({
        targetId,
        provider: "boardsesh",
        providerId: "boardsesh",
        gradeComponents: [
          {
            value: label.startsWith("6b") ? "6b" : "6b+",
            system: "font",
            identity: `boardsesh:${difficulty}:${label}`,
            publishedLabel: label,
          },
        ],
      });
    const result = gradeSet([
      published("b:1", 18, "6b/V4"),
      published("b:2", 18, "6b/V4"),
      published("b:3", 19, "6b+/V4"),
    ]);
    expect(cell(result, "bouldering", "indoor").grades).toHaveLength(0);
  });

  it("keeps the exact published label for the selected consensus grade", () => {
    const published = (targetId: string) =>
      observation({
        targetId,
        provider: "boardsesh",
        providerId: "boardsesh",
        gradeComponents: [
          {
            value: "6b",
            system: "font",
            identity: "boardsesh:18:6b/V4",
            publishedLabel: "6b/V4",
          },
        ],
      });
    const result = gradeSet([published("b:1"), published("b:2"), published("b:3")]);
    expect(cell(result, "bouldering", "indoor").grades[0]).toMatchObject({
      grade: "6b",
      gradeSystem: "font",
      publishedLabel: "6b/V4",
      count: 3,
    });
  });

  it("never pools two climbs from one source with one from another", () => {
    const from = (targetId: string, providerId: string) =>
      observation({ targetId, providerId, provider: providerId });
    const split = gradeSet([
      from("a:1", "provider-a"),
      from("a:2", "provider-a"),
      from("b:1", "provider-b"),
    ]);
    expect(cell(split, "bouldering", "indoor").grades).toHaveLength(0);

    const verified = gradeSet([
      from("a:1", "provider-a"),
      from("a:2", "provider-a"),
      from("a:3", "provider-a"),
      from("b:1", "provider-b"),
    ]);
    expect(cell(verified, "bouldering", "indoor").grades[0]).toMatchObject({
      grade: "V4",
      count: 3,
    });
    expect(
      cell(verified, "bouldering", "indoor").grades[0].sends.every(
        (send) => send.providerId === "provider-a",
      ),
    ).toBe(true);
  });

  it("keeps up to three distinct representatives, newest first with a stable tie break", () => {
    const result = gradeSet([
      observation({
        targetId: "k:1",
        attemptId: "a1",
        climbedOn: "2026-09-01",
        displayName: "Oldest",
      }),
      observation({
        targetId: "k:2",
        attemptId: "a2",
        climbedOn: "2026-11-01",
        displayName: "Newest",
      }),
      observation({
        targetId: "k:3",
        attemptId: "a3",
        climbedOn: "2026-10-01",
        displayName: "Middle",
      }),
      observation({
        targetId: "k:4",
        attemptId: "a4",
        climbedOn: "2026-10-01",
        displayName: "Tied",
      }),
    ]);
    const sends = cell(result, "bouldering", "indoor").grades[0].sends;
    expect(sends).toHaveLength(3);
    expect(sends.map((send) => send.displayName)).toEqual(["Newest", "Middle", "Tied"]);
    expect(sends.map((send) => send.provider)).toEqual(["kaya", "kaya", "kaya"]);
  });

  it("ignores sends outside the window", () => {
    const result = gradeSet([
      observation({ targetId: "k:1", climbedOn: "2026-08-21" }),
      observation({ targetId: "k:2", climbedOn: "2026-11-22" }),
      observation({ targetId: "k:3", climbedOn: "2026-08-22" }),
      observation({ targetId: "k:4", climbedOn: "2026-11-21" }),
    ]);
    expect(cell(result, "bouldering", "indoor").grades).toHaveLength(0);
  });
});
