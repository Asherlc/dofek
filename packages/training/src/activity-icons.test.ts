import { describe, expect, it } from "vitest";
import { getActivityIconInfo, resolveActivityIconCategory } from "./activity-icons.ts";

describe("resolveActivityIconCategory", () => {
  it("maps cycling variants to cycling", () => {
    expect(resolveActivityIconCategory("indoor_cycling")).toBe("cycling");
    expect(resolveActivityIconCategory("road_cycling")).toBe("cycling");
  });

  it("maps running variants to running", () => {
    expect(resolveActivityIconCategory("running")).toBe("running");
    expect(resolveActivityIconCategory("trail_running")).toBe("running");
  });

  it("maps strength and mind-body types", () => {
    expect(resolveActivityIconCategory("strength_training")).toBe("strength");
    expect(resolveActivityIconCategory("yoga")).toBe("yoga");
    expect(resolveActivityIconCategory("pilates")).toBe("yoga");
  });

  it("maps team sports", () => {
    expect(resolveActivityIconCategory("tennis")).toBe("team");
    expect(resolveActivityIconCategory("soccer")).toBe("team");
  });

  it("falls back to other for unknown types", () => {
    expect(resolveActivityIconCategory("other")).toBe("other");
    expect(resolveActivityIconCategory("unknown_type")).toBe("other");
  });
});

describe("getActivityIconInfo", () => {
  it("returns emoji and gradient colors for a category", () => {
    const info = getActivityIconInfo("running");
    expect(info.category).toBe("running");
    expect(info.emoji.length).toBeGreaterThan(0);
    expect(info.gradientFrom).toMatch(/^#/);
    expect(info.gradientTo).toMatch(/^#/);
  });
});
