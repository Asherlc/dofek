import { describe, expect, it } from "vitest";
import { mapTrainingPeaksSport, TRAINING_PEAKS_SPORT_MAP } from "./sports.ts";

describe("mapTrainingPeaksSport", () => {
  it("maps known sport family IDs", () => {
    expect(mapTrainingPeaksSport(1).canonicalType).toBe("swimming");
    expect(mapTrainingPeaksSport(2).canonicalType).toBe("cycling");
    expect(mapTrainingPeaksSport(3).canonicalType).toBe("running");
    expect(mapTrainingPeaksSport(7).canonicalType).toBe("strength");
    expect(mapTrainingPeaksSport(12).canonicalType).toBe("other");
  });

  it("defaults to other for unknown IDs", () => {
    expect(mapTrainingPeaksSport(99).canonicalType).toBe("other");
    expect(mapTrainingPeaksSport(0).canonicalType).toBe("other");
    expect(mapTrainingPeaksSport(-1).canonicalType).toBe("other");
  });

  it("has entries for all documented sport families", () => {
    expect(Object.keys(TRAINING_PEAKS_SPORT_MAP).length).toBeGreaterThanOrEqual(12);
  });
});
