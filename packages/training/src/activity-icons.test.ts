import { describe, expect, it } from "vitest";
import { getActivityIconInfo, resolveActivityIconCategory } from "./activity-icons.ts";

describe("resolveActivityIconCategory", () => {
  it("gives hangboarding its own icon category", () => {
    expect(resolveActivityIconCategory("hangboard")).toBe("hangboard");
    expect(resolveActivityIconCategory(" Hangboarding ")).toBe("hangboard");
  });
  it("trims whitespace before matching", () => {
    expect(resolveActivityIconCategory("  running  ")).toBe("running");
    expect(resolveActivityIconCategory(" cycling")).toBe("cycling");
  });

  it("maps canonical cycling to cycling", () => {
    expect(resolveActivityIconCategory("cycling")).toBe("cycling");
  });

  it("maps canonical running to running", () => {
    expect(resolveActivityIconCategory("running")).toBe("running");
  });

  it("maps swimming variants to swimming", () => {
    expect(resolveActivityIconCategory("swimming")).toBe("swimming");
    expect(resolveActivityIconCategory("triathlon")).toBe("swimming");
  });

  it("maps walking variants to walking", () => {
    expect(resolveActivityIconCategory("walking")).toBe("walking");
    expect(resolveActivityIconCategory("hiking")).toBe("walking");
    expect(resolveActivityIconCategory("stair_climbing")).toBe("walking");
  });

  it("maps strength and mind-body types", () => {
    expect(resolveActivityIconCategory("strength")).toBe("strength");
    expect(resolveActivityIconCategory("yoga")).toBe("yoga");
    expect(resolveActivityIconCategory("pilates")).toBe("yoga");
    expect(resolveActivityIconCategory("meditation")).toBe("yoga");
  });

  it("maps hiit and cardio types", () => {
    expect(resolveActivityIconCategory("hiit")).toBe("hiit");
    expect(resolveActivityIconCategory("cross_training")).toBe("hiit");
    expect(resolveActivityIconCategory("cardio")).toBe("hiit");
  });

  it("maps elliptical and rowing types", () => {
    expect(resolveActivityIconCategory("elliptical")).toBe("elliptical");
    expect(resolveActivityIconCategory("rowing")).toBe("rowing");
  });

  it("maps winter sports", () => {
    expect(resolveActivityIconCategory("skiing")).toBe("winter");
    expect(resolveActivityIconCategory("skating")).toBe("winter");
    expect(resolveActivityIconCategory("snowboarding")).toBe("winter");
    expect(resolveActivityIconCategory("curling")).toBe("winter");
  });

  it("maps climbing types", () => {
    expect(resolveActivityIconCategory("climbing")).toBe("climbing");
  });

  it("maps water sports", () => {
    expect(resolveActivityIconCategory("surfing")).toBe("water");
    expect(resolveActivityIconCategory("kayaking")).toBe("water");
    expect(resolveActivityIconCategory("paddling")).toBe("water");
    expect(resolveActivityIconCategory("water_fitness")).toBe("water");
    expect(resolveActivityIconCategory("water_polo")).toBe("water");
  });

  it("maps team sports", () => {
    expect(resolveActivityIconCategory("tennis")).toBe("team");
    expect(resolveActivityIconCategory("soccer")).toBe("team");
    expect(resolveActivityIconCategory("basketball")).toBe("team");
    expect(resolveActivityIconCategory("hockey")).toBe("team");
  });

  it("maps dance types", () => {
    expect(resolveActivityIconCategory("dance")).toBe("dance");
  });

  it("falls back to other for unknown types", () => {
    expect(resolveActivityIconCategory("other")).toBe("other");
    expect(resolveActivityIconCategory("archery")).toBe("other");
  });
});

describe("getActivityIconInfo", () => {
  it.each([
    "cycling",
    "running",
    "swimming",
    "walking",
    "strength",
    "yoga",
    "hiit",
    "elliptical",
    "rowing",
    "skiing",
    "climbing",
    "hangboard",
    "surfing",
    "soccer",
    "dance",
    "archery",
  ])("provides canonical rounded outline geometry for %s", (activityType) => {
    const info = getActivityIconInfo(activityType);
    expect(info.category).toBe(resolveActivityIconCategory(activityType));
    expect(info.svg).toContain('viewBox="0 0 32 32"');
    expect(info.svg).toContain('stroke="currentColor"');
    expect(info.svg).toContain('stroke-linecap="round"');
    expect(info.svg).toContain('stroke-linejoin="round"');
    expect(info.svg).toContain('fill="none"');
  });

  it("shares family geometry across aliases and uses the neutral fallback", () => {
    expect(getActivityIconInfo(" Cycling ").svg).toBe(getActivityIconInfo("cycling").svg);
    expect(getActivityIconInfo(" Hangboarding ").svg).toBe(getActivityIconInfo("hangboard").svg);
    expect(getActivityIconInfo("archery").svg).toBe(getActivityIconInfo("other").svg);
    expect(getActivityIconInfo("hangboard").svg).not.toBe(getActivityIconInfo("climbing").svg);
  });
});
