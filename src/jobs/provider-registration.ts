import { registerProvider } from "../providers/index.ts";
import { registerProviderSyncRequestResolver } from "./sync-request-query-registration.ts";

let registrationPromise: Promise<void> | null = null;

export function ensureProvidersRegistered(): Promise<void> {
  if (!registrationPromise) {
    registrationPromise = doRegisterProviders();
  }
  return registrationPromise;
}

async function doRegisterProviders() {
  const providers = [
    ["wahoo", () => import("../providers/wahoo/provider.ts").then((m) => new m.WahooProvider())],
    ["withings", () => import("../providers/withings.ts").then((m) => new m.WithingsProvider())],
    ["peloton", () => import("../providers/peloton.ts").then((m) => new m.PelotonProvider())],
    [
      "fatsecret",
      () => import("../providers/fatsecret/provider.ts").then((m) => new m.FatSecretProvider()),
    ],
    ["whoop", () => import("../providers/whoop/provider.ts").then((m) => new m.WhoopProvider())],
    ["kaya", () => import("../providers/kaya-sync.ts").then((m) => new m.KayaSyncProvider())],
    [
      "ride-with-gps",
      () => import("../providers/ride-with-gps.ts").then((m) => new m.RideWithGpsProvider()),
    ],
    [
      "strong-csv",
      () => import("../providers/strong-csv.ts").then((m) => new m.StrongCsvProvider()),
    ],
    ["polar", () => import("../providers/polar/provider.ts").then((m) => new m.PolarProvider())],
    ["garmin", () => import("../providers/garmin/provider.ts").then((m) => new m.GarminProvider())],
    [
      "garmin-dump",
      () => import("../providers/garmin-dump.ts").then((m) => new m.GarminDumpProvider()),
    ],
    ["fit-file", () => import("../providers/fit-file.ts").then((m) => new m.FitFileProvider())],
    ["strava", () => import("../providers/strava.ts").then((m) => new m.StravaProvider())],
    [
      "cronometer-csv",
      () => import("../providers/cronometer-csv.ts").then((m) => new m.CronometerCsvProvider()),
    ],
    ["oura", () => import("../providers/oura/provider.ts").then((m) => new m.OuraProvider())],
    ["bodyspec", () => import("../providers/bodyspec.ts").then((m) => new m.BodySpecProvider())],
    [
      "eight-sleep",
      () => import("../providers/eight-sleep.ts").then((m) => new m.EightSleepProvider()),
    ],
    ["zwift", () => import("../providers/zwift.ts").then((m) => new m.ZwiftProvider())],
    [
      "trainerroad",
      () => import("../providers/trainerroad.ts").then((m) => new m.TrainerRoadProvider()),
    ],
    [
      "ultrahuman",
      () => import("../providers/ultrahuman.ts").then((m) => new m.UltrahumanProvider()),
    ],
    ["concept2", () => import("../providers/concept2.ts").then((m) => new m.Concept2Provider())],
    ["xert", () => import("../providers/xert.ts").then((m) => new m.XertProvider())],
    [
      "cycling-analytics",
      () =>
        import("../providers/cycling-analytics.ts").then((m) => new m.CyclingAnalyticsProvider()),
    ],
    ["wger", () => import("../providers/wger.ts").then((m) => new m.WgerProvider())],
    ["velohero", () => import("../providers/velohero.ts").then((m) => new m.VeloHeroProvider())],
    [
      "mountain-project",
      () => import("../providers/mountain-project.ts").then((m) => new m.MountainProjectProvider()),
    ],
    [
      "auto-supplements",
      () => import("../providers/auto-supplements.ts").then((m) => new m.AutoSupplementsProvider()),
    ],
    [
      "amazfit-zepp",
      () => import("../providers/amazfit-zepp.ts").then((m) => new m.AmazfitZeppProvider()),
    ],
    [
      "kaya-export",
      () => import("../providers/kaya/provider.ts").then((m) => new m.KayaProvider()),
    ],
    [
      "zos-app",
      () => import("../providers/zos-app/provider.ts").then((m) => new m.ZosAppProvider()),
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
