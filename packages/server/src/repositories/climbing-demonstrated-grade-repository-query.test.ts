import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import type { ClimbingDemonstratedGradeInput } from "./climbing-demonstrated-grade-repository.ts";
import { ClimbingDemonstratedGradeRepository } from "./climbing-demonstrated-grade-repository.ts";

type AccessWindow = ConstructorParameters<typeof ClimbingDemonstratedGradeRepository>[3];

const endDate = "2026-11-21";

async function run(input: Partial<ClimbingDemonstratedGradeInput>, accessWindow?: AccessWindow) {
  const execute = vi.fn().mockResolvedValue([]);
  const repository = new ClimbingDemonstratedGradeRepository(
    { execute },
    "owner",
    "UTC",
    accessWindow,
  );
  const result = await repository.getDemonstratedGrade({ endDate, ...input });
  const params = execute.mock.calls[0]
    ? new PgDialect().sqlToQuery(execute.mock.calls[0][0]).params
    : null;
  return { result, params, calls: execute.mock.calls.length };
}

/** The attempt scope, then the pooled or selected climb types, before grade systems. */
function typeBindings(params: unknown[] | null) {
  if (!params) return null;
  const start = params.lastIndexOf("climb");
  return params.slice(start, params.indexOf("v_scale", start));
}

describe("ClimbingDemonstratedGradeRepository query bindings", () => {
  it.each([
    ["scalar top rope", { ropeMethod: "top_rope" }, ["climb", "top_rope", "follow"]],
    ["scalar follow", { ropeMethod: "follow" }, ["climb", "top_rope", "follow"]],
    [
      "scalar top rope with an intersecting type",
      { ropeMethod: "top_rope", types: ["follow", "lead"] },
      ["climb", "top_rope", "follow"],
    ],
    ["scalar follow with a disjoint type", { ropeMethod: "follow", types: ["lead"] }, ["climb"]],
    [
      "an array selection containing a pooled type",
      { types: ["top_rope", "lead"] },
      ["climb", "top_rope", "follow", "lead"],
    ],
    ["a follow-only array selection", { types: ["follow"] }, ["climb", "top_rope", "follow"]],
    ["a lead-only control", { types: ["lead"] }, ["climb", "lead"]],
    ["no type selection", {}, ["climb"]],
  ] satisfies Array<[string, NonNullable<ClimbingDemonstratedGradeInput["filters"]>, string[]]>)(
    "binds %s",
    async (_name, filters, expected) => {
      const { params } = await run({ filters });
      expect(typeBindings(params)).toEqual(expected);
    },
  );

  it("binds the provider and location selections", async () => {
    const { params } = await run({ sources: ["kaya", "openbeta"], locations: ["Gym A"] });
    expect(params).toContain("kaya");
    expect(params).toContain("openbeta");
    expect(params).toContain("Gym A");
    expect(params).toContain("owner");
    expect(params).toContain("2026-08-22");
    expect(params).toContain(endDate);
  });

  it("omits provider and location bindings when none are selected", async () => {
    const { params } = await run({ sources: [], locations: [] });
    expect(params).not.toContain("kaya");
    expect(params).not.toContain("Gym A");
  });
});

describe("ClimbingDemonstratedGradeRepository access coverage", () => {
  const limited = (startDate: string, endDateExclusive: string): AccessWindow => ({
    kind: "limited",
    paid: false,
    reason: "free_recent_week",
    startDate,
    endDateExclusive,
  });

  it.each([
    ["contains the window", "2026-08-01", "2026-12-01", true, "2026-08-22", "2026-11-21"],
    ["clips the start", "2026-09-10", "2026-12-01", false, "2026-09-10", "2026-11-21"],
    ["clips the end", "2026-08-01", "2026-11-01", false, "2026-08-22", "2026-10-31"],
    ["overlaps by one day", "2026-11-21", "2026-11-22", false, "2026-11-21", "2026-11-21"],
    ["matches both edges exactly", "2026-08-22", "2026-11-22", true, "2026-08-22", "2026-11-21"],
  ])("reads an entitlement that %s", async (_name, start, endExclusive, fullWindow, from, to) => {
    const { result, calls } = await run({}, limited(start, endExclusive));
    expect(result.coverage).toEqual({ fullWindow, startDate: from, endDate: to });
    expect(calls).toBe(1);
  });

  it.each([
    ["ends exactly where the window starts", "2026-01-01", "2026-08-22"],
    ["starts after the window ends", "2026-11-22", "2026-12-01"],
  ])("reads nothing for an entitlement that %s", async (_name, start, endExclusive) => {
    const { result, calls } = await run({}, limited(start, endExclusive));
    expect(result.coverage).toEqual({ fullWindow: false, startDate: null, endDate: null });
    expect(calls).toBe(0);
  });

  it("reads nothing for a pitch-only scope", async () => {
    const { calls } = await run({ filters: { attemptScope: ["pitch"] } });
    expect(calls).toBe(0);
  });

  it("still reads when the scope includes the whole climb", async () => {
    const { calls } = await run({ filters: { attemptScope: ["pitch", "climb"] } });
    expect(calls).toBe(1);
  });
});
