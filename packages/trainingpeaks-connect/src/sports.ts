/**
 * TrainingPeaks workout type family IDs → normalized sport type.
 */
export const TRAINING_PEAKS_SPORT_MAP: Record<number, string> = {
  1: "swimming",
  2: "cycling",
  3: "running",
  4: "walking",
  5: "rowing",
  6: "skiing",
  7: "strength",
  8: "yoga",
  9: "hiking",
  10: "other",
  11: "triathlon",
  12: "rest",
  13: "cardio",
};

/**
 * Map a TrainingPeaks workoutTypeFamilyId to a normalized sport type.
 */
export function mapTrainingPeaksSport(familyId: number): string {
  return TRAINING_PEAKS_SPORT_MAP[familyId] ?? "other";
}
