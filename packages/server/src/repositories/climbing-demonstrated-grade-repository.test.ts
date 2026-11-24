import { describe, expect, it, vi } from "vitest";
import { ClimbingDemonstratedGradeRepository } from "./climbing-demonstrated-grade-repository.ts";

function importedMountainProjectRow(target: string, rating: string) {
  return {
    attempt_id: target,
    target_id: target,
    provider: "Mountain Project",
    provider_id: "mountain-project",
    climb_kind: "boulder",
    climb_setting: "outdoor",
    rope_method: null,
    climbed_on: "2026-11-01",
    published_grades: [{ value: "V4", system: "v_scale" }],
    wall_angle: null,
    log_raw: { Rating: rating, "Your Rating": "V4" },
    title: null,
    climb_name: target,
    log_entry_id: target,
    activity_id: null,
    climb_external_id: target,
    source_completed: null,
    source_result: "Send",
    ascent_style: "Send",
    fell_or_hung: false,
    used_aid: false,
    dabbed: false,
  };
}

function boardSeshRow(input: {
  target: string;
  canonical?: string;
  difficulty: number;
  label: string;
  ascentLabel?: string | null;
  catalogueLabel?: string | null;
  angle?: number;
}) {
  const angle = input.angle ?? 30;
  return {
    attempt_id: input.target,
    target_id: input.target,
    provider: "BoardSesh",
    provider_id: "boardsesh",
    climb_kind: "boulder" as const,
    climb_setting: "indoor" as const,
    rope_method: null,
    climbed_on: "2026-11-01",
    published_grades: [],
    wall_angle: { value: angle, unit: "degrees" },
    log_raw: {
      metadata: {
        ascent: {
          boardType: "kilter",
          climbUuid: input.target,
          canonicalClimbUuid: input.canonical ?? input.target,
          isMirror: false,
          angle,
          consensusDifficulty: input.difficulty,
          consensusDifficultyName:
            input.ascentLabel === undefined ? input.label : input.ascentLabel,
        },
        ...(input.catalogueLabel === null
          ? {}
          : {
              grades: [
                { difficultyId: input.difficulty, name: input.catalogueLabel ?? input.label },
              ],
            }),
      },
    },
    title: null,
    climb_name: input.target,
    log_entry_id: input.target,
    activity_id: null,
    climb_external_id: `kilter:${input.target}:normal`,
    source_completed: null,
    source_result: "Flash",
    ascent_style: "Flash",
    fell_or_hung: false,
    used_aid: false,
    dabbed: false,
  };
}

async function boardSeshBoulder(rows: unknown[], gradeSystems?: ("v_scale" | "font")[]) {
  const repository = new ClimbingDemonstratedGradeRepository(
    { execute: vi.fn().mockResolvedValue(rows) },
    "owner",
  );
  const result = await repository.getDemonstratedGrade({
    endDate: "2026-11-21",
    ...(gradeSystems ? { gradeSystems } : {}),
  });
  return result.cells.find(({ type, setting }) => type === "bouldering" && setting === "indoor");
}

describe("ClimbingDemonstratedGradeRepository BoardSesh consensus", () => {
  it("rejects conflicting exact ascent and catalogue labels but keeps either source alone", async () => {
    const conflicting = Array.from({ length: 3 }, (_, index) =>
      boardSeshRow({
        target: `b-${index}`,
        difficulty: 18,
        label: "6b/V4",
        ascentLabel: "6b/V4",
        catalogueLabel: "6c/V5",
      }),
    );
    expect((await boardSeshBoulder(conflicting))?.grades).toEqual([]);

    // Whitespace and case differences are not a conflict.
    const equivalent = Array.from({ length: 3 }, (_, index) =>
      boardSeshRow({
        target: `b-${index}`,
        difficulty: 18,
        label: "6b/V4",
        ascentLabel: "  6B / v4  ",
        catalogueLabel: "6b/V4",
      }),
    );
    expect((await boardSeshBoulder(equivalent))?.grades[0]).toMatchObject({
      grade: "6b",
      publishedLabel: "6b/V4",
      count: 3,
    });

    const catalogueOnly = Array.from({ length: 3 }, (_, index) =>
      boardSeshRow({
        target: `b-${index}`,
        difficulty: 18,
        label: "6b/V4",
        ascentLabel: null,
        catalogueLabel: "6b/V4",
      }),
    );
    expect((await boardSeshBoulder(catalogueOnly))?.grades[0]).toMatchObject({
      grade: "6b",
      count: 3,
    });

    const ascentOnly = Array.from({ length: 3 }, (_, index) =>
      boardSeshRow({
        target: `b-${index}`,
        difficulty: 18,
        label: "6b/V4",
        ascentLabel: "6b/V4",
        catalogueLabel: null,
      }),
    );
    expect((await boardSeshBoulder(ascentOnly))?.grades[0]).toMatchObject({
      grade: "6b",
      publishedLabel: "6b/V4",
      count: 3,
    });
  });

  it("ranks the precise Font consensus when both grades independently qualify under a v_scale filter", async () => {
    const rows = [
      ...Array.from({ length: 3 }, (_, index) =>
        boardSeshRow({ target: `high-${index}`, difficulty: 19, label: "6b+/V4" }),
      ),
      ...Array.from({ length: 3 }, (_, index) =>
        boardSeshRow({ target: `low-${index}`, difficulty: 18, label: "6b/V4" }),
      ),
    ];
    expect((await boardSeshBoulder(rows, ["v_scale"]))?.grades).toEqual([
      expect.objectContaining({
        grade: "V4",
        gradeSystem: "v_scale",
        publishedLabel: "6b+/V4",
        count: 3,
      }),
    ]);
  });

  it("requires the full native BoardSesh ID and degree wall angle for consensus evidence", async () => {
    const rows = Array.from({ length: 3 }, (_, index) =>
      boardSeshRow({ target: `native-${index}`, difficulty: 18, label: "6b/V4" }),
    );
    expect((await boardSeshBoulder(rows))?.grades[0]).toEqual(
      expect.objectContaining({ count: 3 }),
    );

    const badSuffix = rows.map((row) => ({ ...row }));
    badSuffix[2] = { ...badSuffix[2], climb_external_id: "kilter:native-2:bogus" };
    expect((await boardSeshBoulder(badSuffix))?.grades).toEqual([]);

    const extraSegment = rows.map((row) => ({ ...row }));
    extraSegment[2] = { ...extraSegment[2], climb_external_id: "kilter:native-2:normal:extra" };
    expect((await boardSeshBoulder(extraSegment))?.grades).toEqual([]);

    const nonDegrees = rows.map((row) => ({ ...row }));
    nonDegrees[2] = { ...nonDegrees[2], wall_angle: { value: 30, unit: "radians" } };
    expect((await boardSeshBoulder(nonDegrees))?.grades).toEqual([]);
  });

  it("keeps independent evidence when persisted raw is not an object", async () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({
      ...importedMountainProjectRow(`raw-${index}`, "V4"),
      climb_setting: "indoor" as const,
      log_raw: [],
    }));
    expect((await boardSeshBoulder(rows))?.grades[0]).toEqual(
      expect.objectContaining({ grade: "V4", count: 3 }),
    );
  });

  it("shares cohort identity across equivalent BoardSesh label spellings", async () => {
    const rows = [
      ...Array.from({ length: 2 }, (_, index) =>
        boardSeshRow({
          target: `catalogue-${index}`,
          difficulty: 18,
          label: "6b/V4",
          ascentLabel: "6b/V4",
          catalogueLabel: "6b/V4",
        }),
      ),
      boardSeshRow({
        target: "ascent-2",
        difficulty: 18,
        label: "6B / v4",
        ascentLabel: "6B / v4",
        catalogueLabel: null,
      }),
    ];
    expect((await boardSeshBoulder(rows))?.grades[0]).toEqual(
      expect.objectContaining({ grade: "6b", count: 3, publishedLabel: "6b/V4" }),
    );
  });
});

describe("ClimbingDemonstratedGradeRepository BoardSesh eligibility", () => {
  const valid = (index: number) =>
    boardSeshRow({ target: `ok-${index}`, difficulty: 18, label: "6b/V4" });
  const third = boardSeshRow({ target: "third", difficulty: 18, label: "6b/V4" });
  const withAscent = (override: Record<string, unknown>) => ({
    ...third,
    log_raw: {
      metadata: {
        ...third.log_raw.metadata,
        ascent: { ...third.log_raw.metadata.ascent, ...override },
      },
    },
  });
  const withoutCanonical = () => {
    const { canonicalClimbUuid: _omitted, ...ascent } = third.log_raw.metadata.ascent;
    return { ...third, log_raw: { metadata: { ...third.log_raw.metadata, ascent } } };
  };
  const count = async (row: unknown) =>
    (await boardSeshBoulder([valid(0), valid(1), row]))?.grades[0]?.count;

  it("counts a fully valid third send", async () => {
    expect(await count(third)).toBe(3);
  });

  it.each([
    ["no provider metadata", { ...third, log_raw: {} }],
    ["no ascent metadata", { ...third, log_raw: { metadata: {} } }],
    ["a null consensus difficulty", withAscent({ consensusDifficulty: null })],
    ["a missing canonical ID", withoutCanonical()],
    ["a blank canonical ID", withAscent({ canonicalClimbUuid: "   " })],
    ["a different ascent angle", withAscent({ angle: 45 })],
    ["no recorded wall angle", { ...third, wall_angle: null }],
    [
      "a blank consensus label with no catalogue",
      {
        ...boardSeshRow({
          target: "t",
          difficulty: 18,
          label: "6b/V4",
          ascentLabel: "  ",
          catalogueLabel: null,
        }),
      },
    ],
    ["a different provider", { ...third, provider_id: "kaya" }],
    ["no native climb ID", { ...third, climb_external_id: null }],
  ])("does not count a third send with %s", async (_name, row) => {
    expect(await count(row)).toBeUndefined();
  });

  it("falls back to the other label when one is blank", async () => {
    const blankCatalogue = boardSeshRow({
      target: "bc",
      difficulty: 18,
      label: "6b/V4",
      ascentLabel: "6b/V4",
      catalogueLabel: "   ",
    });
    const blankAscent = boardSeshRow({
      target: "ba",
      difficulty: 18,
      label: "6b/V4",
      ascentLabel: "   ",
      catalogueLabel: "6b/V4",
    });
    expect(await count(blankCatalogue)).toBe(3);
    expect(await count(blankAscent)).toBe(3);
  });

  it("ranks on the Font component even when the label lists V-scale first", async () => {
    const rows = Array.from({ length: 3 }, (_, index) =>
      boardSeshRow({ target: `rev-${index}`, difficulty: 18, label: "V4 / 6b" }),
    );
    expect((await boardSeshBoulder(rows))?.grades[0]).toMatchObject({
      grade: "6b",
      publishedLabel: "V4 / 6b",
      count: 3,
    });
  });
});

describe("ClimbingDemonstratedGradeRepository published grades", () => {
  it.each([
    ["V4 PG13", ["V4"]],
    ["V4+", []],
    ["V4-5", []],
    ["V5", []],
  ] as const)("preserves the exact Mountain Project rating %s", async (rating, grades) => {
    const repository = new ClimbingDemonstratedGradeRepository(
      {
        execute: vi
          .fn()
          .mockResolvedValue([
            importedMountainProjectRow("first", "V4"),
            importedMountainProjectRow("second", "V4"),
            importedMountainProjectRow("third", rating),
          ]),
      },
      "owner",
    );
    const result = await repository.getDemonstratedGrade({ endDate: "2026-11-21" });
    const cell = result.cells.find(
      ({ type, setting }) => type === "bouldering" && setting === "outdoor",
    );
    expect(cell?.grades.map(({ grade }) => grade)).toEqual(grades);
  });
});

describe("ClimbingDemonstratedGradeRepository Kaya color display", () => {
  it("uses recorded Kaya colors for unnamed boulders", async () => {
    const rows = ["blue", "green", "red"].map((color) => ({
      attempt_id: color,
      target_id: color,
      log_entry_id: color,
      climb_external_id: color,
      provider: "Kaya",
      provider_id: "kaya",
      climb_kind: "boulder" as const,
      climb_setting: "indoor" as const,
      rope_method: null,
      climbed_on: "2026-11-01",
      published_grades: [{ value: "V4", system: "v_scale" }],
      wall_angle: null,
      log_raw: { climb: { color } },
      title: null,
      climb_name: null,
      activity_id: null,
      source_completed: true,
      source_result: "Send",
      ascent_style: "Send",
      fell_or_hung: false,
      used_aid: false,
      dabbed: false,
    }));

    const repository = new ClimbingDemonstratedGradeRepository(
      { execute: vi.fn().mockResolvedValue(rows) },
      "owner",
    );
    const result = await repository.getDemonstratedGrade({ endDate: "2026-11-21" });
    const cell = result.cells.find(
      ({ type, setting }) => type === "bouldering" && setting === "indoor",
    );
    const displayNames = cell?.grades[0]?.sends.map((send) => send.displayName).sort();
    expect(displayNames).toEqual(["Blue boulder", "Green boulder", "Red boulder"]);
  });
});
