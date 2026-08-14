import { describe, expect, it } from "vitest";
import { computeCurrentStrain } from "./current-strain.ts";

describe("computeCurrentStrain", () => {
  it("returns zero current strain when there is no activity load", async () => {
    const result = await computeCurrentStrain({
      fallbackActivityLoad: 0,
    });

    expect(result).toEqual({
      currentStrain: 0,
      currentStrainSource: "none",
      currentPhysiologyLoad: null,
    });
  });

  it("uses activity load for current strain", async () => {
    const result = await computeCurrentStrain({
      fallbackActivityLoad: 12.5958,
    });

    expect(result).toEqual({
      currentStrain: 7.2,
      currentStrainSource: "activity",
      currentPhysiologyLoad: null,
    });
  });

  it("uses raw activity load without populating physiology load", async () => {
    const result = await computeCurrentStrain({
      fallbackActivityLoad: 50,
    });

    expect(result).toEqual({
      currentStrain: 10.9,
      currentStrainSource: "activity",
      currentPhysiologyLoad: null,
    });
  });
});
