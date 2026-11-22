import { describe, expect, it } from "vitest";
import {
  formatPlannedWorkoutTarget,
  type PlannedWorkoutStepInput,
  type PlannedWorkoutTargetInput,
  withPlannedWorkoutStepKeys,
} from "./planned-workout-targets.ts";

const target = (overrides: Partial<PlannedWorkoutTargetInput>): PlannedWorkoutTargetInput => ({
  type: "power",
  value: null,
  start: null,
  end: null,
  unit: null,
  ...overrides,
});

describe("formatPlannedWorkoutTarget", () => {
  it("formats an exact value with its unit and keeps percent units attached", () => {
    expect(formatPlannedWorkoutTarget(target({ value: 250, unit: "W" }))).toBe("Power 250 W");
    expect(formatPlannedWorkoutTarget(target({ type: "heart_rate", value: 65, unit: "%" }))).toBe(
      "Heart rate 65%",
    );
  });

  it("keeps the range unit on the upper bound only", () => {
    expect(formatPlannedWorkoutTarget(target({ start: 200, end: 240, unit: "W" }))).toBe(
      "Power 200–240 W",
    );
    expect(
      formatPlannedWorkoutTarget(target({ type: "pace", start: 300, end: 330, unit: "s/km" })),
    ).toBe("Pace 300–330 s/km");
  });

  it("describes one-sided bounds and falls back to the label alone", () => {
    expect(formatPlannedWorkoutTarget(target({ start: 200, unit: "W" }))).toBe(
      "Power at least 200 W",
    );
    expect(formatPlannedWorkoutTarget(target({ end: 240, unit: "W" }))).toBe("Power up to 240 W");
    expect(formatPlannedWorkoutTarget(target({ type: "cadence" }))).toBe("Cadence");
  });
});

const step = (
  overrides: Partial<Extract<PlannedWorkoutStepInput, { kind: "step" }>>,
): Extract<PlannedWorkoutStepInput, { kind: "step" }> => ({
  kind: "step",
  text: null,
  durationSeconds: null,
  distanceMeters: null,
  targets: [],
  ...overrides,
});

describe("withPlannedWorkoutStepKeys", () => {
  it("distinguishes identical siblings by occurrence, not array position", () => {
    const siblings = [
      step({ text: "Recovery" }),
      step({ text: "Recovery" }),
      step({ text: "Interval" }),
      step({ text: "Recovery" }),
    ];
    const keys = withPlannedWorkoutStepKeys(siblings).map(([, key]) => key);

    expect(keys[0]).toMatch(/#1$/);
    expect(keys[1]).toMatch(/#2$/);
    expect(keys[3]).toMatch(/#3$/);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys[2]).not.toBe(keys[0]);
    expect(withPlannedWorkoutStepKeys(siblings).map(([, key]) => key)).toEqual(keys);
  });

  it("serializes nested repeat steps and target fields deterministically", () => {
    const repeat = (repetitions: number): PlannedWorkoutStepInput => ({
      kind: "repeat",
      repetitions,
      text: "Main set",
      steps: [step({ text: "Interval", targets: [target({ value: 250, unit: "W" })] })],
    });
    const [first] = withPlannedWorkoutStepKeys([repeat(3)]);
    const [different] = withPlannedWorkoutStepKeys([repeat(4)]);

    if (!first || !different) throw new Error("Expected both repeat steps to have keys");
    expect(first[1]).not.toBe(different[1]);
    expect(first[1]).toContain("Main set");
    expect(first[1]).toContain("W");
  });
});
