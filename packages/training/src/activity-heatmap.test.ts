import { describe, expect, it } from "vitest";
import {
  ACTIVITY_HEATMAP_BAND_IDS,
  ACTIVITY_HEATMAP_BANDS,
  ACTIVITY_HEATMAP_DESCRIPTION,
  ACTIVITY_HEATMAP_MEASURE_LABEL,
  ACTIVITY_HEATMAP_UNIT_LABEL,
  activityHeatmapBandById,
  activityHeatmapBandForMinutes,
} from "./activity-heatmap.ts";

describe("activity heatmap semantics", () => {
  it("defines a labeled minutes-per-day legend with recoverable meaning", () => {
    expect(ACTIVITY_HEATMAP_MEASURE_LABEL).toBe("Training time");
    expect(ACTIVITY_HEATMAP_UNIT_LABEL).toBe("minutes per day");
    expect(ACTIVITY_HEATMAP_BANDS.map((band) => band.label)).toEqual([
      "0 min",
      "1–30 min",
      "31–60 min",
      "61–120 min",
      ">120 min",
    ]);
    expect(ACTIVITY_HEATMAP_BANDS[0]?.meaning).toContain("recovery");
    expect(ACTIVITY_HEATMAP_BANDS.at(-1)?.meaning).toContain("recovery");
    expect(ACTIVITY_HEATMAP_DESCRIPTION).toContain("intensity");
    expect(ACTIVITY_HEATMAP_DESCRIPTION).toContain("overload");
  });

  it.each([
    [0, "none"],
    [1, "light"],
    [30, "light"],
    [31, "moderate"],
    [60, "moderate"],
    [61, "high"],
    [120, "high"],
    [121, "very_high"],
  ] as const)("maps %s minutes to the server-owned %s band", (minutes, expectedBand) => {
    expect(activityHeatmapBandForMinutes(minutes)).toBe(expectedBand);
  });

  it("rejects negative training time instead of assigning a heatmap band", () => {
    expect(() => activityHeatmapBandForMinutes(-1)).toThrow(
      "Training time is outside the supported heatmap range: -1",
    );
  });

  it.each(ACTIVITY_HEATMAP_BAND_IDS)("looks up the %s band definition", (bandId) => {
    expect(activityHeatmapBandById(bandId)).toEqual(
      ACTIVITY_HEATMAP_BANDS.find((band) => band.id === bandId),
    );
  });

  it("rejects an unknown band id received at runtime", () => {
    const unknownBandId = "unknown";

    expect(() => activityHeatmapBandById(unknownBandId)).toThrow(
      "Unknown activity heatmap band: unknown",
    );
  });
});
