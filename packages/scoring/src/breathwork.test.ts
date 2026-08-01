import { describe, expect, it } from "vitest";
import {
  type BreathworkTechnique,
  getTechniqueById,
  TECHNIQUES,
  totalSessionSeconds,
} from "./breathwork.ts";

const testSafety = {
  position: "Practice seated.",
  warnings: ["Do not force your breath."],
  stopCriteria: "Stop if uncomfortable.",
  emergency: "Call emergency services when needed.",
};

describe("TECHNIQUES", () => {
  it("contains at least 3 techniques", () => {
    expect(TECHNIQUES.length).toBeGreaterThanOrEqual(3);
  });

  it("each technique has required fields", () => {
    for (const technique of TECHNIQUES) {
      expect(technique.id).toBeTruthy();
      expect(technique.name).toBeTruthy();
      expect(technique.purpose).toBeTruthy();
      expect(technique.description).toBeTruthy();
      expect(["Beginner", "Intermediate", "Advanced"]).toContain(technique.difficulty);
      expect(technique.inhaleSeconds).toBeGreaterThan(0);
      expect(technique.exhaleSeconds).toBeGreaterThan(0);
      expect(technique.defaultRounds).toBeGreaterThan(0);
    }
  });

  it("uses human-readable purposes and complete descriptions", () => {
    expect(getTechniqueById("box-breathing")).toMatchObject({
      name: "Box Breathing",
      purpose: "Calm focus",
      description:
        "Breathe in for 4 seconds, hold for 4 seconds, breathe out for 4 seconds, then hold for 4 seconds.",
      difficulty: "Beginner",
    });
  });

  it("has unique IDs", () => {
    const ids = TECHNIQUES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("provides pre-session safety guidance for every technique", () => {
    for (const technique of TECHNIQUES) {
      expect(technique.safety.position).toBeTruthy();
      expect(technique.safety.stopCriteria).toBe(
        "Stop and return to normal breathing if you feel dizzy or lightheaded.",
      );
      expect(technique.safety.emergency).toBe(
        "Call emergency services if someone faints and is not breathing, cannot be woken within 1 minute, or has not fully recovered.",
      );
    }
  });

  it("accurately labels and describes the fixed power breathing pattern", () => {
    const technique = getTechniqueById("wim-hof");

    expect(technique?.name).toBe("Power Breathing");
    expect(technique?.description).toBe(
      "Take 30 rounds of active 2-second inhales followed by 2-second exhales.",
    );
    expect(technique?.inhaleSeconds).toBe(2);
    expect(technique?.exhaleSeconds).toBe(2);
    expect(technique?.defaultRounds).toBe(30);
    expect(technique?.holdInSeconds).toBeUndefined();
    expect(technique?.holdOutSeconds).toBeUndefined();
  });

  it("warns about the material risks of power breathing", () => {
    const technique = getTechniqueById("wim-hof");

    expect(technique?.safety.position).toBe(
      "Practice only while seated or lying down in a safe place.",
    );
    expect(technique?.safety.warnings).toEqual([
      "Intense rounds can, in rare cases, cause loss of consciousness.",
      "Never practice in or near water, while driving, or anywhere fainting could cause injury.",
    ]);
  });

  it("limits possible benefits to techniques supported by the cited trial", () => {
    expect(getTechniqueById("box-breathing")?.possibleBenefit).toBe(
      "Regular practice may support a more positive mood.",
    );
    expect(getTechniqueById("physiological-sigh")?.possibleBenefit).toBe(
      "Regular practice may support a more positive mood and slower resting breathing.",
    );
    expect(getTechniqueById("4-7-8")?.possibleBenefit).toBeUndefined();
    expect(getTechniqueById("coherent")?.possibleBenefit).toBeUndefined();
    expect(getTechniqueById("wim-hof")?.possibleBenefit).toBeUndefined();
  });
});

describe("getTechniqueById", () => {
  it("returns technique for valid ID", () => {
    const technique = getTechniqueById("box-breathing");
    expect(technique).toBeDefined();
    expect(technique?.name).toBe("Box Breathing");
  });

  it("returns undefined for unknown ID", () => {
    expect(getTechniqueById("nonexistent")).toBeUndefined();
  });
});

describe("totalSessionSeconds", () => {
  it("computes correct total for box breathing (4-4-4-4 x 4 rounds)", () => {
    const boxBreathing: BreathworkTechnique = {
      id: "box-breathing",
      name: "Box Breathing",
      purpose: "Calm focus",
      description: "Equal inhale, hold, exhale, hold",
      difficulty: "Beginner",
      safety: testSafety,
      inhaleSeconds: 4,
      holdInSeconds: 4,
      exhaleSeconds: 4,
      holdOutSeconds: 4,
      defaultRounds: 4,
    };
    // Each round: 4+4+4+4 = 16s, 4 rounds = 64s
    expect(totalSessionSeconds(boxBreathing, 4)).toBe(64);
  });

  it("handles technique without holds", () => {
    const simpleBreath: BreathworkTechnique = {
      id: "simple",
      name: "Simple",
      purpose: "Test pattern",
      description: "test",
      difficulty: "Beginner",
      safety: testSafety,
      inhaleSeconds: 3,
      exhaleSeconds: 5,
      defaultRounds: 6,
    };
    // Each round: 3+0+5+0 = 8s, 6 rounds = 48s
    expect(totalSessionSeconds(simpleBreath, 6)).toBe(48);
  });
});
