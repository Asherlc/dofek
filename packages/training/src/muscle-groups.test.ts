import { describe, expect, it } from "vitest";
import {
  BACK_PATHS,
  BODY_VIEWBOX,
  computeIntensities,
  computeRegionTotals,
  expandMuscleGroup,
  FRONT_PATHS,
  type MuscleGroupInput,
  muscleGroupFillColor,
  muscleGroupLabel,
  STRUCTURAL_COLOR,
  UNTRAINED_COLOR,
} from "./muscle-groups.ts";

describe("muscleGroupLabel", () => {
  it("returns human-readable label for known groups", () => {
    expect(muscleGroupLabel("CHEST")).toBe("Chest");
    expect(muscleGroupLabel("QUADS")).toBe("Quads");
    expect(muscleGroupLabel("QUADRICEPS")).toBe("Quads");
    expect(muscleGroupLabel("TRAPS")).toBe("Traps");
  });

  it("handles case-insensitive input", () => {
    expect(muscleGroupLabel("chest")).toBe("Chest");
    expect(muscleGroupLabel("Shoulders")).toBe("Shoulders");
  });

  it("falls back to title case for unknown groups", () => {
    expect(muscleGroupLabel("pectorals")).toBe("Pectorals");
    expect(muscleGroupLabel("hip_flexors")).toBe("Hip Flexors");
  });
});

describe("expandMuscleGroup", () => {
  it("expands coarse BACK to fine-grained regions", () => {
    expect(expandMuscleGroup("BACK")).toEqual(["TRAPS", "LATS", "UPPER_BACK", "LOWER_BACK"]);
  });

  it("expands CORE to ABS and OBLIQUES", () => {
    expect(expandMuscleGroup("CORE")).toEqual(["ABS", "OBLIQUES"]);
  });

  it("expands LEGS to lower-body regions", () => {
    expect(expandMuscleGroup("LEGS")).toEqual(["QUADS", "HAMSTRINGS", "CALVES", "GLUTES"]);
  });

  it("maps QUADRICEPS alias to QUADS", () => {
    expect(expandMuscleGroup("QUADRICEPS")).toEqual(["QUADS"]);
  });

  it("passes through fine-grained groups unchanged", () => {
    expect(expandMuscleGroup("CHEST")).toEqual(["CHEST"]);
    expect(expandMuscleGroup("BICEPS")).toEqual(["BICEPS"]);
  });

  it("is case-insensitive", () => {
    expect(expandMuscleGroup("back")).toEqual(["TRAPS", "LATS", "UPPER_BACK", "LOWER_BACK"]);
  });
});

describe("computeRegionTotals", () => {
  it("returns empty map for empty input", () => {
    const result = computeRegionTotals([]);
    expect(result.size).toBe(0);
  });

  it("sums weekly sets for a single fine-grained group", () => {
    const data: MuscleGroupInput[] = [
      {
        muscleGroup: "CHEST",
        weeklyData: [
          { week: "2024-01-08", sets: 12 },
          { week: "2024-01-15", sets: 15 },
        ],
      },
    ];
    const result = computeRegionTotals(data);
    expect(result.get("CHEST")).toBe(27);
  });

  it("distributes coarse group evenly across fine-grained regions", () => {
    const data: MuscleGroupInput[] = [
      {
        muscleGroup: "BACK",
        weeklyData: [{ week: "2024-01-08", sets: 20 }],
      },
    ];
    const result = computeRegionTotals(data);
    // BACK expands to 4 regions, so 20 / 4 = 5 each
    expect(result.get("TRAPS")).toBe(5);
    expect(result.get("LATS")).toBe(5);
    expect(result.get("UPPER_BACK")).toBe(5);
    expect(result.get("LOWER_BACK")).toBe(5);
  });

  it("accumulates when both coarse and fine-grained data exist", () => {
    const data: MuscleGroupInput[] = [
      {
        muscleGroup: "BACK",
        weeklyData: [{ week: "2024-01-08", sets: 20 }],
      },
      {
        muscleGroup: "LATS",
        weeklyData: [{ week: "2024-01-08", sets: 10 }],
      },
    ];
    const result = computeRegionTotals(data);
    expect(result.get("LATS")).toBe(15); // 5 from BACK + 10 from LATS
    expect(result.get("TRAPS")).toBe(5); // only from BACK
  });
});

describe("computeIntensities", () => {
  it("returns empty map for empty input", () => {
    const result = computeIntensities(new Map());
    expect(result.size).toBe(0);
  });

  it("returns empty map when all zeros", () => {
    const result = computeIntensities(
      new Map([
        ["CHEST", 0],
        ["BACK", 0],
      ]),
    );
    expect(result.size).toBe(0);
  });

  it("normalizes to 0-1 relative to max", () => {
    const result = computeIntensities(
      new Map([
        ["CHEST", 30],
        ["BICEPS", 15],
        ["CALVES", 10],
      ]),
    );
    expect(result.get("CHEST")).toBe(1);
    expect(result.get("BICEPS")).toBe(0.5);
    expect(result.get("CALVES")).toBeCloseTo(0.333, 2);
  });
});

describe("muscleGroupFillColor", () => {
  it("returns untrained color for intensity 0", () => {
    expect(muscleGroupFillColor(0)).toBe(UNTRAINED_COLOR);
  });

  it("returns untrained color for negative intensity", () => {
    expect(muscleGroupFillColor(-1)).toBe(UNTRAINED_COLOR);
  });

  it("returns a hex color for positive intensity", () => {
    const color = muscleGroupFillColor(0.5);
    expect(color).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("returns different colors for different intensities", () => {
    const low = muscleGroupFillColor(0.1);
    const high = muscleGroupFillColor(1.0);
    expect(low).not.toBe(high);
  });

  it("returns max accent color at intensity 1", () => {
    expect(muscleGroupFillColor(1)).toBe("#2d7a56");
  });

  it("clamps intensity above 1", () => {
    expect(muscleGroupFillColor(1.5)).toBe(muscleGroupFillColor(1));
  });
});

describe("SVG path data", () => {
  it("front view has expected muscle groups", () => {
    const muscleKeys = Object.keys(FRONT_PATHS).filter((key) => !key.startsWith("_"));
    expect(muscleKeys).toContain("CHEST");
    expect(muscleKeys).toContain("SHOULDERS");
    expect(muscleKeys).toContain("BICEPS");
    expect(muscleKeys).toContain("ABS");
    expect(muscleKeys).toContain("QUADS");
  });

  it("back view has expected muscle groups", () => {
    const muscleKeys = Object.keys(BACK_PATHS).filter((key) => !key.startsWith("_"));
    expect(muscleKeys).toContain("TRAPS");
    expect(muscleKeys).toContain("LATS");
    expect(muscleKeys).toContain("TRICEPS");
    expect(muscleKeys).toContain("HAMSTRINGS");
    expect(muscleKeys).toContain("GLUTES");
  });

  it("all paths are non-empty strings", () => {
    for (const paths of Object.values(FRONT_PATHS)) {
      for (const path of paths) {
        expect(path.length).toBeGreaterThan(0);
        expect(path).toContain("M");
      }
    }
    for (const paths of Object.values(BACK_PATHS)) {
      for (const path of paths) {
        expect(path.length).toBeGreaterThan(0);
        expect(path).toContain("M");
      }
    }
  });

  it("viewBox has reasonable dimensions", () => {
    expect(BODY_VIEWBOX.width).toBeGreaterThan(0);
    expect(BODY_VIEWBOX.height).toBeGreaterThan(0);
  });
});

describe("color constants", () => {
  it("structural color is a valid hex", () => {
    expect(STRUCTURAL_COLOR).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("untrained color is a valid hex", () => {
    expect(UNTRAINED_COLOR).toMatch(/^#[0-9a-f]{6}$/);
  });
});
