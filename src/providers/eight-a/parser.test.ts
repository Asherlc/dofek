import { describe, expect, it } from "vitest";
import { eightAHeader, eightARow } from "../climbing-file-test-helpers.ts";
import { parseEightAExport } from "./parser.ts";

describe("8a.nu ascent CSV", () => {
  it("preserves native grades, dates, multiline notes and source results without inventing counts", () => {
    const [entry] = parseEightAExport(
      `${eightAHeader}\n${eightARow({ comment: 'A "quoted" note\non two lines' })}`,
    );
    expect(entry).toMatchObject({
      climbedOn: "2026-09-01",
      reportedGrades: [{ value: "7A", system: "font" }],
      notes: 'A "quoted" note\non two lines',
      climb: { kind: "boulder", name: "A boulder", setting: null },
      attempts: [{ sourceResult: "rp" }],
    });
    expect(entry?.reportedAttemptCounts).toBeUndefined();
    expect(entry?.activityId).toBeUndefined();
  });

  it("keeps occurrences stable across reorderings while preserving identical duplicate rows", () => {
    const first = eightARow();
    const second = eightARow({ name: "Second", type: "f", tries: "1" });
    const original = parseEightAExport(`${eightAHeader}\n${first}\n${first}\n${second}`);
    const reordered = parseEightAExport(`${eightAHeader}\n${second}\n${first}\n${first}`);
    expect(new Set(original.map((entry) => entry.externalId)).size).toBe(3);
    expect(reordered.map((entry) => entry.externalId).sort()).toEqual(
      original.map((entry) => entry.externalId).sort(),
    );
    expect(original[2]).toMatchObject({
      reportedAttemptCounts: [{ scope: "climb", count: 1 }],
      attempts: [{ sourceResult: "f", qualifier: "free-flash" }],
    });
  });

  it("supports route/top-rope and ungraded undated records without guessing result or location", () => {
    const entries = parseEightAExport(
      `${eightAHeader}\n${eightARow({ route_boulder: "ROUTE", difficulty: "6b", type: "tr", tries: "2" })}\n${eightARow({ route_boulder: "", name: "", difficulty: "", date: "", type: "unknown", tries: "", location_name: "", country_code: "" })}`,
    );
    expect(entries[0]).toMatchObject({
      climb: { kind: "route" },
      reportedGrades: [{ value: "6b", system: "french" }],
      attempts: [{ sourceResult: "tr", ropeMethod: "top_rope" }],
    });
    expect(entries[1]).toMatchObject({
      climbedOn: null,
      climb: { name: null, kind: null, setting: null },
      reportedGrades: [],
      attempts: [{ scope: "climb" }],
    });
  });

  it("rejects invalid headers, malformed CSV, dates and noninteger tries", () => {
    expect(() => parseEightAExport("name,grade\nFoo,7A")).toThrow(/8a.nu.*header/i);
    expect(() => parseEightAExport(`${eightAHeader}\n"unfinished`)).toThrow(/CSV/i);
    expect(() =>
      parseEightAExport(`${eightAHeader}\n${eightARow({ date: "2026-02-30" })}`),
    ).toThrow(/date/i);
    expect(() => parseEightAExport(`${eightAHeader}\n${eightARow({ tries: "1.5" })}`)).toThrow(
      /tries/i,
    );
    expect(parseEightAExport(eightAHeader)).toEqual([]);
  });
});
