import { describe, expect, it } from "vitest";
import { moonBoardHeader, moonBoardRow } from "../climbing-file-test-helpers.ts";
import { parseMoonBoardExport } from "./parser.ts";

describe("historical MoonBoard BoardLib CSV", () => {
  it("retains distinct published/reported grades, board setup, and inexact attempt counts", () => {
    const [entry] = parseMoonBoardExport(
      `${moonBoardHeader}\n${moonBoardRow({ comment: "Two\nlines" })}`,
    );
    expect(entry).toMatchObject({
      climbedOn: "2026-09-01",
      board: { name: "MoonBoard 2019", externalId: "moon2019" },
      wallAngle: { value: 40, unit: "degrees" },
      reportedGrades: [{ value: "6C+", system: "font" }],
      climb: {
        kind: "boulder",
        setting: "indoor",
        publishedGrades: [{ value: "7A", system: "font" }],
      },
      notes: "Two\nlines",
    });
    expect(entry?.reportedAttemptCounts).toBeUndefined();
    expect(entry?.attempts).toEqual([{ scope: "climb" }]);
  });

  it("records only exact tries and explicit outcomes, with stable duplicate occurrences", () => {
    const row = moonBoardRow({ tries: "2", is_ascent: "True", is_repeat: "False" });
    const entries = parseMoonBoardExport(`${moonBoardHeader}\n${row}\n${row}`);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.externalId).not.toBe(entries[1]?.externalId);
    expect(entries[0]).toMatchObject({
      reportedAttemptCounts: [{ count: 2 }],
      attempts: [{ sourceCompleted: true, hadCompletedBefore: false }],
    });
    expect(parseMoonBoardExport(`${moonBoardHeader}\n${row}`)[0]?.externalId).toBe(
      entries[0]?.externalId,
    );
  });

  it("retains project uncertainty, zero angles, and unknown grade systems", () => {
    const [entry] = parseMoonBoardExport(
      `${moonBoardHeader}\n${moonBoardRow({ tries: "project", angle: "0", logged_grade: "unknown", displayed_grade: "", is_ascent: "", is_repeat: "" })}`,
    );
    expect(entry).toMatchObject({
      wallAngle: { value: 0, unit: "degrees" },
      reportedGrades: [{ value: "unknown", system: null }],
      attempts: [{ scope: "climb" }],
    });
    expect(entry?.reportedAttemptCounts).toBeUndefined();
  });

  it("rejects other board exports and invalid source fields", () => {
    expect(() => parseMoonBoardExport("name,date\nFoo,2026-09-01")).toThrow(/BoardLib.*header/i);
    expect(() =>
      parseMoonBoardExport(`${moonBoardHeader}\n${moonBoardRow({ board: "kilter" })}`),
    ).toThrow(/MoonBoard/i);
    expect(() =>
      parseMoonBoardExport(`${moonBoardHeader}\n${moonBoardRow({ angle: "91" })}`),
    ).toThrow(/angle/i);
    expect(() =>
      parseMoonBoardExport(`${moonBoardHeader}\n${moonBoardRow({ date: "2026-02-30" })}`),
    ).toThrow(/date/i);
  });
});
