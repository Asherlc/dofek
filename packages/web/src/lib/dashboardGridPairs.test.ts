import { describe, expect, it } from "vitest";
import {
  DASHBOARD_GRID_PAIR_SECONDARIES,
  DASHBOARD_GRID_PAIRS,
  getDashboardGridGroupIds,
  reorderDashboardSections,
} from "./dashboardGridPairs.ts";

describe("getDashboardGridGroupIds", () => {
  it("returns [primary, secondary] when given a primary section", () => {
    expect(getDashboardGridGroupIds("stress")).toEqual(["stress", "healthspan"]);
  });

  it("returns [primary, secondary] when given a secondary section", () => {
    expect(getDashboardGridGroupIds("healthspan")).toEqual(["stress", "healthspan"]);
  });

  it("returns a standalone section unchanged", () => {
    expect(getDashboardGridGroupIds("healthMonitor")).toEqual(["healthMonitor"]);
  });

  it("returns every grid pair primary with its secondary", () => {
    for (const [primary, secondary] of Object.entries(DASHBOARD_GRID_PAIRS)) {
      expect(getDashboardGridGroupIds(primary)).toEqual([primary, secondary]);
    }
  });

  it("returns every grid pair secondary with its primary first", () => {
    for (const [secondary, primary] of Object.entries(DASHBOARD_GRID_PAIR_SECONDARIES)) {
      expect(getDashboardGridGroupIds(secondary)).toEqual([primary, secondary]);
    }
  });
});

describe("reorderDashboardSections", () => {
  const order = [
    "healthMonitor",
    "topInsights",
    "strain",
    "stress",
    "healthspan",
    "spo2Temp",
    "steps",
    "hrvRhr",
    "standaloneA",
    "standaloneB",
    "sleep",
    "nutrition",
    "bodyComp",
  ];

  // ── No-op edge cases ──

  it("returns the same array when sectionId is not in order", () => {
    const result = reorderDashboardSections(order, "nonexistent", "up");
    expect(result).toBe(order);
  });

  it("returns the same array when sectionId is not in order while moving down", () => {
    const result = reorderDashboardSections(order, "nonexistent", "down");
    expect(result).toBe(order);
  });

  it("returns the same array when moving the first section up", () => {
    const result = reorderDashboardSections(order, "healthMonitor", "up");
    expect(result).toBe(order);
  });

  it("returns the same array when moving the last section down", () => {
    const result = reorderDashboardSections(order, "bodyComp", "down");
    expect(result).toBe(order);
  });

  it("returns the same reference when moving the first section up (index === 0)", () => {
    const result = reorderDashboardSections(order, "healthMonitor", "up");
    expect(result).toBe(order);
    expect(result).toEqual(order);
  });

  it("returns the same reference when moving the last section down (index === length-1)", () => {
    const result = reorderDashboardSections(order, "bodyComp", "down");
    expect(result).toBe(order);
    expect(result).toEqual(order);
  });

  it("returns the same reference when moving a pair at position 0 up", () => {
    const reordered = ["stress", "healthspan", "healthMonitor", "topInsights"];
    const result = reorderDashboardSections(reordered, "stress", "up");
    expect(result).toBe(reordered);
    expect(result).toEqual(reordered);
  });

  it("returns the same reference when moving a pair at the end down", () => {
    const reordered = ["healthMonitor", "topInsights", "spo2Temp", "steps"];
    const result = reorderDashboardSections(reordered, "steps", "down");
    expect(result).toBe(reordered);
    expect(result).toEqual(reordered);
  });

  // ── Move up ──

  it("moves a standalone section up by one position", () => {
    const result = reorderDashboardSections(order, "hrvRhr", "up");
    expect(result).toEqual([
      "healthMonitor",
      "topInsights",
      "strain",
      "stress",
      "healthspan",
      "hrvRhr",
      "spo2Temp",
      "steps",
      "standaloneA",
      "standaloneB",
      "sleep",
      "nutrition",
      "bodyComp",
    ]);
  });

  it("moves a primary section up as a pair", () => {
    const result = reorderDashboardSections(order, "stress", "up");
    const stressIndex = result.indexOf("stress");
    const healthspanIndex = result.indexOf("healthspan");
    expect(healthspanIndex).toBe(stressIndex + 1);
    expect(stressIndex).toBeLessThan(order.indexOf("stress"));
  });

  it("moves a secondary card up using its primary-first pair order", () => {
    const result = reorderDashboardSections(order, "healthspan", "up");
    expect(result).toEqual([
      "healthMonitor",
      "topInsights",
      "stress",
      "healthspan",
      "strain",
      "spo2Temp",
      "steps",
      "hrvRhr",
      "standaloneA",
      "standaloneB",
      "sleep",
      "nutrition",
      "bodyComp",
    ]);
  });

  it("jumps over an entire target pair when moving up", () => {
    const result = reorderDashboardSections(order, "spo2Temp", "up");
    expect(result).toEqual([
      "healthMonitor",
      "topInsights",
      "strain",
      "spo2Temp",
      "steps",
      "stress",
      "healthspan",
      "hrvRhr",
      "standaloneA",
      "standaloneB",
      "sleep",
      "nutrition",
      "bodyComp",
    ]);
  });

  // ── Move down ──

  it("moves a standalone section down by one position", () => {
    const result = reorderDashboardSections(order, "hrvRhr", "down");
    expect(result).toEqual([
      "healthMonitor",
      "topInsights",
      "strain",
      "stress",
      "healthspan",
      "spo2Temp",
      "steps",
      "standaloneA",
      "hrvRhr",
      "standaloneB",
      "sleep",
      "nutrition",
      "bodyComp",
    ]);
  });

  it("moves a secondary card down as a pair with its primary", () => {
    const result = reorderDashboardSections(order, "healthspan", "down");
    expect(result).toEqual([
      "healthMonitor",
      "topInsights",
      "strain",
      "spo2Temp",
      "steps",
      "stress",
      "healthspan",
      "hrvRhr",
      "standaloneA",
      "standaloneB",
      "sleep",
      "nutrition",
      "bodyComp",
    ]);
  });

  it("jumps over an entire target pair when moving down", () => {
    const result = reorderDashboardSections(order, "healthspan", "down");
    expect(result).toEqual([
      "healthMonitor",
      "topInsights",
      "strain",
      "spo2Temp",
      "steps",
      "stress",
      "healthspan",
      "hrvRhr",
      "standaloneA",
      "standaloneB",
      "sleep",
      "nutrition",
      "bodyComp",
    ]);
  });

  // ── Partial pair in order (pair member missing) ──

  it("moves a section whose pair partner is not in the order", () => {
    const partialOrder = order.filter((id) => id !== "healthspan");
    const result = reorderDashboardSections(partialOrder, "stress", "down");
    const stressIndex = result.indexOf("stress");
    const originalIndex = partialOrder.indexOf("stress");
    expect(stressIndex).toBeGreaterThan(originalIndex);
  });

  it("moves only the section present when pair partner is missing (up)", () => {
    const partialOrder = order.filter((id) => id !== "healthspan");
    const result = reorderDashboardSections(partialOrder, "stress", "up");
    expect(result).not.toContain("healthspan");
    const stressIndex = result.indexOf("stress");
    expect(stressIndex).toBeLessThan(partialOrder.indexOf("stress"));
  });

  it("handles moving when the primary of a secondary is not in the order", () => {
    const partialOrder = order.filter((id) => id !== "stress");
    const result = reorderDashboardSections(partialOrder, "healthspan", "up");
    const healthspanIndex = result.indexOf("healthspan");
    const originalIndex = partialOrder.indexOf("healthspan");
    expect(healthspanIndex).toBeLessThan(originalIndex);
  });

  // ── Non-adjacent pair members ──

  it("handles pair members that are not adjacent in the order (up)", () => {
    const scattered = ["topInsights", "stress", "healthMonitor", "healthspan", "sleep"];
    const result = reorderDashboardSections(scattered, "healthspan", "up");
    expect(result.indexOf("stress")).toBeLessThan(scattered.indexOf("stress"));
  });

  it("handles pair members that are not adjacent in the order (down)", () => {
    const scattered = ["sleep", "stress", "healthMonitor", "healthspan", "topInsights"];
    const result = reorderDashboardSections(scattered, "stress", "down");
    expect(result.indexOf("healthspan")).toBeGreaterThan(scattered.indexOf("healthspan"));
  });

  // ── Target group filter ──

  it("filters target group to exclude sections not in order when jumping up", () => {
    const withoutHealthspan = ["healthMonitor", "stress", "spo2Temp", "steps"];
    const result = reorderDashboardSections(withoutHealthspan, "spo2Temp", "up");
    expect(result).toEqual(["healthMonitor", "spo2Temp", "steps", "stress"]);
  });

  it("filters missing target primary sections when jumping up from a secondary target", () => {
    const withoutStress = ["healthMonitor", "healthspan", "spo2Temp", "steps", "bodyComp"];
    const result = reorderDashboardSections(withoutStress, "spo2Temp", "up");
    expect(result).toEqual(["healthMonitor", "spo2Temp", "steps", "healthspan", "bodyComp"]);
  });

  it("filters target group to exclude sections not in order when jumping down", () => {
    const withoutSteps = ["spo2Temp", "stress", "healthspan", "bodyComp"];
    const result = reorderDashboardSections(withoutSteps, "spo2Temp", "down");
    expect(result).toEqual(["stress", "healthspan", "spo2Temp", "bodyComp"]);
  });

  it("filters missing target secondary sections when jumping down from a primary target", () => {
    const withoutSteps = ["spo2Temp", "stress", "bodyComp"];
    const result = reorderDashboardSections(withoutSteps, "spo2Temp", "down");
    expect(result).toEqual(["stress", "spo2Temp", "bodyComp"]);
  });
});

describe("dashboard grid pair maps", () => {
  it("keeps the secondary lookup inverse to the primary lookup", () => {
    for (const [primarySectionId, secondarySectionId] of Object.entries(DASHBOARD_GRID_PAIRS)) {
      expect(DASHBOARD_GRID_PAIR_SECONDARIES[secondarySectionId]).toBe(primarySectionId);
    }
  });

  it("has the same number of entries in both maps", () => {
    expect(Object.keys(DASHBOARD_GRID_PAIRS).length).toBe(
      Object.keys(DASHBOARD_GRID_PAIR_SECONDARIES).length,
    );
  });
});
