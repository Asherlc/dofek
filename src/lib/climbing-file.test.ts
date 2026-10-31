import { describe, expect, it } from "vitest";
import {
  exportBoolean,
  exportCount,
  exportDate,
  exportGrades,
  exportNumber,
  fileOccurrenceId,
  nullableExportText,
  readClimbingCsv,
} from "./climbing-file.ts";

describe("climbing export facts", () => {
  it("keeps unknown cells distinct from recorded zeros and false", () => {
    expect(nullableExportText(" null ")).toBeNull();
    expect(nullableExportText(" 0 ")).toBe("0");
    expect(exportNumber("", "number")).toBeNull();
    expect(exportNumber("0", "number")).toBe(0);
    expect(exportNumber("-2.5", "number")).toBe(-2.5);
    expect(exportBoolean("", "flag")).toBeNull();
    expect(exportBoolean("False", "flag")).toBe(false);
    expect(exportBoolean("TRUE", "flag")).toBe(true);
  });
  it("validates recorded dates, integers, booleans and finite values", () => {
    expect(exportDate("", "source")).toBeNull();
    expect(exportDate("2026-09-01T23:30:00-07:00", "source")).toBe("2026-09-01");
    expect(() => exportDate("2026-02-30", "source")).toThrow(/date/);
    for (const value of ["NaN", "Infinity", "1e309", "no"])
      expect(() => exportNumber(value, "number")).toThrow();
    for (const value of ["-1", "1.5", "2147483648"])
      expect(() => exportCount(value, "count")).toThrow();
    expect(() => exportBoolean("yes", "flag")).toThrow(/flag/);
    expect(exportCount("0", "count")).toBe(0);
    expect(exportCount("", "count")).toBeNull();
  });
  it("retains grades in unknown systems and accepts quoted reordered CSV columns", () => {
    expect(exportGrades("", "font")).toEqual([]);
    expect(exportGrades("ungraded", "font")).toEqual([{ value: "ungraded", system: null }]);
    expect(exportGrades("7A", "font")).toEqual([{ value: "7A", system: "font" }]);
    expect(readClimbingCsv('note,name\n"Two\nlines",A', ["name", "note"], "source")).toEqual([
      { name: "A", note: "Two\nlines" },
    ]);
    expect(() => readClimbingCsv("name,name\nA,A", ["name"], "source")).toThrow(/header/);
    expect(() => readClimbingCsv("name,note\nA", ["name", "note"], "source")).toThrow(/row/);
    expect(() => readClimbingCsv('name,note\n"A', ["name", "note"], "source")).toThrow(/CSV/);
  });
  it("uses source content and duplicate occurrence numbers rather than CSV positions", () => {
    const counts = new Map<string, number>();
    const first = fileOccurrenceId("source", { name: "A", date: "" }, counts);
    const duplicate = fileOccurrenceId("source", { date: "", name: "A" }, counts);
    expect(first).not.toBe(duplicate);
    expect(fileOccurrenceId("source", { date: "", name: "A" }, new Map())).toBe(first);
  });
});
