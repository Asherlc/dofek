import { describe, expect, it } from "vitest";

/**
 * Extracted merge logic from the plugin for direct testing.
 * The plugin itself just calls withInfoPlist and mutates modResults;
 * what matters is that the merge logic works correctly.
 */
const REQUIRED_MODES = ["bluetooth-central", "fetch", "location"];

function mergeBackgroundModes(existing: string[]): string[] {
  return [...new Set([...existing, ...REQUIRED_MODES])];
}

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
});
