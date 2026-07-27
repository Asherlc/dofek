import { describe, expect, it } from "vitest";
import {
  PRIMARY_GOAL_OPTIONS,
  PRIMARY_GOAL_SETTINGS_KEY,
  parsePrimaryGoal,
  primaryGoalIds,
  primaryGoalLabel,
} from "./primary-goal";

describe("PRIMARY_GOAL_OPTIONS", () => {
  it("exposes the four roadmap-aligned primary goals", () => {
    expect(PRIMARY_GOAL_OPTIONS.map((option) => option.id)).toEqual([
      "racePreparation",
      "sleepConsistency",
      "strengthProgression",
      "weightTrend",
    ]);
  });

  it("uses layman-readable labels and descriptions", () => {
    expect(PRIMARY_GOAL_OPTIONS).toContainEqual(
      expect.objectContaining({
        id: "racePreparation",
        label: "Race preparation",
        description: "Train toward a race or event date",
      }),
    );
    expect(PRIMARY_GOAL_OPTIONS).toContainEqual(
      expect.objectContaining({
        id: "sleepConsistency",
        label: "Sleep consistency",
        description: "Build steadier sleep timing and quality",
      }),
    );
    expect(PRIMARY_GOAL_OPTIONS).toContainEqual(
      expect.objectContaining({
        id: "strengthProgression",
        label: "Strength progression",
        description: "Increase strength over time",
      }),
    );
    expect(PRIMARY_GOAL_OPTIONS).toContainEqual(
      expect.objectContaining({
        id: "weightTrend",
        label: "Weight trend",
        description: "Track body weight toward a target",
      }),
    );
  });

  it("exports a stable settings key and id list for validation", () => {
    expect(PRIMARY_GOAL_SETTINGS_KEY).toBe("primaryGoal");
    expect(primaryGoalIds).toEqual([
      "racePreparation",
      "sleepConsistency",
      "strengthProgression",
      "weightTrend",
    ]);
  });
});

describe("parsePrimaryGoal", () => {
  it("returns a known goal id", () => {
    expect(parsePrimaryGoal("sleepConsistency")).toBe("sleepConsistency");
  });

  it("returns null for missing or unknown values", () => {
    expect(parsePrimaryGoal(null)).toBeNull();
    expect(parsePrimaryGoal(undefined)).toBeNull();
    expect(parsePrimaryGoal("")).toBeNull();
    expect(parsePrimaryGoal("loseWeight")).toBeNull();
    expect(parsePrimaryGoal(42)).toBeNull();
  });
});

describe("primaryGoalLabel", () => {
  it("returns the display label for a known goal", () => {
    expect(primaryGoalLabel("weightTrend")).toBe("Weight trend");
  });

  it("falls back to the raw id for unknown values", () => {
    expect(primaryGoalLabel("unknown")).toBe("unknown");
  });
});
