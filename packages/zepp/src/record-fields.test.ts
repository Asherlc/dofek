import { describe, expect, it } from "vitest";
import { getRawString, getString, isRecord, nullable } from "./record-fields.ts";

describe("record field access", () => {
  it("recognizes plain records at unknown-data boundaries", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord(null)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord("record")).toBe(false);
  });

  it("uses null for missing and non-string fields", () => {
    expect(getString({}, "missing")).toBeNull();
    expect(getString({ value: 1 }, "value")).toBeNull();
    expect(getRawString({}, "missing")).toBeNull();
    expect(getRawString({ value: 1 }, "value")).toBeNull();
  });

  it("trims normalized strings and preserves raw strings", () => {
    expect(getString({ value: "  text  " }, "value")).toBe("text");
    expect(getRawString({ value: "  text  " }, "value")).toBe("  text  ");
  });

  it("provides a typed null initializer", () => {
    expect(nullable<string>()).toBeNull();
  });
});
