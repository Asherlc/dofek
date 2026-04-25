/** Settings key used to persist provider guide dismissal in the user_settings table */
export const PROVIDER_GUIDE_SETTINGS_KEY = "provider_guide_dismissed";

export interface ProviderGuideCategory {
  title: string;
  description: string;
  /** Provider IDs that belong to this category (subset of available providers) */
  providerIds: string[];
}

/** Provider categories shown in the guide to help users understand what they can connect */
export const PROVIDER_GUIDE_CATEGORIES: ProviderGuideCategory[] = [
  {
    title: "Activity Tracking",
    description: "Record workouts, analyze performance, and track training load",
    providerIds: [
      "strava",
      "garmin",
      "wahoo",
      "polar",
      "fitbit",
      "zwift",
      "peloton",
      "suunto",
      "coros",
      "trainerroad",
      "concept2",
      "komoot",
      "mapmyfitness",
      "ride-with-gps",
      "cycling-analytics",
      "xert",
      "velohero",
      "decathlon",
      "wger",
    ],
  },
  {
    title: "Sleep & Recovery",
    description: "Track sleep stages, quality, and recovery metrics",
    providerIds: ["oura", "whoop", "eight-sleep", "garmin", "fitbit", "ultrahuman"],
  },
  {
    title: "Nutrition",
    description: "Log meals, track macros, and monitor calorie intake",
    providerIds: ["cronometer-csv", "fatsecret"],
  },
  {
    title: "Body Composition",
    description: "Monitor weight, body fat percentage, and trends over time",
    providerIds: ["withings", "garmin", "fitbit"],
  },
  {
    title: "Health Metrics",
    description: "Heart rate variability, resting HR, blood oxygen, and skin temperature",
    providerIds: ["oura", "whoop", "garmin", "fitbit", "ultrahuman", "withings"],
  },
];

/**
 * Determine whether to show the provider guide.
 * Shows when the user has zero connected providers and hasn't dismissed it.
 */
export function shouldShowProviderGuide(
  connectedProviderCount: number,
  dismissed: boolean,
): boolean {
  return connectedProviderCount === 0 && !dismissed;
}
