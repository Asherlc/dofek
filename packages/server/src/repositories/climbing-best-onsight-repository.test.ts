import { describe, expect, it, vi } from "vitest";
import { ClimbingBestOnsightRepository } from "./climbing-best-onsight-repository.ts";

const bounds = { start_date: "2025-11-23", end_date: "2026-11-22" };

function id(sequence: number): string {
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`;
}

function candidate(overrides: Record<string, unknown>) {
  return {
    entry_id: id(1),
    provider_id: "kaya",
    climbed_on: "2026-10-01",
    climb_kind: "boulder",
    setting: "indoor",
    published_grades: [{ value: "V3", system: "v_scale" }],
    reported_grades: [],
    attempt_observations: [{ ropeMethod: null, onsight: true }],
    ...overrides,
  };
}

async function bestOnsight(candidates: Record<string, unknown>[]) {
  const execute = vi.fn().mockResolvedValueOnce([bounds]).mockResolvedValueOnce(candidates);
  const result = await new ClimbingBestOnsightRepository(
    { execute },
    "user-1",
    "UTC",
  ).getBestOnsight(new Date("2026-11-22T12:00:00Z"));
  const row = (type: string) => result.rows.find((candidateRow) => candidateRow.type === type);
  return { result, row };
}

describe("ClimbingBestOnsightRepository", () => {
  it("returns every climbing type with empty cells when nothing qualifies", async () => {
    const { result, row } = await bestOnsight([]);
    expect(result.startDate).toBe(bounds.start_date);
    expect(result.endDate).toBe(bounds.end_date);
    expect(row("bouldering")).toEqual({ type: "bouldering", gym: null, outdoor: null });
    expect(row("lead")).toEqual({ type: "lead", gym: null, outdoor: null });
  });

  it("keeps the hardest grade per setting and breaks ties by later date then record id", async () => {
    const { row } = await bestOnsight([
      candidate({ entry_id: id(1), published_grades: [{ value: "V3", system: "v_scale" }] }),
      candidate({ entry_id: id(2), published_grades: [{ value: "V5", system: "v_scale" }] }),
      candidate({
        entry_id: id(3),
        climbed_on: "2026-09-01",
        published_grades: [{ value: "V5", system: "v_scale" }],
      }),
      candidate({
        entry_id: id(4),
        climbed_on: "2026-10-01",
        published_grades: [{ value: "V5", system: "v_scale" }],
      }),
      candidate({
        entry_id: id(5),
        climbed_on: "2026-10-01",
        published_grades: [{ value: "V5", system: "v_scale" }],
      }),
      candidate({
        entry_id: id(6),
        setting: "outdoor",
        published_grades: [{ value: "6B+", system: "font" }],
      }),
    ]);
    expect(row("bouldering")?.gym).toMatchObject({ grade: "V5", recordId: id(2) });
    expect(row("bouldering")?.outdoor).toMatchObject({ grade: "6B+", recordId: id(6) });
  });

  it("prefers the later date when grades tie", async () => {
    const { row } = await bestOnsight([
      candidate({ entry_id: id(1), climbed_on: "2026-08-01" }),
      candidate({ entry_id: id(2), climbed_on: "2026-09-01" }),
    ]);
    expect(row("bouldering")?.gym?.recordId).toBe(id(2));
  });

  it("falls back to a reported grade when the published grade is unknown and leaves the cell empty without one", async () => {
    const { row } = await bestOnsight([
      candidate({
        entry_id: id(1),
        published_grades: [{ value: "?", system: null }],
        reported_grades: [{ value: "V4", system: "v_scale" }],
      }),
      candidate({
        entry_id: id(2),
        setting: "outdoor",
        published_grades: [{ value: "?", system: null }],
        reported_grades: [],
      }),
    ]);
    expect(row("bouldering")?.gym).toMatchObject({ grade: "V4", recordId: id(1) });
    expect(row("bouldering")?.outdoor).toBeNull();
  });

  it("skips grade systems that do not apply to the climb kind", async () => {
    const { row } = await bestOnsight([
      candidate({
        entry_id: id(1),
        climb_kind: "route",
        published_grades: [{ value: "V5", system: "v_scale" }],
        attempt_observations: [{ ropeMethod: "lead", onsight: true }],
      }),
    ]);
    expect(row("lead")?.gym).toBeNull();
  });

  it("uses the rope method of the onsight attempt and ignores other attempts", async () => {
    const { row } = await bestOnsight([
      candidate({
        entry_id: id(1),
        climb_kind: "route",
        published_grades: [{ value: "5.11a", system: "yds" }],
        attempt_observations: [
          { ropeMethod: "top_rope", onsight: false },
          { ropeMethod: "lead", onsight: true },
          { ropeMethod: null, onsight: true },
        ],
      }),
    ]);
    expect(row("lead")?.gym).toMatchObject({ grade: "5.11a", recordId: id(1) });
    expect(row("top_rope")?.gym).toBeNull();
  });
});
