/**
 * Endurance activity type classification.
 *
 * Activity types considered "endurance" for training analysis.
 * Used to filter training queries (HR zones, polarization, ramp rate, etc.)
 * so that strength training, yoga, etc. don't skew intensity metrics.
 */

export const ENDURANCE_ACTIVITY_TYPES = [
  "cycling",
  "road_cycling",
  "mountain_biking",
  "gravel_cycling",
  "indoor_cycling",
  "virtual_cycling",
  "e_bike_cycling",
  "cyclocross",
  "track_cycling",
  "bmx",
  "running",
  "swimming",
  "walking",
  "hiking",
] as const;

export type EnduranceActivityType = (typeof ENDURANCE_ACTIVITY_TYPES)[number];

/** Check whether an activity type is endurance (cardio). */
export function isEnduranceActivity(activityType: string): activityType is EnduranceActivityType {
  return ENDURANCE_ACTIVITY_TYPES.some((t) => t === activityType);
}
