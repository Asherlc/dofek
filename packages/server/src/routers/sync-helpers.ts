import { getConfiguredProviderIds } from "dofek/jobs/provider-queue-config";
import type { SyncJobData } from "dofek/jobs/queues";
import { registerProvider } from "dofek/providers/registry";

export const CUSTOM_AUTH_PROVIDERS: Record<string, string> = {
  whoop: "custom:whoop",
  garmin: "custom:garmin",
};

export const UPLOAD_IMPORT_PROVIDERS = [
  {
    id: "apple_health",
    name: "Apple Health",
    authType: "file-import",
    importOnly: true,
  },
] as const;

export function toJobId(id: string | number | undefined, providerId: string): string {
  return id === undefined ? `job-${providerId}-${Date.now()}` : `${providerId}:${id}`;
}

/** Parse a composite jobId into its provider hint and raw BullMQ ID.
 *  New format: "providerId:rawId", where rawId may be numeric or non-numeric.
 *  Legacy format: plain raw ID string. */
export function parseJobId(compositeId: string): { providerId: string | null; rawId: string } {
  const colonIndex = compositeId.indexOf(":");
  if (colonIndex > 0) {
    return {
      providerId: compositeId.slice(0, colonIndex),
      rawId: compositeId.slice(colonIndex + 1),
    };
  }
  return { providerId: null, rawId: compositeId };
}

export function resolveSinceIso(sinceDays?: number): string {
  return sinceDays
    ? new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString()
    : new Date(0).toISOString();
}

export function resolveTargetRefreshWindow(sinceDays?: number): SyncJobData["targetRefreshWindow"] {
  return sinceDays ? { type: "days", days: sinceDays } : { type: "full" };
}

let registrationPromise: Promise<void> | null = null;

export function ensureProvidersRegistered(): Promise<void> {
  if (!registrationPromise) {
    registrationPromise = doRegisterProviders();
  }
  return registrationPromise;
}

async function doRegisterProviders() {
  const providers = [
    ["wahoo", () => import("dofek/providers/wahoo/provider").then((m) => new m.WahooProvider())],
    ["withings", () => import("dofek/providers/withings").then((m) => new m.WithingsProvider())],
    ["peloton", () => import("dofek/providers/peloton").then((m) => new m.PelotonProvider())],
    ["fatsecret", () => import("dofek/providers/fatsecret").then((m) => new m.FatSecretProvider())],
    ["whoop", () => import("dofek/providers/whoop").then((m) => new m.WhoopProvider())],
    [
      "ride-with-gps",
      () => import("dofek/providers/ride-with-gps").then((m) => new m.RideWithGpsProvider()),
    ],
    [
      "strong-csv",
      () => import("dofek/providers/strong-csv").then((m) => new m.StrongCsvProvider()),
    ],
    ["polar", () => import("dofek/providers/polar").then((m) => new m.PolarProvider())],
    ["fitbit", () => import("dofek/providers/fitbit").then((m) => new m.FitbitProvider())],
    ["garmin", () => import("dofek/providers/garmin").then((m) => new m.GarminProvider())],
    ["strava", () => import("dofek/providers/strava").then((m) => new m.StravaProvider())],
    [
      "cronometer-csv",
      () => import("dofek/providers/cronometer-csv").then((m) => new m.CronometerCsvProvider()),
    ],
    ["oura", () => import("dofek/providers/oura").then((m) => new m.OuraProvider())],
    ["bodyspec", () => import("dofek/providers/bodyspec").then((m) => new m.BodySpecProvider())],
    [
      "eight-sleep",
      () => import("dofek/providers/eight-sleep").then((m) => new m.EightSleepProvider()),
    ],
    ["zwift", () => import("dofek/providers/zwift").then((m) => new m.ZwiftProvider())],
    [
      "trainerroad",
      () => import("dofek/providers/trainerroad").then((m) => new m.TrainerRoadProvider()),
    ],
    [
      "ultrahuman",
      () => import("dofek/providers/ultrahuman").then((m) => new m.UltrahumanProvider()),
    ],
    [
      "amazfit-zepp",
      () => import("dofek/providers/amazfit-zepp").then((m) => new m.AmazfitZeppProvider()),
    ],
    [
      "mapmyfitness",
      () => import("dofek/providers/mapmyfitness").then((m) => new m.MapMyFitnessProvider()),
    ],
    ["suunto", () => import("dofek/providers/suunto").then((m) => new m.SuuntoProvider())],
    ["coros", () => import("dofek/providers/coros").then((m) => new m.CorosProvider())],
    ["concept2", () => import("dofek/providers/concept2").then((m) => new m.Concept2Provider())],
    ["komoot", () => import("dofek/providers/komoot").then((m) => new m.KomootProvider())],
    ["xert", () => import("dofek/providers/xert").then((m) => new m.XertProvider())],
    [
      "cycling-analytics",
      () =>
        import("dofek/providers/cycling-analytics").then((m) => new m.CyclingAnalyticsProvider()),
    ],
    ["wger", () => import("dofek/providers/wger").then((m) => new m.WgerProvider())],
    ["decathlon", () => import("dofek/providers/decathlon").then((m) => new m.DecathlonProvider())],
    ["velohero", () => import("dofek/providers/velohero").then((m) => new m.VeloHeroProvider())],
    [
      "auto-supplements",
      () => import("dofek/providers/auto-supplements").then((m) => new m.AutoSupplementsProvider()),
    ],
  ] as const;

  for (const [name, loadProvider] of providers) {
    try {
      registerProvider(await loadProvider());
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to register ${name} provider: ${message}`);
    }
  }
}

export function mapBullMqStateToSyncStatus(state: string): "running" | "done" | "error" {
  switch (state) {
    case "completed":
      return "done";
    case "failed":
      return "error";
    default:
      return "running";
  }
}

export function getAllConfiguredProviderIds(): Set<string> {
  return new Set(getConfiguredProviderIds());
}
