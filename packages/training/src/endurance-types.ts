/**
 * Endurance activity type classification.
 *
 * Activity types considered "endurance" for training analysis.
 * Used to filter training queries (HR zones, polarization, ramp rate, etc.)
 * so that strength training, yoga, etc. don't skew intensity metrics.
 */

export const ENDURANCE_ACTIVITY_TYPES = [
  "cycling",
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

/**
 * Activity types that are performed on a stationary trainer / indoors.
 * Speed and distance are not physically meaningful for these — the values
 * are simulated by the device or platform.
 */
export const INDOOR_CYCLING_MODALITIES = ["indoor", "virtual"] as const;

export type IndoorCyclingModality = (typeof INDOOR_CYCLING_MODALITIES)[number];

/** Check whether an activity modality is stationary trainer or virtual riding. */
export function isIndoorCyclingModality(
  modality: string | null,
): modality is IndoorCyclingModality {
  return INDOOR_CYCLING_MODALITIES.some((value) => value === modality);
}
