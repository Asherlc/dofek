import { formatDateTime } from "@dofek/format/format";

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
  "garmin-dump": "Garmin Dump",
  "fit-file": "FIT File",
  polar: "Polar",
  whoop: "WHOOP (Cloud)",
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
  fatsecret: "fatsecret",
  mapmyfitness: "MapMyFitness",
  ultrahuman: "Ultrahuman",
  "amazfit-zepp": "Amazfit/Zepp",
  velohero: "VeloHero",
  wger: "Wger",
  xert: "Xert",
  "apple-health": "Apple Health",
  apple_health: "Apple Health",
  "strong-csv": "Strong",
  "cronometer-csv": "Cronometer",
  bodyspec: "BodySpec",
  dofek: "Dofek",
  manual_review: "Manual review",
  whoop_ble: "WHOOP (Bluetooth)",
  ble_heart_rate: "Heart Rate Monitor (Bluetooth)",
  "zos-app": "Zepp OS App",
};

/** Human-readable label for a provider ID, falls back to the raw ID */
export function providerLabel(id: string): string {
  return PROVIDER_LABELS[id] ?? id;
}

/** Provider identity resolved for user-facing provenance and technical diagnostics. */
export interface ProviderProvenance {
  providerId: string;
  label: string;
}

/** Resolve one provider ID through the canonical shared display-name map. */
export function resolveProviderProvenance(providerId: string): ProviderProvenance {
  return {
    providerId,
    label: providerLabel(providerId),
  };
}

/** Human-readable label for a provider/source combination. */
export function providerSourceLabel(id: string, subsource?: string | null): string {
  if (id === "apple_health" && subsource) {
    return `${subsource} (via Apple Health)`;
  }
  return providerLabel(id);
}

/** Human-readable label for a provider record and its reporting device or app. */
export function providerRecordLabel(id: string, sourceName?: string | null): string {
  const label = providerLabel(id);
  const source = sourceName?.trim();
  if (!source) return label;
  const normalizedSource = source.toLowerCase();
  if (normalizedSource === id.toLowerCase() || normalizedSource === label.toLowerCase()) {
    return label;
  }
  return `${label} · ${source}`;
}

export interface ProviderAbsentSource {
  providerId: string;
  providerAbsentAt: string | null;
  subsource?: string | null;
}

/** Format a fully hidden activity tombstone line for activity lists. */
export function formatProviderAbsentTombstoneSummary(
  providerId: string,
  providerAbsentAt: string,
  subsource?: string | null,
): string {
  const providerLabel = providerSourceLabel(providerId, subsource);
  return `Removed from ${providerLabel} · ${formatDateTime(providerAbsentAt)}`;
}

/** Format removed provider sources for canonical activities with partial absence. */
export function formatProviderPartialAbsenceSummary(
  sources: ProviderAbsentSource[],
): string | null {
  if (sources.length === 0) return null;
  return sources
    .map((source) => {
      const providerLabel = providerSourceLabel(source.providerId, source.subsource);
      const removedAt = source.providerAbsentAt
        ? ` · ${formatDateTime(source.providerAbsentAt)}`
        : "";
      return `${providerLabel} removed${removedAt}`;
    })
    .join(", ");
}

/** Explain why a provider-absent activity was hidden on detail pages. */
export function providerAbsentExplanation(id: string, subsource?: string | null): string {
  if (id === "apple_health" && subsource) {
    return `The Apple Health copy of this workout (originally from ${subsource}) was removed from sync. This does not mean ${subsource} deleted the activity.`;
  }
  return `This activity was hidden because ${providerSourceLabel(id, subsource)} reported it as deleted or missing.`;
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
  "amazfit-zepp": "#00B588",
  ble_heart_rate: "#E0245E",
};

/** Providers that reuse another provider's logo asset. */
const LOGO_ALIASES: Readonly<Record<string, string>> = {
  whoop_ble: "whoop",
  "garmin-dump": "garmin",
};

function resolveLogoId(id: string): string {
  return LOGO_ALIASES[id] ?? id;
}

/** Returns "svg", "png", or null depending on what logo file a provider has. */
export function providerLogoType(id: string): "svg" | "png" | null {
  const resolved = resolveLogoId(id);
  if (SVG_LOGOS.has(resolved)) return "svg";
  if (PNG_LOGOS.has(resolved)) return "png";
  return null;
}

/** Logo asset filename stem for a provider ID. */
export function providerLogoId(id: string): string {
  return resolveLogoId(id);
}
