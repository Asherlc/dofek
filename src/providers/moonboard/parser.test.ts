import { describe, expect, it, vi } from "vitest";
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

  it("rejects other board exports and invalid source fields", async () => {
    vi.resetModules();
    const { parseMoonBoardExport } = await import("./parser.ts");
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
  it.each(["moon2016", "moon2017", "moon2019", "moon2020", "moon2024"])(
    "retains setup %s and exact source fields",
    (board) => {
      const [entry] = parseMoonBoardExport(
        `${moonBoardHeader}\n${moonBoardRow({ board, logged_grade: "V3", displayed_grade: "V4", tries: "1", is_ascent: "False", is_repeat: "True" })}`,
      );
      expect(entry).toMatchObject({
        discipline: "rock_climbing",
        sourceName: "MoonBoard (BoardLib export)",
        board: { name: `MoonBoard ${board.slice(4)}`, externalId: board },
        reportedGrades: [{ value: "V3", system: "v_scale" }],
        climb: {
          name: "Benchmark",
          externalId: null,
          publishedGrades: [{ value: "V4", system: "v_scale" }],
        },
        attempts: [{ scope: "climb", sourceCompleted: false, hadCompletedBefore: true }],
        reportedAttemptCounts: [{ scope: "climb", count: 1 }],
        raw: { board, logged_grade: "V3", displayed_grade: "V4" },
      });
      expect(entry?.externalId).toMatch(/^moonboard:[a-f0-9]{64}:1$/);
    },
  );

  it.each(["xmoon2019", "moon2019x", "moon2018", "MOON2019"])(
    "rejects unsupported setup %s",
    (board) => {
      expect(() => parseMoonBoardExport(`${moonBoardHeader}\n${moonBoardRow({ board })}`)).toThrow(
        /supported MoonBoard/,
      );
    },
  );

  it.each(["-90", "90", ""])("accepts angle boundary or absent angle %s", (angle) => {
    const [entry] = parseMoonBoardExport(
      `${moonBoardHeader}\n${moonBoardRow({ angle, tries: "0", date: "", climb_name: "", comment: "" })}`,
    );
    expect(entry?.wallAngle).toEqual(
      angle === "" ? undefined : { value: Number(angle), unit: "degrees" },
    );
    expect(entry?.reportedAttemptCounts).toBeUndefined();
    expect(entry?.climbedOn).toBeNull();
    expect(entry?.climb?.name).toBeNull();
    expect(entry?.notes).toBeNull();
  });

  it.each([
    ["angle", "-91"],
    ["angle", "NaN"],
    ["tries", "-1"],
    ["tries", "1.5"],
    ["is_benchmark", "yes"],
    ["is_mirror", "1"],
    ["is_repeat", "invalid"],
    ["is_ascent", "invalid"],
  ])("rejects malformed source field %s=%s", (field, value) => {
    expect(() =>
      parseMoonBoardExport(`${moonBoardHeader}\n${moonBoardRow({ [field]: value })}`),
    ).toThrow();
  });

  it("preserves empty logged grades and treats embedded V notation as unknown", () => {
    const entries = parseMoonBoardExport(
      `${moonBoardHeader}\n${moonBoardRow({ logged_grade: "", displayed_grade: "V4", tries: "" })}\n${moonBoardRow({ logged_grade: "xV3", displayed_grade: "7A" })}`,
    );
    expect(entries[0]?.reportedGrades).toEqual([]);
    expect(entries[0]?.climb?.publishedGrades).toEqual([{ value: "V4", system: null }]);
    expect(entries[0]?.reportedAttemptCounts).toBeUndefined();
    expect(entries[1]?.reportedGrades).toEqual([{ value: "xV3", system: null }]);
    expect(entries[1]?.climb?.publishedGrades).toEqual([{ value: "7A", system: "font" }]);
  });
  it("uses the logged grade system when the displayed grade uses a different system", () => {
    const [entry] = parseMoonBoardExport(
      `${moonBoardHeader}\n${moonBoardRow({ logged_grade: "V3", displayed_grade: "7A" })}`,
    );
    expect(entry?.reportedGrades).toEqual([{ value: "V3", system: "v_scale" }]);
    expect(entry?.climb?.publishedGrades).toEqual([{ value: "7A", system: null }]);
  });
});
