import { describe, expect, it } from "vitest";
import {
  COLOR_BUCKET_COUNT,
  computeIntensities,
  computeSlugTotals,
  expandMuscleGroup,
  INTENSITY_COLORS,
  intensityToBucket,
  type MuscleGroupInput,
  muscleGroupFillColor,
  muscleGroupLabel,
} from "./muscle-groups.ts";

describe("muscleGroupLabel", () => {
  it("returns human-readable label for known slugs", () => {
    expect(muscleGroupLabel("chest")).toBe("Chest");
    expect(muscleGroupLabel("quadriceps")).toBe("Quads");
    expect(muscleGroupLabel("trapezius")).toBe("Traps");
    expect(muscleGroupLabel("deltoids")).toBe("Shoulders");
  });

  it("falls back to title case for unknown slugs", () => {
    expect(muscleGroupLabel("pectorals")).toBe("Pectorals");
    expect(muscleGroupLabel("hip-flexors")).toBe("Hip Flexors");
  });
});

describe("expandMuscleGroup", () => {
  it("expands coarse BACK to library slugs", () => {
    expect(expandMuscleGroup("BACK")).toEqual(["trapezius", "upper-back", "lower-back"]);
  });

  it("expands CORE to abs and obliques", () => {
    expect(expandMuscleGroup("CORE")).toEqual(["abs", "obliques"]);
  });

  it("expands LEGS to lower-body slugs", () => {
    expect(expandMuscleGroup("LEGS")).toEqual(["quadriceps", "hamstring", "calves", "gluteal"]);
  });

  it("maps QUADRICEPS to quadriceps slug", () => {
    expect(expandMuscleGroup("QUADRICEPS")).toEqual(["quadriceps"]);
  });

  it("maps SHOULDERS to deltoids", () => {
    expect(expandMuscleGroup("SHOULDERS")).toEqual(["deltoids"]);
  });

  it("passes through fine-grained groups as lowercase slugs", () => {
    expect(expandMuscleGroup("CHEST")).toEqual(["chest"]);
    expect(expandMuscleGroup("BICEPS")).toEqual(["biceps"]);
  });

  it("is case-insensitive", () => {
    expect(expandMuscleGroup("back")).toEqual(["trapezius", "upper-back", "lower-back"]);
  });
});

describe("computeSlugTotals", () => {
  it("returns empty map for empty input", () => {
    const result = computeSlugTotals([]);
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
    const result = computeSlugTotals(data);
    expect(result.get("chest")).toBe(27);
  });

  it("distributes coarse group evenly across slugs", () => {
    const data: MuscleGroupInput[] = [
      {
        muscleGroup: "BACK",
        weeklyData: [{ week: "2024-01-08", sets: 30 }],
      },
    ];
    const result = computeSlugTotals(data);
    // BACK expands to 3 slugs, so 30 / 3 = 10 each
    expect(result.get("trapezius")).toBe(10);
    expect(result.get("upper-back")).toBe(10);
    expect(result.get("lower-back")).toBe(10);
  });

  it("accumulates when both coarse and fine-grained data exist", () => {
    const data: MuscleGroupInput[] = [
      {
        muscleGroup: "BACK",
        weeklyData: [{ week: "2024-01-08", sets: 30 }],
      },
      {
        muscleGroup: "TRAPEZIUS",
        weeklyData: [{ week: "2024-01-08", sets: 10 }],
      },
    ];
    const result = computeSlugTotals(data);
    expect(result.get("trapezius")).toBe(20); // 10 from BACK + 10 from TRAPEZIUS
    expect(result.get("upper-back")).toBe(10); // only from BACK
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
        ["chest", 0],
        ["biceps", 0],
      ]),
    );
    expect(result.size).toBe(0);
  });

  it("normalizes to 0-1 relative to max", () => {
    const result = computeIntensities(
      new Map([
        ["chest", 30],
        ["biceps", 15],
        ["calves", 10],
      ]),
    );
    expect(result.get("chest")).toBe(1);
    expect(result.get("biceps")).toBe(0.5);
    expect(result.get("calves")).toBeCloseTo(0.333, 2);
  });
});

describe("muscleGroupFillColor", () => {
  it("returns surface color for intensity 0", () => {
    expect(muscleGroupFillColor(0)).toMatch(/^#[0-9a-f]{6}$/);
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

describe("intensityToBucket", () => {
  it("returns 0 for zero intensity", () => {
    expect(intensityToBucket(0)).toBe(0);
  });

  it("returns 1 for very low intensity", () => {
    expect(intensityToBucket(0.01)).toBe(1);
  });

  it("returns max bucket for intensity 1", () => {
    expect(intensityToBucket(1)).toBe(COLOR_BUCKET_COUNT);
  });

  it("returns middle bucket for intensity 0.5", () => {
    expect(intensityToBucket(0.5)).toBe(3);
  });
});

describe("INTENSITY_COLORS", () => {
  it("has correct number of colors", () => {
    expect(INTENSITY_COLORS).toHaveLength(COLOR_BUCKET_COUNT);
  });

  it("all entries are valid hex colors", () => {
    for (const color of INTENSITY_COLORS) {
      expect(color).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("goes from lighter to darker", () => {
    // The red channel decreases (200 → 45) as intensity increases
    const first = INTENSITY_COLORS[0];
    const last = INTENSITY_COLORS[COLOR_BUCKET_COUNT - 1];
    expect(first).toBeDefined();
    expect(last).toBeDefined();
    const firstRed = Number.parseInt(first?.slice(1, 3) ?? "0", 16);
    const lastRed = Number.parseInt(last?.slice(1, 3) ?? "0", 16);
    expect(firstRed).toBeGreaterThan(lastRed);
  });
});
