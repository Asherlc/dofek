import { describe, expect, it } from "vitest";
import { TRAINING_PEAKS_SPORT_MAP, mapTrainingPeaksSport } from "./sports.ts";

describe("mapTrainingPeaksSport", () => {
  it("maps known sport family IDs", () => {
    expect(mapTrainingPeaksSport(1)).toBe("swimming");
    expect(mapTrainingPeaksSport(2)).toBe("cycling");
    expect(mapTrainingPeaksSport(3)).toBe("running");
    expect(mapTrainingPeaksSport(7)).toBe("strength");
    expect(mapTrainingPeaksSport(12)).toBe("rest");
  });

  it("defaults to other for unknown IDs", () => {
    expect(mapTrainingPeaksSport(99)).toBe("other");
    expect(mapTrainingPeaksSport(0)).toBe("other");
    expect(mapTrainingPeaksSport(-1)).toBe("other");
  });

  it("has entries for all documented sport families", () => {
    expect(Object.keys(TRAINING_PEAKS_SPORT_MAP).length).toBeGreaterThanOrEqual(12);
  });
});
