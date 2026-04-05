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

  it("returns the same array when moving the first pair up", () => {
    // "healthMonitor" is at index 0 — moving up is a no-op
    const result = reorderDashboardSections(order, "healthMonitor", "up");
    expect(result).toBe(order);
  });

  it("returns the same array when moving the last pair down", () => {
    // "activities" is last — moving down is a no-op
    const result = reorderDashboardSections(order, "activities", "down");
    expect(result).toBe(order);
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

  it("handles moving when the primary of a secondary is not in the order", () => {
    // Remove "strain" from order — "nextWorkout" should move as standalone
    const partialOrder = order.filter((id) => id !== "strain");
    const result = reorderDashboardSections(partialOrder, "nextWorkout", "up");
    const nextWorkoutIndex = result.indexOf("nextWorkout");
    const originalIndex = partialOrder.indexOf("nextWorkout");
    expect(nextWorkoutIndex).toBeLessThan(originalIndex);
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
