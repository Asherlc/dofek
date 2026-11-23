import { describe, expect, it, vi } from "vitest";
import { ClimbingDemonstratedGradeRepository } from "./climbing-demonstrated-grade-repository.ts";

interface Row {
  [key: string]: unknown;
  climb_kind: "route" | "boulder";
  rope_method: "top_rope" | "lead" | null;
  log_raw: Record<string, unknown>;
  source_completed: boolean | null;
  source_result: string | null;
}

function routeRow(target: string, overrides: Record<string, unknown> = {}): Row {
  return {
    attempt_id: target,
    target_id: target,
    provider: "Mountain Project",
    provider_id: "mountain-project",
    climb_kind: "route",
    climb_setting: "outdoor",
    rope_method: "top_rope",
    climbed_on: "2026-11-01",
    published_grades: [{ value: "5.10a", system: "yds" }],
    wall_angle: null,
    log_raw: { Rating: "5.10a" },
    title: null,
    climb_name: target,
    log_entry_id: target,
    activity_id: null,
    climb_external_id: target,
    source_completed: true,
    source_result: "Send",
    ascent_style: "Send",
    fell_or_hung: false,
    used_aid: false,
    dabbed: false,
    ...overrides,
  };
}

async function countWithThird(third: Record<string, unknown>) {
  const rows = [routeRow("a"), routeRow("b"), routeRow("c", third)];
  const repository = new ClimbingDemonstratedGradeRepository(
    { execute: vi.fn().mockResolvedValue(rows) },
    "owner",
  );
  const result = await repository.getDemonstratedGrade({ endDate: "2026-11-21" });
  return result.cells.find(({ type, setting }) => type === "top_rope" && setting === "outdoor")
    ?.grades[0]?.count;
}

describe("compatibility-blank attempts", () => {
  it("counts an ordinary completed attempt", async () => {
    expect(await countWithThird({})).toBe(3);
  });

  it("excludes a blank Mountain Project top-rope route attempt", async () => {
    expect(await countWithThird({ source_completed: null, source_result: null })).toBeUndefined();
  });

  it.each([
    [
      "a boulder",
      {
        climb_kind: "boulder",
        rope_method: null,
        published_grades: [{ value: "V4", system: "v_scale" }],
        log_raw: { Rating: "V4" },
      },
    ],
    ["a lead route", { rope_method: "lead" }],
  ])("does not treat %s with blank source facts as a compatibility blank", async (_n, extra) => {
    const rows = [
      routeRow("a", extra),
      routeRow("b", extra),
      routeRow("c", { ...extra, source_completed: null, source_result: null }),
    ];
    const repository = new ClimbingDemonstratedGradeRepository(
      { execute: vi.fn().mockResolvedValue(rows) },
      "owner",
    );
    const result = await repository.getDemonstratedGrade({ endDate: "2026-11-21" });
    const counts = result.cells.flatMap(({ grades }) => grades.map(({ count }) => count));
    expect(counts).toEqual([3]);
  });

  it.each([
    ["a recorded completion", { source_completed: false }],
    ["a recorded result", { source_result: "Send" }],
  ])("keeps a Mountain Project attempt with %s", async (_n, extra) => {
    expect(await countWithThird({ source_completed: null, source_result: null, ...extra })).toBe(3);
  });

  describe("OpenBeta", () => {
    const openBeta = (extra: Record<string, unknown>) => ({
      provider: "OpenBeta",
      provider_id: "openbeta",
      source_completed: null,
      source_result: null,
      ...extra,
    });

    it("excludes a blank OpenBeta attempt without a log-level attempt type", async () => {
      const rows = [
        routeRow("a", openBeta({ log_raw: {} })),
        routeRow("b", openBeta({ log_raw: {} })),
        routeRow("c", openBeta({ log_raw: {} })),
      ];
      const repository = new ClimbingDemonstratedGradeRepository(
        { execute: vi.fn().mockResolvedValue(rows) },
        "owner",
      );
      const result = await repository.getDemonstratedGrade({ endDate: "2026-11-21" });
      expect(result.cells.flatMap(({ grades }) => grades)).toEqual([]);
    });

    it.each([
      ["a log-level attempt type", { log_raw: { attemptType: "Redpoint" } }],
      ["a recorded completion", { log_raw: {}, source_completed: true }],
      ["a recorded result", { log_raw: {}, source_result: "Send" }],
    ])("keeps an OpenBeta attempt with %s", async (_n, extra) => {
      const rows = ["a", "b", "c"].map((id) => routeRow(id, openBeta(extra)));
      const repository = new ClimbingDemonstratedGradeRepository(
        { execute: vi.fn().mockResolvedValue(rows) },
        "owner",
      );
      const result = await repository.getDemonstratedGrade({ endDate: "2026-11-21" });
      expect(result.cells.flatMap(({ grades }) => grades.map(({ count }) => count))).toEqual([3]);
    });
  });
});
