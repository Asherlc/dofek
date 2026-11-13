import { describe, expect, it } from "vitest";
import { getDashboardGridGroupIds, reorderDashboardSections } from "./dashboardGridPairs.ts";

describe("getDashboardGridGroupIds", () => {
  it.each(["spo2Temp", "steps"])("returns the primary-first pair for %s", (section) => {
    expect(getDashboardGridGroupIds(section)).toEqual(["spo2Temp", "steps"]);
  });
  it("returns a standalone section unchanged", () => {
    expect(getDashboardGridGroupIds("healthMonitor")).toEqual(["healthMonitor"]);
  });
});

describe("reorderDashboardSections", () => {
  const order = ["healthMonitor", "stress", "spo2Temp", "steps", "sleep", "bodyComp"];
  it.each(["up", "down"] as const)(
    "preserves the array for a missing section moving %s",
    (direction) => {
      expect(reorderDashboardSections(order, "missing", direction)).toBe(order);
    },
  );
  it("preserves the array at each movement boundary", () => {
    expect(reorderDashboardSections(order, "healthMonitor", "up")).toBe(order);
    expect(reorderDashboardSections(order, "bodyComp", "down")).toBe(order);
  });
  it("preserves paired sections at movement boundaries", () => {
    const first = ["spo2Temp", "steps", "sleep"];
    const last = ["sleep", "spo2Temp", "steps"];
    expect(reorderDashboardSections(first, "steps", "up")).toBe(first);
    expect(reorderDashboardSections(last, "spo2Temp", "down")).toBe(last);
  });
  it.each(["spo2Temp", "steps"])("moves %s upward with its paired section", (section) => {
    expect(reorderDashboardSections(order, section, "up")).toEqual([
      "healthMonitor",
      "spo2Temp",
      "steps",
      "stress",
      "sleep",
      "bodyComp",
    ]);
  });
  it.each(["spo2Temp", "steps"])("moves %s downward with its paired section", (section) => {
    expect(reorderDashboardSections(order, section, "down")).toEqual([
      "healthMonitor",
      "stress",
      "sleep",
      "spo2Temp",
      "steps",
      "bodyComp",
    ]);
  });
  it("moves standalone sections past a complete target pair", () => {
    expect(reorderDashboardSections(order, "sleep", "up")).toEqual([
      "healthMonitor",
      "stress",
      "sleep",
      "spo2Temp",
      "steps",
      "bodyComp",
    ]);
    expect(reorderDashboardSections(order, "stress", "down")).toEqual([
      "healthMonitor",
      "spo2Temp",
      "steps",
      "stress",
      "sleep",
      "bodyComp",
    ]);
  });
  it.each(["spo2Temp", "steps"])("moves a lone pair member %s in either direction", (section) => {
    const partial = ["healthMonitor", section, "sleep"];
    expect(reorderDashboardSections(partial, section, "up")).toEqual([
      section,
      "healthMonitor",
      "sleep",
    ]);
    expect(reorderDashboardSections(partial, section, "down")).toEqual([
      "healthMonitor",
      "sleep",
      section,
    ]);
  });
  it("moves nonadjacent members together in primary-first order", () => {
    const scattered = ["healthMonitor", "spo2Temp", "stress", "steps", "sleep"];
    expect(reorderDashboardSections(scattered, "steps", "up")).toEqual([
      "spo2Temp",
      "steps",
      "healthMonitor",
      "stress",
      "sleep",
    ]);
    expect(reorderDashboardSections(scattered, "spo2Temp", "down")).toEqual([
      "healthMonitor",
      "stress",
      "sleep",
      "spo2Temp",
      "steps",
    ]);
  });
  it.each(["spo2Temp", "steps"])("moves standalone sections past a lone target %s", (section) => {
    const partial = ["healthMonitor", section, "sleep"];
    expect(reorderDashboardSections(partial, "sleep", "up")).toEqual([
      "healthMonitor",
      "sleep",
      section,
    ]);
    expect(reorderDashboardSections(partial, "healthMonitor", "down")).toEqual([
      section,
      "healthMonitor",
      "sleep",
    ]);
  });
});
