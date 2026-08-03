import { describe, expect, it } from "vitest";
import {
  ENDURANCE_ACTIVITY_TYPES,
  INDOOR_CYCLING_MODALITIES,
  isEnduranceActivity,
  isIndoorCyclingModality,
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

describe("INDOOR_CYCLING_MODALITIES", () => {
  it("includes indoor and virtual", () => {
    expect(INDOOR_CYCLING_MODALITIES).toContain("indoor");
    expect(INDOOR_CYCLING_MODALITIES).toContain("virtual");
  });

  it("does not include outdoor modalities", () => {
    expect(INDOOR_CYCLING_MODALITIES).not.toContain("road");
    expect(INDOOR_CYCLING_MODALITIES).not.toContain("mountain");
    expect(INDOOR_CYCLING_MODALITIES).not.toContain("gravel");
  });
});

describe("isIndoorCyclingModality", () => {
  it("returns true for indoor cycling modalities", () => {
    expect(isIndoorCyclingModality("indoor")).toBe(true);
    expect(isIndoorCyclingModality("virtual")).toBe(true);
  });

  it("returns false for outdoor modalities", () => {
    expect(isIndoorCyclingModality("road")).toBe(false);
    expect(isIndoorCyclingModality("mountain")).toBe(false);
    expect(isIndoorCyclingModality("gravel")).toBe(false);
  });

  it("returns false for absent and unknown modalities", () => {
    expect(isIndoorCyclingModality(null)).toBe(false);
    expect(isIndoorCyclingModality("")).toBe(false);
  });
});
