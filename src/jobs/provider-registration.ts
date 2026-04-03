import { logger } from "../logger.ts";
import { registerProvider } from "../providers/index.ts";

let registrationPromise: Promise<void> | null = null;

export function ensureProvidersRegistered(): Promise<void> {
  if (!registrationPromise) {
    registrationPromise = doRegisterProviders();
  }
  return registrationPromise;
}

async function doRegisterProviders() {
  const providers = [
    ["wahoo", () => import("../providers/wahoo/index.ts").then((m) => new m.WahooProvider())],
    ["withings", () => import("../providers/withings.ts").then((m) => new m.WithingsProvider())],
    ["peloton", () => import("../providers/peloton.ts").then((m) => new m.PelotonProvider())],
    ["fatsecret", () => import("../providers/fatsecret.ts").then((m) => new m.FatSecretProvider())],
    ["whoop", () => import("../providers/whoop.ts").then((m) => new m.WhoopProvider())],
    [
      "ride-with-gps",
      () => import("../providers/ride-with-gps.ts").then((m) => new m.RideWithGpsProvider()),
    ],
    [
      "strong-csv",
      () => import("../providers/strong-csv.ts").then((m) => new m.StrongCsvProvider()),
    ],
    ["polar", () => import("../providers/polar.ts").then((m) => new m.PolarProvider())],
    ["fitbit", () => import("../providers/fitbit.ts").then((m) => new m.FitbitProvider())],
    ["garmin", () => import("../providers/garmin.ts").then((m) => new m.GarminProvider())],
    ["strava", () => import("../providers/strava.ts").then((m) => new m.StravaProvider())],
    [
      "cronometer-csv",
      () => import("../providers/cronometer-csv.ts").then((m) => new m.CronometerCsvProvider()),
    ],
    ["oura", () => import("../providers/oura.ts").then((m) => new m.OuraProvider())],
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
    [
      "mapmyfitness",
      () => import("../providers/mapmyfitness.ts").then((m) => new m.MapMyFitnessProvider()),
    ],
    ["suunto", () => import("../providers/suunto.ts").then((m) => new m.SuuntoProvider())],
    ["coros", () => import("../providers/coros.ts").then((m) => new m.CorosProvider())],
    ["concept2", () => import("../providers/concept2.ts").then((m) => new m.Concept2Provider())],
    ["komoot", () => import("../providers/komoot.ts").then((m) => new m.KomootProvider())],
    ["xert", () => import("../providers/xert.ts").then((m) => new m.XertProvider())],
    [
      "cycling-analytics",
      () =>
        import("../providers/cycling-analytics.ts").then((m) => new m.CyclingAnalyticsProvider()),
    ],
    ["wger", () => import("../providers/wger.ts").then((m) => new m.WgerProvider())],
    ["decathlon", () => import("../providers/decathlon.ts").then((m) => new m.DecathlonProvider())],
    ["velohero", () => import("../providers/velohero.ts").then((m) => new m.VeloHeroProvider())],
    [
      "auto-supplements",
      () => import("../providers/auto-supplements.ts").then((m) => new m.AutoSupplementsProvider()),
    ],
  ] as const;

  for (const [name, loadProvider] of providers) {
    try {
      registerProvider(await loadProvider());
    } catch (err) {
      logger.warn(`[worker] Failed to register ${name} provider: ${err}`);
    }
  }
}
