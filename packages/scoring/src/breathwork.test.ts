import { describe, expect, it } from "vitest";
import {
  type BreathworkTechnique,
  getTechniqueById,
  TECHNIQUES,
  totalSessionSeconds,
} from "./breathwork.ts";

describe("TECHNIQUES", () => {
  it("contains at least 3 techniques", () => {
    expect(TECHNIQUES.length).toBeGreaterThanOrEqual(3);
  });

  it("each technique has required fields", () => {
    for (const technique of TECHNIQUES) {
      expect(technique.id).toBeTruthy();
      expect(technique.name).toBeTruthy();
      expect(technique.description).toBeTruthy();
      expect(technique.inhaleSeconds).toBeGreaterThan(0);
      expect(technique.exhaleSeconds).toBeGreaterThan(0);
      expect(technique.defaultRounds).toBeGreaterThan(0);
    }
  });

  it("has unique IDs", () => {
    const ids = TECHNIQUES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
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
      description: "Equal inhale, hold, exhale, hold",
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
      description: "test",
      inhaleSeconds: 3,
      exhaleSeconds: 5,
      defaultRounds: 6,
    };
    // Each round: 3+0+5+0 = 8s, 6 rounds = 48s
    expect(totalSessionSeconds(simpleBreath, 6)).toBe(48);
  });
});
