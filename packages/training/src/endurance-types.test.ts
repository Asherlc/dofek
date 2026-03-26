import { describe, expect, it } from "vitest";
import {
  ENDURANCE_ACTIVITY_TYPES,
  INDOOR_CYCLING_TYPES,
  isEnduranceActivity,
  isIndoorCycling,
} from "./endurance-types.ts";

describe("ENDURANCE_ACTIVITY_TYPES", () => {
  it("includes cycling, running, swimming, walking, hiking", () => {
    expect(ENDURANCE_ACTIVITY_TYPES).toContain("cycling");
    expect(ENDURANCE_ACTIVITY_TYPES).toContain("running");
    expect(ENDURANCE_ACTIVITY_TYPES).toContain("swimming");
    expect(ENDURANCE_ACTIVITY_TYPES).toContain("walking");
    expect(ENDURANCE_ACTIVITY_TYPES).toContain("hiking");
  });

  it("does not include strength activities", () => {
    expect(ENDURANCE_ACTIVITY_TYPES).not.toContain("strength_training");
    expect(ENDURANCE_ACTIVITY_TYPES).not.toContain("yoga");
  });
});

describe("isEnduranceActivity", () => {
  it("returns true for endurance types", () => {
    expect(isEnduranceActivity("cycling")).toBe(true);
    expect(isEnduranceActivity("running")).toBe(true);
    expect(isEnduranceActivity("swimming")).toBe(true);
  });

  it("returns false for non-endurance types", () => {
    expect(isEnduranceActivity("strength_training")).toBe(false);
    expect(isEnduranceActivity("yoga")).toBe(false);
    expect(isEnduranceActivity("")).toBe(false);
  });
});

describe("INDOOR_CYCLING_TYPES", () => {
  it("includes indoor_cycling and virtual_cycling", () => {
    expect(INDOOR_CYCLING_TYPES).toContain("indoor_cycling");
    expect(INDOOR_CYCLING_TYPES).toContain("virtual_cycling");
  });

  it("does not include outdoor cycling types", () => {
    expect(INDOOR_CYCLING_TYPES).not.toContain("cycling");
    expect(INDOOR_CYCLING_TYPES).not.toContain("road_cycling");
    expect(INDOOR_CYCLING_TYPES).not.toContain("gravel_cycling");
  });
});

describe("isIndoorCycling", () => {
  it("returns true for indoor cycling types", () => {
    expect(isIndoorCycling("indoor_cycling")).toBe(true);
    expect(isIndoorCycling("virtual_cycling")).toBe(true);
  });

  it("returns false for outdoor cycling types", () => {
    expect(isIndoorCycling("cycling")).toBe(false);
    expect(isIndoorCycling("road_cycling")).toBe(false);
    expect(isIndoorCycling("mountain_biking")).toBe(false);
  });

  it("returns false for non-cycling types", () => {
    expect(isIndoorCycling("running")).toBe(false);
    expect(isIndoorCycling("strength_training")).toBe(false);
    expect(isIndoorCycling("")).toBe(false);
  });
});
