import { DEFAULT_CLIMBING_GRADE_PREFERENCE } from "@dofek/training/climbing-grades";
import { describe, expect, it } from "vitest";
import { boardseshGradeDisplay } from "./boardsesh-grade-display.ts";

const grades = [
  { difficultyId: 18, name: "6b/V4" },
  { difficultyId: 19, name: "6b+/V4" },
  { difficultyId: 20, name: "6c/V5" },
  { difficultyId: 21, name: "6c+/V5" },
  { difficultyId: 22, name: "7a/V6" },
];
const metadata = (overrides: Record<string, unknown> = {}, difficulty?: number) => ({
  ...(difficulty === undefined ? {} : { difficulty }),
  metadata: {
    ascent: {
      angle: 40,
      consensusDifficulty: 18,
      consensusDifficultyName: "6b/V4",
      boardseshDifficulty: 19,
      boardseshConfidence: "confirmed",
      ...overrides,
    },
    grades,
  },
});

describe("boardseshGradeDisplay", () => {
  it("uses a rounded trusted model grade for an ungraded tick", () => {
    expect(
      boardseshGradeDisplay(
        metadata({ boardseshDifficulty: 18.672 }),
        [],
        "boulder",
        DEFAULT_CLIMBING_GRADE_PREFERENCE,
      ),
    ).toMatchObject({ displayGrade: "V4+" });
  });

  it("preserves a personal grade and gives it display precedence", () => {
    expect(
      boardseshGradeDisplay(
        metadata({}, 22),
        [{ value: "V6", system: "v_scale" }],
        "boulder",
        DEFAULT_CLIMBING_GRADE_PREFERENCE,
      ),
    ).toMatchObject({ displayGrade: "V6" });
  });

  it("preserves source V+ notation for a personal grade", () => {
    expect(
      boardseshGradeDisplay(
        metadata({}, 21),
        [
          { value: "6c+", system: "font" },
          { value: "V5", system: "v_scale" },
        ],
        "boulder",
        DEFAULT_CLIMBING_GRADE_PREFERENCE,
      ),
    ).toMatchObject({ displayGrade: "V5+" });
  });

  it("falls back to recorded personal grades when legacy raw data has no catalogue", () => {
    expect(
      boardseshGradeDisplay(
        { difficulty: 20 },
        [{ value: "V5", system: "v_scale" }],
        "boulder",
        DEFAULT_CLIMBING_GRADE_PREFERENCE,
      ),
    ).toMatchObject({ displayGrade: "V5" });
  });

  it("keeps historical personal grades displayable without new source metadata", () => {
    expect(
      boardseshGradeDisplay(
        null,
        [{ value: "V2", system: "v_scale" }],
        "boulder",
        DEFAULT_CLIMBING_GRADE_PREFERENCE,
      ),
    ).toMatchObject({ displayGrade: "V2" });
  });

  it.each([
    "setter_only",
    "cross_angle_estimate",
    "moonboard_angle_estimate",
    "moonboard_wide_angle_estimate",
  ])("uses consensus for %s confidence", (boardseshConfidence) => {
    expect(
      boardseshGradeDisplay(
        metadata({ boardseshConfidence, consensusDifficulty: 20 }),
        [],
        "boulder",
        DEFAULT_CLIMBING_GRADE_PREFERENCE,
      ),
    ).toMatchObject({ displayGrade: "V5" });
  });

  it("uses consensus when the model grade is absent and returns null when both are absent", () => {
    expect(
      boardseshGradeDisplay(
        metadata({ boardseshDifficulty: null, consensusDifficulty: 20 }),
        [],
        "boulder",
        DEFAULT_CLIMBING_GRADE_PREFERENCE,
      ),
    ).toMatchObject({ displayGrade: "V5" });
    expect(
      boardseshGradeDisplay(
        metadata({ boardseshDifficulty: null, consensusDifficulty: null }),
        [],
        "boulder",
        DEFAULT_CLIMBING_GRADE_PREFERENCE,
      ),
    ).toBeNull();
  });

  it("keeps unknown confidence tiers usable", () => {
    expect(
      boardseshGradeDisplay(
        metadata({ boardseshConfidence: "future_tier", boardseshDifficulty: 20 }),
        [],
        "boulder",
        DEFAULT_CLIMBING_GRADE_PREFERENCE,
      ),
    ).toMatchObject({ displayGrade: "V5" });
  });

  it("uses board-specific labels and the source V-grade plus rule", () => {
    const moonboard = {
      metadata: {
        ascent: {
          boardseshDifficulty: 16,
          consensusDifficulty: null,
          boardseshConfidence: "confirmed",
        },
        grades: [
          { difficultyId: 16, name: "6a/V2" },
          { difficultyId: 17, name: "6a+/V3" },
        ],
      },
    };
    const kilter = {
      metadata: {
        ascent: {
          boardseshDifficulty: 16,
          consensusDifficulty: null,
          boardseshConfidence: "confirmed",
        },
        grades: [{ difficultyId: 16, name: "6a/V3" }],
      },
    };
    expect(
      boardseshGradeDisplay(moonboard, [], "boulder", DEFAULT_CLIMBING_GRADE_PREFERENCE),
    ).toMatchObject({ displayGrade: "V2" });
    expect(
      boardseshGradeDisplay(kilter, [], "boulder", DEFAULT_CLIMBING_GRADE_PREFERENCE),
    ).toMatchObject({ displayGrade: "V3" });
    expect(
      boardseshGradeDisplay(metadata({ boardseshDifficulty: 19 }), [], "boulder", {
        ...DEFAULT_CLIMBING_GRADE_PREFERENCE,
        boulder: "font",
      }),
    ).toMatchObject({ displayGrade: "6B+" });
    const reordered = metadata({ boardseshDifficulty: 18.672 });
    reordered.metadata.grades = [...grades].reverse();
    expect(
      boardseshGradeDisplay(reordered, [], "boulder", DEFAULT_CLIMBING_GRADE_PREFERENCE),
    ).toMatchObject({ displayGrade: "V4+" });
  });

  it("formats lowercase source labels and accepts V-only catalogues", () => {
    expect(
      boardseshGradeDisplay(
        {
          difficulty: 7,
          metadata: {
            ascent: { boardseshDifficulty: 7, boardseshConfidence: "confirmed" },
            grades: [{ difficultyId: 7, name: "v3" }],
          },
        },
        [],
        "boulder",
        DEFAULT_CLIMBING_GRADE_PREFERENCE,
      ),
    ).toMatchObject({ displayGrade: "V3" });
  });

  it("rejects partial labels and uses the consensus name when the ID is uncatalogued", () => {
    const partial = {
      metadata: {
        ascent: { boardseshDifficulty: 19, boardseshConfidence: "confirmed" },
        grades: [{ difficultyId: 19, name: "6b/V4/5.10a" }],
      },
    };
    expect(
      boardseshGradeDisplay(partial, [], "boulder", DEFAULT_CLIMBING_GRADE_PREFERENCE),
    ).toBeNull();

    expect(
      boardseshGradeDisplay(
        metadata({
          boardseshDifficulty: null,
          consensusDifficulty: 99,
          consensusDifficultyName: " 6b+/V4 ",
        }),
        [],
        "boulder",
        DEFAULT_CLIMBING_GRADE_PREFERENCE,
      ),
    ).toMatchObject({ displayGrade: "V4+" });
  });

  it("returns null for missing source data, an absent catalogue, or a non-boulder", () => {
    expect(
      boardseshGradeDisplay(undefined, [], "boulder", DEFAULT_CLIMBING_GRADE_PREFERENCE),
    ).toBeNull();
    expect(boardseshGradeDisplay([], [], "boulder", DEFAULT_CLIMBING_GRADE_PREFERENCE)).toBeNull();
    expect(
      boardseshGradeDisplay(
        { metadata: { ascent: { boardseshDifficulty: 19, boardseshConfidence: "confirmed" } } },
        [],
        "boulder",
        DEFAULT_CLIMBING_GRADE_PREFERENCE,
      ),
    ).toBeNull();
    expect(
      boardseshGradeDisplay(metadata(), [], "route", DEFAULT_CLIMBING_GRADE_PREFERENCE),
    ).toBeNull();
    expect(
      boardseshGradeDisplay(metadata(), [], "summit", DEFAULT_CLIMBING_GRADE_PREFERENCE),
    ).toBeNull();
  });

  it("sorts V+ between its base V grade and the next V grade", () => {
    const easier = boardseshGradeDisplay(
      metadata({ boardseshDifficulty: 18 }),
      [],
      "boulder",
      DEFAULT_CLIMBING_GRADE_PREFERENCE,
    );
    const plus = boardseshGradeDisplay(
      metadata({ boardseshDifficulty: 18.672 }),
      [],
      "boulder",
      DEFAULT_CLIMBING_GRADE_PREFERENCE,
    );
    const harder = boardseshGradeDisplay(
      metadata({ boardseshDifficulty: 20 }),
      [],
      "boulder",
      DEFAULT_CLIMBING_GRADE_PREFERENCE,
    );
    expect(plus?.gradeSortValue).toBeGreaterThan(easier?.gradeSortValue ?? Infinity);
    expect(plus?.gradeSortValue).toBeLessThan(harder?.gradeSortValue ?? -Infinity);
  });
});
