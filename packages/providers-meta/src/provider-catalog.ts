export interface ProviderFamily {
  id: string;
  label: string;
  methodLabel: string;
}

export type ProviderCredentialIdentifier = "email" | "username";

/** Approved Data Sources activity tabs, in display order. */
export const PROVIDER_DATA_SOURCE_TABS = [
  { id: "all", label: "All" },
  { id: "cycling", label: "Cycling" },
  { id: "running", label: "Running" },
  { id: "hiking", label: "Hiking" },
  { id: "climbing", label: "Climbing" },
  { id: "strength", label: "Strength" },
  { id: "rowing", label: "Rowing" },
  { id: "sleep_recovery", label: "Sleep & Recovery" },
  { id: "nutrition", label: "Nutrition" },
  { id: "body_composition", label: "Body Composition" },
] as const;

export type ProviderDataSourceCategory = (typeof PROVIDER_DATA_SOURCE_TABS)[number]["id"];
export type ProviderDataCategory = Exclude<ProviderDataSourceCategory, "all">;

export interface ProviderCatalogEntry {
  label: string;
  family?: ProviderFamily;
  logo?: { id?: string; type: "png" | "svg" };
  brandColor?: string;
  credentialIdentifier?: ProviderCredentialIdentifier;
  credentialInstructions?: string;
  /**
   * Activity/data tabs this source matches based on data Dofek imports.
   * Omitted entries appear only under All (unknown IDs included).
   */
  categories?: readonly ProviderDataCategory[];
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

const whoopCloud: ProviderFamily = { id: "whoop", label: "WHOOP", methodLabel: "Cloud" };
const whoopBluetooth: ProviderFamily = {
  id: "whoop",
  label: "WHOOP",
  methodLabel: "Bluetooth",
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

const auroraBoardCredentials = {
  credentialIdentifier: "username" as const,
  credentialInstructions:
    "Use an existing board account after accepting its terms of use and privacy policy in the board app.",
};

const climbing = ["climbing"] as const satisfies readonly ProviderDataCategory[];
const multiSport = [
  "cycling",
  "running",
  "hiking",
  "climbing",
  "strength",
  "rowing",
] as const satisfies readonly ProviderDataCategory[];
const garminLike = [
  ...multiSport,
  "sleep_recovery",
] as const satisfies readonly ProviderDataCategory[];
const appleHealthCats = [
  ...multiSport,
  "sleep_recovery",
  "nutrition",
  "body_composition",
] as const satisfies readonly ProviderDataCategory[];
const whoopCats = [
  "cycling",
  "running",
  "hiking",
  "climbing",
  "strength",
  "rowing",
  "sleep_recovery",
] as const satisfies readonly ProviderDataCategory[];

/**
 * Canonical user-facing presentation for technical provider IDs.
 *
 * Provider IDs remain the ingestion and provenance identifiers. The optional
 * family describes only how multiple connection methods are presented together
 * in client provider settings. Categories classify imported data for Data
 * Sources activity tabs.
 */
export const PROVIDER_CATALOG: Readonly<Record<string, ProviderCatalogEntry>> = {
  kilter: { label: "Kilter Board", logo: { type: "png" }, categories: climbing },
  tension: {
    label: "Tension Board",
    logo: { type: "png" },
    ...auroraBoardCredentials,
    categories: climbing,
  },
  grasshopper: {
    label: "Grasshopper Board",
    logo: { type: "png" },
    ...auroraBoardCredentials,
    categories: climbing,
  },
  decoy: {
    label: "Decoy Board",
    logo: { type: "png" },
    ...auroraBoardCredentials,
    categories: climbing,
  },
  soill: {
    label: "So iLL Board",
    logo: { type: "png" },
    ...auroraBoardCredentials,
    categories: climbing,
  },
  touchstone: {
    label: "Touchstone Board",
    logo: { type: "png" },
    ...auroraBoardCredentials,
    categories: climbing,
  },
  "aurora-board": {
    label: "Aurora Board",
    logo: { type: "png" },
    ...auroraBoardCredentials,
    categories: climbing,
  },
  crimpd: {
    label: "Crimpd",
    logo: { type: "png" },
    categories: ["climbing", "strength"],
  },
  "eight-a": { label: "8a.nu / Vertical-Life", logo: { type: "png" }, categories: climbing },
  moonboard: { label: "MoonBoard", logo: { type: "png" }, categories: climbing },
  boardsesh: {
    label: "BoardSesh",
    logo: { type: "png" },
    credentialIdentifier: "email",
    credentialInstructions:
      "Sign in with your BoardSesh email and password. Apple/Google-only accounts need a BoardSesh password.",
    categories: climbing,
  },
  google: { label: "Google", logo: { type: "svg" } },
  apple: { label: "Apple", logo: { type: "svg" } },
  github: { label: "GitHub", logo: { type: "png" } },
  slack: { label: "Slack", logo: { type: "png" } },
  strava: { label: "Strava", logo: { type: "svg" }, categories: multiSport },
  wahoo: {
    label: "Wahoo",
    logo: { type: "png" },
    categories: ["cycling", "running", "hiking", "strength", "rowing"],
  },
  fitbit: {
    label: "Fitbit",
    logo: { type: "svg" },
    categories: [
      "cycling",
      "running",
      "hiking",
      "strength",
      "rowing",
      "sleep_recovery",
      "body_composition",
    ],
  },
  "ride-with-gps": {
    label: "Ride with GPS",
    logo: { type: "png" },
    categories: ["cycling", "running", "hiking"],
  },
  "intervals.icu": {
    label: "Intervals.icu",
    logo: { type: "svg" },
    categories: [...multiSport, "body_composition", "sleep_recovery"],
  },
  withings: {
    label: "Withings",
    logo: { type: "png" },
    categories: ["body_composition", "sleep_recovery"],
  },
  garmin: {
    label: "Garmin",
    family: garminConnect,
    logo: { type: "svg" },
    categories: garminLike,
  },
  "garmin-dump": {
    label: "Garmin Dump",
    family: garminExport,
    logo: { id: "garmin", type: "svg" },
    categories: [...garminLike, "body_composition"],
  },
  "fit-file": {
    label: "FIT File",
    categories: [...multiSport, "body_composition"],
  },
  polar: {
    label: "Polar",
    logo: { type: "png" },
    categories: [...multiSport, "sleep_recovery"],
  },
  whoop: {
    label: "WHOOP (Cloud)",
    family: whoopCloud,
    logo: { type: "png" },
    categories: whoopCats,
  },
  peloton: {
    label: "Peloton",
    logo: { type: "svg" },
    categories: ["cycling", "running", "rowing", "strength"],
  },
  oura: {
    label: "Oura",
    logo: { type: "png" },
    categories: ["cycling", "running", "hiking", "strength", "rowing", "sleep_recovery"],
  },
  zwift: { label: "Zwift", logo: { type: "png" }, categories: ["cycling", "running"] },
  suunto: {
    label: "Suunto",
    logo: { type: "png" },
    categories: ["cycling", "running", "hiking", "strength", "rowing"],
  },
  trainerroad: { label: "TrainerRoad", logo: { type: "svg" }, categories: ["cycling"] },
  komoot: {
    label: "Komoot",
    logo: { type: "svg" },
    categories: ["cycling", "running", "hiking"],
  },
  concept2: { label: "Concept2", logo: { type: "png" }, categories: ["rowing", "cycling"] },
  coros: {
    label: "COROS",
    logo: { type: "png" },
    categories: ["cycling", "running", "hiking", "strength", "rowing", "sleep_recovery"],
  },
  "cycling-analytics": {
    label: "Cycling Analytics",
    logo: { id: "cycling_analytics", type: "png" },
    categories: ["cycling"],
  },
  cycling_analytics: {
    label: "Cycling Analytics",
    logo: { type: "png" },
    categories: ["cycling"],
  },
  decathlon: {
    label: "Decathlon",
    logo: { type: "png" },
    categories: multiSport,
  },
  "eight-sleep": {
    label: "Eight Sleep",
    logo: { type: "svg" },
    categories: ["sleep_recovery"],
  },
  fatsecret: { label: "fatsecret", logo: { type: "png" }, categories: ["nutrition"] },
  ziva: { label: "Ziva", logo: { type: "png" }, categories: ["nutrition"] },
  trailforks: { label: "Trailforks", categories: ["cycling", "running", "hiking"] },
  mapmyfitness: {
    label: "MapMyFitness",
    logo: { type: "png" },
    categories: ["cycling", "running", "hiking", "strength", "rowing"],
  },
  runalyze: { label: "Runalyze", categories: ["running"] },
  ultrahuman: {
    label: "Ultrahuman",
    logo: { type: "png" },
    categories: ["sleep_recovery"],
  },
  "amazfit-zepp": {
    label: "Amazfit/Zepp",
    family: zeppCloud,
    logo: { id: "zepp", type: "png" },
    categories: ["cycling", "running", "rowing", "sleep_recovery"],
  },
  "zos-app": {
    label: "Zepp OS App",
    family: zeppApp,
    logo: { id: "zepp", type: "png" },
  },
  "mountain-project": {
    label: "Mountain Project",
    brandColor: "#1F5A88",
    logo: { type: "png" },
    categories: climbing,
  },
  openbeta: { label: "OpenBeta", logo: { type: "svg" }, categories: climbing },
  thecrag: { label: "theCrag", logo: { type: "png" }, categories: climbing },
  wger: { label: "Wger", logo: { type: "png" }, categories: ["strength"] },
  xert: { label: "Xert", logo: { type: "png" }, categories: ["cycling"] },
  "apple-health": {
    label: "Apple Health",
    logo: { id: "apple_health", type: "png" },
    categories: appleHealthCats,
  },
  apple_health: {
    label: "Apple Health",
    logo: { type: "png" },
    categories: appleHealthCats,
  },
  "apple-watch": { label: "Apple Watch", logo: { type: "svg" } },
  "strong-csv": { label: "Strong", logo: { type: "png" }, categories: ["strength"] },
  "hang-ten": { label: "Hang Ten", logo: { type: "png" }, categories: climbing },
  "cronometer-csv": { label: "Cronometer", logo: { type: "png" }, categories: ["nutrition"] },
  kaya: { label: "Kaya", family: kayaWeb, logo: { type: "png" }, categories: climbing },
  "kaya-export": {
    label: "Kaya",
    family: kayaExport,
    logo: { id: "kaya", type: "png" },
    categories: climbing,
  },
  bodyspec: { label: "BodySpec", logo: { type: "png" }, categories: ["body_composition"] },
  dofek: { label: "Dofek", brandColor: "#4A9D8E" },
  manual_review: { label: "Manual review" },
  whoop_ble: {
    label: "WHOOP (Bluetooth)",
    family: whoopBluetooth,
    logo: { id: "whoop", type: "png" },
    categories: ["sleep_recovery"],
  },
  ble_heart_rate: { label: "Heart Rate Monitor (Bluetooth)", brandColor: "#E0245E" },
};

export function providerCatalogEntry(providerId: string): ProviderCatalogEntry | undefined {
  return PROVIDER_CATALOG[providerId];
}

export function providerFamily(providerId: string): ProviderFamily | null {
  return providerCatalogEntry(providerId)?.family ?? null;
}

function providerMatchesCategory(
  providerId: string,
  category: ProviderDataSourceCategory,
): boolean {
  if (category === "all") return true;
  return providerCatalogEntry(providerId)?.categories?.includes(category) ?? false;
}

export type ProviderEntryGroup<T extends { id: string }> =
  | { kind: "provider"; provider: T }
  | {
      kind: "family";
      family: Pick<ProviderFamily, "id" | "label">;
      providers: readonly [T, T, ...T[]];
    };

/** True when a single provider or any family member matches the activity tab. */
export function providerGroupMatchesCategory(
  group: ProviderEntryGroup<{ id: string }>,
  category: ProviderDataSourceCategory,
): boolean {
  return group.kind === "provider"
    ? providerMatchesCategory(group.provider.id, category)
    : group.providers.some((provider) => providerMatchesCategory(provider.id, category));
}

function hasAtLeastTwo<T>(entries: readonly T[]): entries is readonly [T, T, ...T[]] {
  return entries.length >= 2;
}

/**
 * Groups only the provider IDs explicitly assigned to the same family,
 * then orders the cards alphabetically by their displayed labels.
 * A family with one available connection method remains a regular provider
 * entry, so the clients do not show a meaningless method chooser.
 *
 * When `category` is not All, filtering runs after grouping: a family stays
 * when any available member matches so every available method remains visible.
 */
export function groupProviderEntries<T extends { id: string; label?: string }>(
  providers: readonly T[],
  category: ProviderDataSourceCategory = "all",
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
  const label = (group: ProviderEntryGroup<T>) =>
    group.kind === "family"
      ? group.family.label
      : (group.provider.label ??
        providerCatalogEntry(group.provider.id)?.label ??
        group.provider.id);
  const sorted = groups.sort((a, b) =>
    label(a).localeCompare(label(b), "en", { sensitivity: "base" }),
  );
  if (category === "all") return sorted;
  return sorted.filter((group) => providerGroupMatchesCategory(group, category));
}
