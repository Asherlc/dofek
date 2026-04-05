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
    expect(getDashboardGridGroupIds("strain")).toEqual(["strain", "nextWorkout"]);
  });

  it("returns [primary, secondary] when given a secondary section", () => {
    expect(getDashboardGridGroupIds("nextWorkout")).toEqual(["strain", "nextWorkout"]);
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

  it("returns the same array when moving the first section up", () => {
    const result = reorderDashboardSections(order, "healthMonitor", "up");
    expect(result).toBe(order);
  });

  it("returns the same array when moving the last section down", () => {
    const result = reorderDashboardSections(order, "activities", "down");
    expect(result).toBe(order);
  });

  it("returns the same reference when moving the first section up (index === 0)", () => {
    // Kills: firstIndex <= 0 → firstIndex < 0 (EqualityOperator)
    // healthMonitor is at index 0 — exactly at the boundary
    const result = reorderDashboardSections(order, "healthMonitor", "up");
    expect(result).toBe(order);
    // Verify the array is truly unchanged, not just equal
    expect(result).toEqual(order);
  });

  it("returns the same reference when moving the last section down (index === length-1)", () => {
    // Kills: lastIndex >= order.length - 1 → lastIndex > order.length - 1 (EqualityOperator)
    // activities is at index length-1 — exactly at the boundary
    const result = reorderDashboardSections(order, "activities", "down");
    expect(result).toBe(order);
    expect(result).toEqual(order);
  });

  it("returns the same reference when moving a pair at position 0 up", () => {
    // Put strain+nextWorkout at the start so firstGroupIndex === 0
    const reordered = ["strain", "nextWorkout", "healthMonitor", "topInsights"];
    const result = reorderDashboardSections(reordered, "strain", "up");
    expect(result).toBe(reordered);
  });

  it("returns the same reference when moving a pair at the end down", () => {
    // Put spo2Temp+steps at the end so lastGroupIndex === length-1
    const reordered = ["healthMonitor", "topInsights", "spo2Temp", "steps"];
    const result = reorderDashboardSections(reordered, "steps", "down");
    expect(result).toBe(reordered);
  });

  // ── Move up ──

  it("moves a standalone section up by one position", () => {
    // "hrvRhr" is standalone, preceded by "healthspan"
    const result = reorderDashboardSections(order, "hrvRhr", "up");
    const hrvIndex = result.indexOf("hrvRhr");
    const healthspanIndex = result.indexOf("healthspan");
    expect(hrvIndex).toBeLessThan(healthspanIndex);
  });

  it("moves a primary section up as a pair", () => {
    const result = reorderDashboardSections(order, "strain", "up");
    const strainIndex = result.indexOf("strain");
    const nextWorkoutIndex = result.indexOf("nextWorkout");
    // strain+nextWorkout should stay adjacent with strain first
    expect(nextWorkoutIndex).toBe(strainIndex + 1);
    // They should have moved above their original position
    expect(strainIndex).toBeLessThan(order.indexOf("strain"));
  });

  it("moves a secondary card up using its primary-first pair order", () => {
    const result = reorderDashboardSections(order, "nextWorkout", "up");
    expect(result).toEqual([
      "healthMonitor",
      "strain",
      "nextWorkout",
      "topInsights",
      "weeklyReport",
      "sleepNeed",
      "stress",
      "healthspan",
      "hrvRhr",
      "spo2Temp",
      "steps",
      "sleep",
      "nutrition",
      "bodyComp",
      "activities",
    ]);
  });

  it("jumps over an entire target pair when moving up", () => {
    // "stress"+"healthspan" pair is preceded by "weeklyReport"+"sleepNeed" pair
    // Moving stress up should jump over the entire weeklyReport+sleepNeed pair
    const result = reorderDashboardSections(order, "stress", "up");
    const stressIndex = result.indexOf("stress");
    const weeklyReportIndex = result.indexOf("weeklyReport");
    expect(stressIndex).toBeLessThan(weeklyReportIndex);
  });

  // ── Move down ──

  it("moves a standalone section down by one position", () => {
    const result = reorderDashboardSections(order, "hrvRhr", "down");
    const hrvIndex = result.indexOf("hrvRhr");
    const spo2Index = result.indexOf("spo2Temp");
    // hrvRhr should now be after spo2Temp+steps pair
    expect(hrvIndex).toBeGreaterThan(spo2Index);
  });

  it("moves a secondary card down as a pair with its primary", () => {
    const result = reorderDashboardSections(order, "nextWorkout", "down");
    expect(result).toEqual([
      "healthMonitor",
      "topInsights",
      "weeklyReport",
      "sleepNeed",
      "strain",
      "nextWorkout",
      "stress",
      "healthspan",
      "hrvRhr",
      "spo2Temp",
      "steps",
      "sleep",
      "nutrition",
      "bodyComp",
      "activities",
    ]);
  });

  it("jumps over an entire target pair when moving down", () => {
    const result = reorderDashboardSections(order, "sleepNeed", "down");
    expect(result).toEqual([
      "healthMonitor",
      "topInsights",
      "strain",
      "nextWorkout",
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
      "activities",
    ]);
  });

  // ── Partial pair in order (pair member missing) ──

  it("moves a section whose pair partner is not in the order", () => {
    // Remove "nextWorkout" from order — "strain" should still move as a standalone
    const partialOrder = order.filter((id) => id !== "nextWorkout");
    const result = reorderDashboardSections(partialOrder, "strain", "down");
    const strainIndex = result.indexOf("strain");
    const originalIndex = partialOrder.indexOf("strain");
    expect(strainIndex).toBeGreaterThan(originalIndex);
  });

  it("moves only the section present when pair partner is missing (up)", () => {
    // Kills: .filter((id) => order.includes(id)) removal (MethodExpression)
    // Remove "nextWorkout" — strain should move alone, not try to bring nextWorkout
    const partialOrder = order.filter((id) => id !== "nextWorkout");
    const result = reorderDashboardSections(partialOrder, "strain", "up");
    expect(result).not.toContain("nextWorkout");
    const strainIndex = result.indexOf("strain");
    expect(strainIndex).toBeLessThan(partialOrder.indexOf("strain"));
  });

  it("handles moving when the primary of a secondary is not in the order", () => {
    // Remove "strain" from order — "nextWorkout" should move as standalone
    const partialOrder = order.filter((id) => id !== "strain");
    const result = reorderDashboardSections(partialOrder, "nextWorkout", "up");
    const nextWorkoutIndex = result.indexOf("nextWorkout");
    const originalIndex = partialOrder.indexOf("nextWorkout");
    expect(nextWorkoutIndex).toBeLessThan(originalIndex);
  });

  // ── Non-adjacent pair members ──

  it("handles pair members that are not adjacent in the order (up)", () => {
    // Pair members separated by another section, not at boundaries
    const scattered = ["topInsights", "strain", "healthMonitor", "nextWorkout", "sleep"];
    const result = reorderDashboardSections(scattered, "nextWorkout", "up");
    // Group should have moved up from its original position
    expect(result.indexOf("strain")).toBeLessThan(scattered.indexOf("strain"));
  });

  it("handles pair members that are not adjacent in the order (down)", () => {
    const scattered = ["sleep", "strain", "healthMonitor", "nextWorkout", "topInsights"];
    const result = reorderDashboardSections(scattered, "strain", "down");
    // Group should have moved down from its original position
    expect(result.indexOf("nextWorkout")).toBeGreaterThan(scattered.indexOf("nextWorkout"));
  });

  // ── Target group filter ──

  it("filters target group to exclude sections not in order when jumping up", () => {
    // Kills: targetGroupIds filter → getDashboardGridGroupIds(targetSectionId) (MethodExpression)
    // and the && vs || logical operator mutant
    // weeklyReport's pair is sleepNeed — but remove sleepNeed from order
    // Moving stress up should jump over just weeklyReport, not a phantom sleepNeed
    const withoutSleepNeed = ["healthMonitor", "weeklyReport", "stress", "healthspan"];
    const result = reorderDashboardSections(withoutSleepNeed, "stress", "up");
    expect(result.indexOf("stress")).toBeLessThan(result.indexOf("weeklyReport"));
  });

  it("filters target group to exclude sections not in order when jumping down", () => {
    const withoutHealthspan = ["stress", "weeklyReport", "sleepNeed", "activities"];
    const result = reorderDashboardSections(withoutHealthspan, "stress", "down");
    expect(result.indexOf("stress")).toBeGreaterThan(result.indexOf("weeklyReport"));
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
