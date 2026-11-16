import { DEFAULT_CLIMBING_GRADE_PREFERENCE } from "@dofek/training/climbing-grades";
import { describe, expect, it } from "vitest";
import { boardseshGradeDisplay } from "./boardsesh-grade-display.ts";

const grades = [
  { difficultyId: 18, name: "6b/V4" },
  { difficultyId: 19, name: "6b+/V4" },
  { difficultyId: 20, name: "6c/V5" },
  { difficultyId: 21, name: "6c+/V5" },
  { difficultyId: 22, name: "6a/V2" },
];
const metadata = (overrides: Record<string, unknown> = {}) => ({
  difficulty: 22,
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
        metadata(),
        [{ value: "V2", system: "v_scale" }],
        "boulder",
        DEFAULT_CLIMBING_GRADE_PREFERENCE,
      ),
    ).toMatchObject({ displayGrade: "V2" });
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
