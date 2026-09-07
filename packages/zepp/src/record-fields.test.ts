import { describe, expect, it } from "vitest";
import { getRawString, getString } from "./record-fields.ts";

describe("record field access", () => {
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
});
