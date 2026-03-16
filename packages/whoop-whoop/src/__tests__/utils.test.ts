import { describe, expect, it } from "vitest";
import { parseDuringRange } from "../utils.ts";

describe("parseDuringRange", () => {
  it("parses a standard inclusive-exclusive range", () => {
    const result = parseDuringRange("['2026-03-12T21:37:00.000Z','2026-03-12T21:56:00.000Z')");

    expect(result.start).toEqual(new Date("2026-03-12T21:37:00.000Z"));
    expect(result.end).toEqual(new Date("2026-03-12T21:56:00.000Z"));
  });

  it("parses a fully inclusive range", () => {
    const result = parseDuringRange("['2024-01-15T08:00:00.000Z','2024-01-15T09:30:00.000Z']");

    expect(result.start).toEqual(new Date("2024-01-15T08:00:00.000Z"));
    expect(result.end).toEqual(new Date("2024-01-15T09:30:00.000Z"));
  });

  it("parses a fully exclusive range", () => {
    const result = parseDuringRange("('2024-06-01T10:00:00.000Z','2024-06-01T11:30:00.000Z')");

    expect(result.start).toEqual(new Date("2024-06-01T10:00:00.000Z"));
    expect(result.end).toEqual(new Date("2024-06-01T11:30:00.000Z"));
  });

  it("throws on invalid range string", () => {
    expect(() => parseDuringRange("invalid")).toThrow("Could not parse 'during' range: invalid");
  });

  it("throws on empty string", () => {
    expect(() => parseDuringRange("")).toThrow("Could not parse 'during' range:");
  });

  it("throws on range with missing timestamps", () => {
    expect(() => parseDuringRange("[,)")).toThrow("Could not parse 'during' range:");
  });
});
