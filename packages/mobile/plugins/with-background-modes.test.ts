import { describe, expect, it } from "vitest";

const { mergeBackgroundModes } = require("./with-background-modes");

describe("withBackgroundModes", () => {
  it("adds missing bluetooth-central and fetch when only location present", () => {
    const result = mergeBackgroundModes(["location"]);
    expect(result).toContain("bluetooth-central");
    expect(result).toContain("fetch");
    expect(result).toContain("location");
    expect(result).toHaveLength(3);
  });

  it("does not duplicate existing modes", () => {
    const result = mergeBackgroundModes(["bluetooth-central", "fetch", "location"]);
    expect(result).toHaveLength(3);
  });

  it("handles empty existing modes", () => {
    const result = mergeBackgroundModes([]);
    expect(result).toEqual(expect.arrayContaining(["bluetooth-central", "fetch", "location"]));
    expect(result).toHaveLength(3);
  });

  it("preserves extra modes from other plugins", () => {
    const result = mergeBackgroundModes(["location", "audio"]);
    expect(result).toContain("audio");
    expect(result).toContain("bluetooth-central");
    expect(result).toContain("fetch");
    expect(result).toContain("location");
    expect(result).toHaveLength(4);
  });

  it("handles non-array input defensively", () => {
    expect(mergeBackgroundModes(undefined)).toHaveLength(3);
    expect(mergeBackgroundModes(null)).toHaveLength(3);
    expect(mergeBackgroundModes("location")).toHaveLength(3);
    expect(mergeBackgroundModes(42)).toHaveLength(3);
  });

  it("filters non-string entries from existing modes", () => {
    const result = mergeBackgroundModes(["location", 42, null, "audio"]);
    expect(result).toContain("location");
    expect(result).toContain("audio");
    expect(result).not.toContain(42);
    expect(result).not.toContain(null);
  });
});
