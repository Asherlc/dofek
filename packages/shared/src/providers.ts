/** Display labels for provider IDs, shared across web and iOS */
export const PROVIDER_LABELS: Record<string, string> = {
  google: "Google",
  apple: "Apple",
  authentik: "Homelab",
  strava: "Strava",
  wahoo: "Wahoo",
  fitbit: "Fitbit",
  "ride-with-gps": "Ride with GPS",
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
  "strong-csv": "Strong",
  "cronometer-csv": "Cronometer",
  bodyspec: "BodySpec",
};

/** Human-readable label for a provider ID, falls back to the raw ID */
export function providerLabel(id: string): string {
  return PROVIDER_LABELS[id] ?? id;
}
