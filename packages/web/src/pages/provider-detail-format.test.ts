import { describe, expect, it } from "vitest";
import { formatCellValue, formatColumnName } from "./provider-detail-format.ts";

describe("formatColumnName", () => {
  it.each([
    ["started_at", "Started At"],
    ["name", "Name"],
    ["avg_heart_rate", "Avg Heart Rate"],
  ])("formats %s", (input, expected) => {
    expect(formatColumnName(input)).toBe(expected);
  });
});

describe("formatCellValue", () => {
  it.each([
    [null, "—"],
    [undefined, "—"],
    [true, "Yes"],
    [false, "No"],
    [{ foo: 1 }, '{"foo":1}'],
    ["2024-03-15", "Mar 15, 2024"],
    ["hello", "hello"],
    [42, "42"],
  ])("formats values", (input, expected) => {
    expect(formatCellValue(input)).toBe(expected);
  });

  it("formats ISO timestamps", () => {
    const result = formatCellValue("2024-03-15T10:30:00Z");
    expect(result).not.toBe("2024-03-15T10:30:00Z");
    expect(result.length).toBeGreaterThan(0);
  });
});
