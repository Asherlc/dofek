export const ACTIVITY_HEATMAP_MEASURE_LABEL = "Training time";
export const ACTIVITY_HEATMAP_UNIT_LABEL = "minutes per day";
export const ACTIVITY_HEATMAP_DESCRIPTION =
  "Each day shows recorded training time in minutes. Use the meanings to spot possible recovery days and higher-volume days; duration alone does not measure intensity or prove overload.";

export const ACTIVITY_HEATMAP_BAND_IDS = [
  "none",
  "light",
  "moderate",
  "high",
  "very_high",
] as const;

export type ActivityHeatmapBandId = (typeof ACTIVITY_HEATMAP_BAND_IDS)[number];

export interface ActivityHeatmapBand {
  readonly id: ActivityHeatmapBandId;
  readonly min: number;
  readonly max: number | null;
  readonly label: string;
  readonly meaning: string;
}

export const ACTIVITY_HEATMAP_BANDS: readonly ActivityHeatmapBand[] = [
  {
    id: "none",
    min: 0,
    max: 0,
    label: "0 min",
    meaning: "No recorded training; this may be a recovery/rest day.",
  },
  {
    id: "light",
    min: 1,
    max: 30,
    label: "1–30 min",
    meaning: "Light recorded training volume.",
  },
  {
    id: "moderate",
    min: 31,
    max: 60,
    label: "31–60 min",
    meaning: "Moderate recorded training volume.",
  },
  {
    id: "high",
    min: 61,
    max: 120,
    label: "61–120 min",
    meaning: "High training volume; compare with recovery before stacking another hard day.",
  },
  {
    id: "very_high",
    min: 121,
    max: null,
    label: ">120 min",
    meaning:
      "Very high training volume; recovery context matters, and duration alone does not prove overload.",
  },
] as const;

export function activityHeatmapBandForMinutes(totalMinutes: number): ActivityHeatmapBandId {
  const band = ACTIVITY_HEATMAP_BANDS.find(
    (candidate) =>
      totalMinutes >= candidate.min && (candidate.max === null || totalMinutes <= candidate.max),
  );
  if (!band) {
    throw new Error(`Training time is outside the supported heatmap range: ${totalMinutes}`);
  }
  return band.id;
}

export function activityHeatmapBandById(bandId: ActivityHeatmapBandId): ActivityHeatmapBand {
  const band = ACTIVITY_HEATMAP_BANDS.find((candidate) => candidate.id === bandId);
  if (!band) {
    throw new Error(`Unknown activity heatmap band: ${bandId}`);
  }
  return band;
}
