/** Display labels for provider IDs, shared across web and iOS */
export const PROVIDER_LABELS: Record<string, string> = {
  google: "Google",
  apple: "Apple",
  github: "GitHub",
  slack: "Slack",
  strava: "Strava",
  wahoo: "Wahoo",
  fitbit: "Fitbit",
  "ride-with-gps": "Ride with GPS",
  "intervals.icu": "Intervals.icu",
  withings: "Withings",
  garmin: "Garmin",
  polar: "Polar",
  whoop: "WHOOP",
  peloton: "Peloton",
  oura: "Oura",
  zwift: "Zwift",
  suunto: "Suunto",
  trainerroad: "TrainerRoad",
  komoot: "Komoot",
  concept2: "Concept2",
  coros: "COROS",
  "cycling-analytics": "Cycling Analytics",
  cycling_analytics: "Cycling Analytics",
  decathlon: "Decathlon",
  "eight-sleep": "Eight Sleep",
  fatsecret: "FatSecret",
  mapmyfitness: "MapMyFitness",
  ultrahuman: "Ultrahuman",
  velohero: "VeloHero",
  wger: "Wger",
  xert: "Xert",
  "apple-health": "Apple Health",
  apple_health: "Apple Health",
  "strong-csv": "Strong",
  "cronometer-csv": "Cronometer",
  bodyspec: "BodySpec",
  dofek: "Dofek",
};

/** Human-readable label for a provider ID, falls back to the raw ID */
export function providerLabel(id: string): string {
  return PROVIDER_LABELS[id] ?? id;
}

/**
 * Providers that have an SVG logo file (Simple Icons).
 * Files live in public/logos/{id}.svg on web.
 */
export const SVG_LOGOS: ReadonlySet<string> = new Set([
  "strava",
  "garmin",
  "fitbit",
  "google",
  "apple",
  "peloton",
  "trainerroad",
  "komoot",
  "eight-sleep",
]);

/**
 * Providers that have a PNG logo file (App Store icons / provider websites).
 * Files live in public/logos/{id}.png on web.
 */
export const PNG_LOGOS: ReadonlySet<string> = new Set([
  "polar",
  "zwift",
  "suunto",
  "wahoo",
  "whoop",
  "oura",
  "withings",
  "decathlon",
  "coros",
  "concept2",
  "ride-with-gps",
  "mapmyfitness",
  "fatsecret",
  "xert",
  "ultrahuman",
  "wger",
  "strong-csv",
  "cronometer-csv",
  "cycling_analytics",
  "apple_health",
]);

/** Brand colors used for the styled-letter fallback when no logo exists. */
export const BRAND_COLORS: Readonly<Record<string, string>> = {
  velohero: "#FF6600",
  bodyspec: "#00B4D8",
  dofek: "#4A9D8E",
};

/** Returns "svg", "png", or null depending on what logo file a provider has. */
export function providerLogoType(id: string): "svg" | "png" | null {
  if (SVG_LOGOS.has(id)) return "svg";
  if (PNG_LOGOS.has(id)) return "png";
  return null;
}
