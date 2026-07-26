import { getConfiguredProviderIds } from "dofek/jobs/provider-queue-config";
import type { ImportJobData } from "dofek/jobs/queues";
import { registerProviderSyncRequestResolver } from "dofek/jobs/sync-request-query-registration";
import { CUSTOM_AUTH_PROVIDERS } from "dofek/lib/custom-auth-providers";
import { registerProvider } from "dofek/providers/registry";

export { CUSTOM_AUTH_PROVIDERS };

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
    ["garmin", () => import("dofek/providers/garmin").then((m) => new m.GarminProvider())],
    [
      "garmin-dump",
      () => import("dofek/providers/garmin-dump").then((m) => new m.GarminDumpProvider()),
    ],
    ["fit-file", () => import("dofek/providers/fit-file").then((m) => new m.FitFileProvider())],
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
      () =>
        import("dofek/providers/amazfit-zepp").then(
          (amazfitZeppModule) => new amazfitZeppModule.AmazfitZeppProvider(),
        ),
    ],
    ["concept2", () => import("dofek/providers/concept2").then((m) => new m.Concept2Provider())],
    ["xert", () => import("dofek/providers/xert").then((m) => new m.XertProvider())],
    [
      "cycling-analytics",
      () =>
        import("dofek/providers/cycling-analytics").then((m) => new m.CyclingAnalyticsProvider()),
    ],
    ["wger", () => import("dofek/providers/wger").then((m) => new m.WgerProvider())],
    ["velohero", () => import("dofek/providers/velohero").then((m) => new m.VeloHeroProvider())],
    [
      "auto-supplements",
      () => import("dofek/providers/auto-supplements").then((m) => new m.AutoSupplementsProvider()),
    ],
    [
      "kaya-export",
      () => import("dofek/providers/kaya/provider").then((m) => new m.KayaProvider()),
    ],
    [
      "zos-app",
      () => import("dofek/providers/zos-app/provider").then((m) => new m.ZosAppProvider()),
    ],
  ] as const;

  for (const [name, loadProvider] of providers) {
    try {
      const provider = await loadProvider();
      registerProvider(provider);
      await registerProviderSyncRequestResolver(provider);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to register ${name} provider: ${message}`);
    }
  }
}

export function getAllConfiguredProviderIds(): Set<string> {
  return new Set(getConfiguredProviderIds());
}

const importTypeToProviderId: Record<ImportJobData["importType"], string> = {
  "apple-health": "apple_health",
  "strong-csv": "strong-csv",
  "cronometer-csv": "cronometer-csv",
  "kaya-export": "kaya-export",
  "zos-app": "zos-app",
  "garmin-dump": "garmin-dump",
  "fit-file": "fit-file",
};

function isKnownImportType(importType: string): importType is ImportJobData["importType"] {
  return Object.hasOwn(importTypeToProviderId, importType);
}

export function providerIdForImportType(importType: string): string | undefined {
  if (!isKnownImportType(importType)) {
    return undefined;
  }
  return importTypeToProviderId[importType];
}

export function isJobDataForUser(data: unknown, userId: string): data is object {
  if (typeof data !== "object" || data === null) {
    return false;
  }
  if (!("userId" in data)) {
    return false;
  }
  return Reflect.get(data, "userId") === userId;
}

export function importTypeFromJobData(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null || !("importType" in data)) {
    return undefined;
  }
  const importType = Reflect.get(data, "importType");
  if (typeof importType !== "string") {
    return undefined;
  }
  return importType;
}

export function providerIdFromSyncJobData(
  data: object,
  queueProviderId: string,
  knownProviderIds: ReadonlySet<string>,
): string | undefined {
  if (!("providerId" in data)) {
    return knownProviderIds.has(queueProviderId) ? queueProviderId : undefined;
  }
  const providerId = Reflect.get(data, "providerId");
  if (typeof providerId !== "string" || providerId.length === 0) {
    return knownProviderIds.has(queueProviderId) ? queueProviderId : undefined;
  }
  if (knownProviderIds.has(providerId)) {
    return providerId;
  }
  return knownProviderIds.has(queueProviderId) ? queueProviderId : undefined;
}
