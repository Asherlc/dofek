import { describe, expect, it } from "vitest";
import {
  DASHBOARD_GRID_PAIR_SECONDARIES,
  DASHBOARD_GRID_PAIRS,
  getDashboardGridGroupIds,
  reorderDashboardSections,
} from "./dashboardGridPairs.ts";
import { DEFAULT_LAYOUT } from "./dashboardLayoutContext.ts";

describe("getDashboardGridGroupIds", () => {
  it("returns [primary, secondary] when given a primary section", () => {
    expect(getDashboardGridGroupIds("weeklyReport")).toEqual(["weeklyReport", "sleepNeed"]);
  });

  it("returns [primary, secondary] when given a secondary section", () => {
    expect(getDashboardGridGroupIds("sleepNeed")).toEqual(["weeklyReport", "sleepNeed"]);
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
  const order = DEFAULT_LAYOUT.order;

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
    const reordered = ["weeklyReport", "sleepNeed", "healthMonitor", "topInsights"];
    const result = reorderDashboardSections(reordered, "weeklyReport", "up");
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
      "weeklyReport",
      "sleepNeed",
      "hrvRhr",
      "stress",
      "healthspan",
      "spo2Temp",
      "steps",
      "sleep",
      "nutrition",
      "bodyComp",
    ]);
  });

  it("moves a primary section up as a pair", () => {
    const result = reorderDashboardSections(order, "weeklyReport", "up");
    const weeklyReportIndex = result.indexOf("weeklyReport");
    const sleepNeedIndex = result.indexOf("sleepNeed");
    expect(sleepNeedIndex).toBe(weeklyReportIndex + 1);
    expect(weeklyReportIndex).toBeLessThan(order.indexOf("weeklyReport"));
  });

  it("moves a secondary card up using its primary-first pair order", () => {
    const result = reorderDashboardSections(order, "sleepNeed", "up");
    expect(result).toEqual([
      "healthMonitor",
      "topInsights",
      "weeklyReport",
      "sleepNeed",
      "strain",
      "stress",
      "healthspan",
      "hrvRhr",
      "spo2Temp",
      "steps",
      "sleep",
      "nutrition",
      "bodyComp",
    ]);
  });

  it("jumps over an entire target pair when moving up", () => {
    const result = reorderDashboardSections(order, "stress", "up");
    expect(result).toEqual([
      "healthMonitor",
      "topInsights",
      "strain",
      "stress",
      "healthspan",
      "weeklyReport",
      "sleepNeed",
      "hrvRhr",
      "spo2Temp",
      "steps",
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
      "weeklyReport",
      "sleepNeed",
      "stress",
      "healthspan",
      "spo2Temp",
      "steps",
      "hrvRhr",
      "sleep",
      "nutrition",
      "bodyComp",
    ]);
  });

  it("moves a secondary card down as a pair with its primary", () => {
    const result = reorderDashboardSections(order, "sleepNeed", "down");
    expect(result).toEqual([
      "healthMonitor",
      "topInsights",
      "strain",
      "stress",
      "healthspan",
      "weeklyReport",
      "sleepNeed",
      "hrvRhr",
      "spo2Temp",
      "steps",
      "sleep",
      "nutrition",
      "bodyComp",
    ]);
  });

  it("jumps over an entire target pair when moving down", () => {
    const result = reorderDashboardSections(order, "sleepNeed", "down");
    expect(result).toEqual([
      "healthMonitor",
      "topInsights",
      "strain",
      "stress",
      "healthspan",
      "weeklyReport",
      "sleepNeed",
      "hrvRhr",
      "spo2Temp",
      "steps",
      "sleep",
      "nutrition",
      "bodyComp",
    ]);
  });

  // ── Partial pair in order (pair member missing) ──

  it("moves a section whose pair partner is not in the order", () => {
    const partialOrder = order.filter((id) => id !== "sleepNeed");
    const result = reorderDashboardSections(partialOrder, "weeklyReport", "down");
    const weeklyReportIndex = result.indexOf("weeklyReport");
    const originalIndex = partialOrder.indexOf("weeklyReport");
    expect(weeklyReportIndex).toBeGreaterThan(originalIndex);
  });

  it("moves only the section present when pair partner is missing (up)", () => {
    const partialOrder = order.filter((id) => id !== "sleepNeed");
    const result = reorderDashboardSections(partialOrder, "weeklyReport", "up");
    expect(result).not.toContain("sleepNeed");
    const weeklyReportIndex = result.indexOf("weeklyReport");
    expect(weeklyReportIndex).toBeLessThan(partialOrder.indexOf("weeklyReport"));
  });

  it("handles moving when the primary of a secondary is not in the order", () => {
    const partialOrder = order.filter((id) => id !== "weeklyReport");
    const result = reorderDashboardSections(partialOrder, "sleepNeed", "up");
    const sleepNeedIndex = result.indexOf("sleepNeed");
    const originalIndex = partialOrder.indexOf("sleepNeed");
    expect(sleepNeedIndex).toBeLessThan(originalIndex);
  });

  // ── Non-adjacent pair members ──

  it("handles pair members that are not adjacent in the order (up)", () => {
    const scattered = ["topInsights", "weeklyReport", "healthMonitor", "sleepNeed", "sleep"];
    const result = reorderDashboardSections(scattered, "sleepNeed", "up");
    expect(result.indexOf("weeklyReport")).toBeLessThan(scattered.indexOf("weeklyReport"));
  });

  it("handles pair members that are not adjacent in the order (down)", () => {
    const scattered = ["sleep", "weeklyReport", "healthMonitor", "sleepNeed", "topInsights"];
    const result = reorderDashboardSections(scattered, "weeklyReport", "down");
    expect(result.indexOf("sleepNeed")).toBeGreaterThan(scattered.indexOf("sleepNeed"));
  });

  // ── Target group filter ──

  it("filters target group to exclude sections not in order when jumping up", () => {
    const withoutSleepNeed = ["healthMonitor", "weeklyReport", "stress", "healthspan"];
    const result = reorderDashboardSections(withoutSleepNeed, "stress", "up");
    expect(result).toEqual(["healthMonitor", "stress", "healthspan", "weeklyReport"]);
  });

  it("filters missing target primary sections when jumping up from a secondary target", () => {
    const withoutWeeklyReport = ["healthMonitor", "sleepNeed", "stress", "healthspan", "bodyComp"];
    const result = reorderDashboardSections(withoutWeeklyReport, "stress", "up");
    expect(result).toEqual(["healthMonitor", "stress", "healthspan", "sleepNeed", "bodyComp"]);
  });

  it("filters target group to exclude sections not in order when jumping down", () => {
    const withoutHealthspan = ["stress", "weeklyReport", "sleepNeed", "bodyComp"];
    const result = reorderDashboardSections(withoutHealthspan, "stress", "down");
    expect(result).toEqual(["weeklyReport", "sleepNeed", "stress", "bodyComp"]);
  });

  it("filters missing target secondary sections when jumping down from a primary target", () => {
    const withoutSleepNeed = ["stress", "weeklyReport", "bodyComp"];
    const result = reorderDashboardSections(withoutSleepNeed, "stress", "down");
    expect(result).toEqual(["weeklyReport", "stress", "bodyComp"]);
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
