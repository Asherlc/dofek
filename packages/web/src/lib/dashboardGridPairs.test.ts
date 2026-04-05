import { describe, expect, it } from "vitest";
import {
  DASHBOARD_GRID_PAIR_SECONDARIES,
  DASHBOARD_GRID_PAIRS,
  getDashboardGridGroupIds,
  reorderDashboardSections,
} from "./dashboardGridPairs.ts";
import { DEFAULT_LAYOUT } from "./dashboardLayoutContext.ts";

describe("getDashboardGridGroupIds", () => {
  it("returns the primary section first when moving a secondary card", () => {
    expect(getDashboardGridGroupIds("nextWorkout")).toEqual(["strain", "nextWorkout"]);
  });

  it("returns a standalone section unchanged", () => {
    expect(getDashboardGridGroupIds("healthMonitor")).toEqual(["healthMonitor"]);
  });
});

describe("reorderDashboardSections", () => {
  it("moves a secondary card using its primary-first pair order", () => {
    expect(reorderDashboardSections(DEFAULT_LAYOUT.order, "nextWorkout", "up")).toEqual([
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

  it("moves a secondary card down as a pair with its primary", () => {
    expect(reorderDashboardSections(DEFAULT_LAYOUT.order, "nextWorkout", "down")).toEqual([
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

  it("jumps over an entire target pair instead of splitting it", () => {
    expect(reorderDashboardSections(DEFAULT_LAYOUT.order, "sleepNeed", "down")).toEqual([
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
});

describe("dashboard grid pair maps", () => {
  it("keeps the secondary lookup inverse to the primary lookup", () => {
    for (const [primarySectionId, secondarySectionId] of Object.entries(DASHBOARD_GRID_PAIRS)) {
      expect(DASHBOARD_GRID_PAIR_SECONDARIES[secondarySectionId]).toBe(primarySectionId);
    }
  });
});
