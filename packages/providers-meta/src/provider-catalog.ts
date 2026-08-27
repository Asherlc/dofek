export interface ProviderFamily {
  id: string;
  label: string;
  methodLabel: string;
}

export interface ProviderCatalogEntry {
  label: string;
  family?: ProviderFamily;
  logo?: { id?: string; type: "png" | "svg" };
  brandColor?: string;
}

const garminConnect: ProviderFamily = {
  id: "garmin",
  label: "Garmin",
  methodLabel: "Garmin Connect",
};

const garminExport: ProviderFamily = {
  id: "garmin",
  label: "Garmin",
  methodLabel: "Data export",
};

const zeppCloud: ProviderFamily = {
  id: "zepp",
  label: "Zepp",
  methodLabel: "Zepp cloud",
};

const zeppApp: ProviderFamily = {
  id: "zepp",
  label: "Zepp",
  methodLabel: "Zepp app (Zepp OS)",
};

const kayaWeb: ProviderFamily = { id: "kaya", label: "Kaya", methodLabel: "Web" };
const kayaExport: ProviderFamily = {
  id: "kaya",
  label: "Kaya",
  methodLabel: "Data export (CSV file)",
};

/**
 * Canonical user-facing presentation for technical provider IDs.
 *
 * Provider IDs remain the ingestion and provenance identifiers. The optional
 * family describes only how multiple connection methods are presented together
 * in client provider settings.
 */
export const PROVIDER_CATALOG: Readonly<Record<string, ProviderCatalogEntry>> = {
  google: { label: "Google", logo: { type: "svg" } },
  apple: { label: "Apple", logo: { type: "svg" } },
  github: { label: "GitHub" },
  slack: { label: "Slack" },
  strava: { label: "Strava", logo: { type: "svg" } },
  wahoo: { label: "Wahoo", logo: { type: "png" } },
  fitbit: { label: "Fitbit", logo: { type: "svg" } },
  "ride-with-gps": { label: "Ride with GPS", logo: { type: "png" } },
  "intervals.icu": { label: "Intervals.icu" },
  withings: { label: "Withings", logo: { type: "png" } },
  garmin: { label: "Garmin", family: garminConnect, logo: { type: "svg" } },
  "garmin-dump": {
    label: "Garmin Dump",
    family: garminExport,
    logo: { id: "garmin", type: "svg" },
  },
  "fit-file": { label: "FIT File" },
  polar: { label: "Polar", logo: { type: "png" } },
  whoop: { label: "WHOOP (Cloud)", logo: { type: "png" } },
  peloton: { label: "Peloton", logo: { type: "svg" } },
  oura: { label: "Oura", logo: { type: "png" } },
  zwift: { label: "Zwift", logo: { type: "png" } },
  suunto: { label: "Suunto", logo: { type: "png" } },
  trainerroad: { label: "TrainerRoad", logo: { type: "svg" } },
  komoot: { label: "Komoot", logo: { type: "svg" } },
  concept2: { label: "Concept2", logo: { type: "png" } },
  coros: { label: "COROS", logo: { type: "png" } },
  "cycling-analytics": { label: "Cycling Analytics" },
  cycling_analytics: { label: "Cycling Analytics", logo: { type: "png" } },
  decathlon: { label: "Decathlon", logo: { type: "png" } },
  "eight-sleep": { label: "Eight Sleep", logo: { type: "svg" } },
  fatsecret: { label: "fatsecret", logo: { type: "png" } },
  mapmyfitness: { label: "MapMyFitness", logo: { type: "png" } },
  ultrahuman: { label: "Ultrahuman", logo: { type: "png" } },
  "amazfit-zepp": { label: "Amazfit/Zepp", family: zeppCloud, brandColor: "#00B588" },
  "zos-app": { label: "Zepp OS App", family: zeppApp },
  velohero: { label: "VeloHero", brandColor: "#FF6600" },
  "mountain-project": { label: "Mountain Project", brandColor: "#1F5A88" },
  wger: { label: "Wger", logo: { type: "png" } },
  xert: { label: "Xert", logo: { type: "png" } },
  "apple-health": { label: "Apple Health" },
  apple_health: { label: "Apple Health", logo: { type: "png" } },
  "strong-csv": { label: "Strong", logo: { type: "png" } },
  "cronometer-csv": { label: "Cronometer", logo: { type: "png" } },
  kaya: { label: "Kaya", family: kayaWeb, brandColor: "#1F9D55" },
  "kaya-export": { label: "Kaya", family: kayaExport },
  bodyspec: { label: "BodySpec", brandColor: "#00B4D8" },
  dofek: { label: "Dofek", brandColor: "#4A9D8E" },
  manual_review: { label: "Manual review" },
  whoop_ble: { label: "WHOOP (Bluetooth)", logo: { id: "whoop", type: "png" } },
  ble_heart_rate: { label: "Heart Rate Monitor (Bluetooth)", brandColor: "#E0245E" },
};

export function providerCatalogEntry(providerId: string): ProviderCatalogEntry | undefined {
  return PROVIDER_CATALOG[providerId];
}

export function providerFamily(providerId: string): ProviderFamily | null {
  return providerCatalogEntry(providerId)?.family ?? null;
}

export type ProviderEntryGroup<T extends { id: string }> =
  | { kind: "provider"; provider: T }
  | {
      kind: "family";
      family: Pick<ProviderFamily, "id" | "label">;
      providers: readonly [T, T, ...T[]];
    };

function hasAtLeastTwo<T>(entries: readonly T[]): entries is readonly [T, T, ...T[]] {
  return entries.length >= 2;
}

/**
 * Groups only the provider IDs explicitly assigned to the same family.
 * A family with one available connection method remains a regular provider
 * entry, so the clients do not show a meaningless method chooser.
 */
export function groupProviderEntries<T extends { id: string }>(
  providers: readonly T[],
): ProviderEntryGroup<T>[] {
  const membersByFamily = new Map<string, T[]>();
  for (const provider of providers) {
    const family = providerFamily(provider.id);
    if (!family) continue;
    const members = membersByFamily.get(family.id) ?? [];
    members.push(provider);
    membersByFamily.set(family.id, members);
  }

  const emittedFamilies = new Set<string>();
  const groups: ProviderEntryGroup<T>[] = [];
  for (const provider of providers) {
    const family = providerFamily(provider.id);
    const members = family ? membersByFamily.get(family.id) : undefined;
    if (!family || !members || !hasAtLeastTwo(members)) {
      groups.push({ kind: "provider", provider });
      continue;
    }
    if (emittedFamilies.has(family.id)) continue;
    emittedFamilies.add(family.id);
    groups.push({
      kind: "family",
      family: { id: family.id, label: family.label },
      providers: members,
    });
  }
  return groups;
}
