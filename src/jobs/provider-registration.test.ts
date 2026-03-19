import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock registerProvider before importing the module under test
const mockRegisterProvider = vi.fn();
vi.mock("../providers/index.ts", () => ({
  registerProvider: (...args: unknown[]) => mockRegisterProvider(...args),
}));

// Mock all provider modules to return simple objects
const mockProviders = {
  wahoo: { id: "wahoo" },
  withings: { id: "withings" },
  peloton: { id: "peloton" },
  fatsecret: { id: "fatsecret" },
  whoop: { id: "whoop" },
  "ride-with-gps": { id: "ride-with-gps" },
  "strong-csv": { id: "strong-csv" },
  polar: { id: "polar" },
  fitbit: { id: "fitbit" },
  garmin: { id: "garmin" },
  strava: { id: "strava" },
  "cronometer-csv": { id: "cronometer-csv" },
  oura: { id: "oura" },
  bodyspec: { id: "bodyspec" },
  "eight-sleep": { id: "eight-sleep" },
  zwift: { id: "zwift" },
  trainerroad: { id: "trainerroad" },
  ultrahuman: { id: "ultrahuman" },
  mapmyfitness: { id: "mapmyfitness" },
  suunto: { id: "suunto" },
  coros: { id: "coros" },
  concept2: { id: "concept2" },
  komoot: { id: "komoot" },
  xert: { id: "xert" },
  "cycling-analytics": { id: "cycling-analytics" },
  wger: { id: "wger" },
  decathlon: { id: "decathlon" },
  velohero: { id: "velohero" },
};

vi.mock("../providers/wahoo.ts", () => ({
  WahooProvider: vi.fn(() => mockProviders.wahoo),
}));
vi.mock("../providers/withings.ts", () => ({
  WithingsProvider: vi.fn(() => mockProviders.withings),
}));
vi.mock("../providers/peloton.ts", () => ({
  PelotonProvider: vi.fn(() => mockProviders.peloton),
}));
vi.mock("../providers/fatsecret.ts", () => ({
  FatSecretProvider: vi.fn(() => mockProviders.fatsecret),
}));
vi.mock("../providers/whoop.ts", () => ({
  WhoopProvider: vi.fn(() => mockProviders.whoop),
}));
vi.mock("../providers/ride-with-gps.ts", () => ({
  RideWithGpsProvider: vi.fn(() => mockProviders["ride-with-gps"]),
}));
vi.mock("../providers/strong-csv.ts", () => ({
  StrongCsvProvider: vi.fn(() => mockProviders["strong-csv"]),
}));
vi.mock("../providers/polar.ts", () => ({
  PolarProvider: vi.fn(() => mockProviders.polar),
}));
vi.mock("../providers/fitbit.ts", () => ({
  FitbitProvider: vi.fn(() => mockProviders.fitbit),
}));
vi.mock("../providers/garmin.ts", () => ({
  GarminProvider: vi.fn(() => mockProviders.garmin),
}));
vi.mock("../providers/strava.ts", () => ({
  StravaProvider: vi.fn(() => mockProviders.strava),
}));
vi.mock("../providers/cronometer-csv.ts", () => ({
  CronometerCsvProvider: vi.fn(() => mockProviders["cronometer-csv"]),
}));
vi.mock("../providers/oura.ts", () => ({
  OuraProvider: vi.fn(() => mockProviders.oura),
}));
vi.mock("../providers/bodyspec.ts", () => ({
  BodySpecProvider: vi.fn(() => mockProviders.bodyspec),
}));
vi.mock("../providers/eight-sleep.ts", () => ({
  EightSleepProvider: vi.fn(() => mockProviders["eight-sleep"]),
}));
vi.mock("../providers/zwift.ts", () => ({
  ZwiftProvider: vi.fn(() => mockProviders.zwift),
}));
vi.mock("../providers/trainerroad.ts", () => ({
  TrainerRoadProvider: vi.fn(() => mockProviders.trainerroad),
}));
vi.mock("../providers/ultrahuman.ts", () => ({
  UltrahumanProvider: vi.fn(() => mockProviders.ultrahuman),
}));
vi.mock("../providers/mapmyfitness.ts", () => ({
  MapMyFitnessProvider: vi.fn(() => mockProviders.mapmyfitness),
}));
vi.mock("../providers/suunto.ts", () => ({
  SuuntoProvider: vi.fn(() => mockProviders.suunto),
}));
vi.mock("../providers/coros.ts", () => ({
  CorosProvider: vi.fn(() => mockProviders.coros),
}));
vi.mock("../providers/concept2.ts", () => ({
  Concept2Provider: vi.fn(() => mockProviders.concept2),
}));
vi.mock("../providers/komoot.ts", () => ({
  KomootProvider: vi.fn(() => mockProviders.komoot),
}));
vi.mock("../providers/xert.ts", () => ({
  XertProvider: vi.fn(() => mockProviders.xert),
}));
vi.mock("../providers/cycling-analytics.ts", () => ({
  CyclingAnalyticsProvider: vi.fn(() => mockProviders["cycling-analytics"]),
}));
vi.mock("../providers/wger.ts", () => ({
  WgerProvider: vi.fn(() => mockProviders.wger),
}));
vi.mock("../providers/decathlon.ts", () => ({
  DecathlonProvider: vi.fn(() => mockProviders.decathlon),
}));
vi.mock("../providers/velohero.ts", () => ({
  VeloHeroProvider: vi.fn(() => mockProviders.velohero),
}));

// Mock node:fs to simulate missing supplements.json (ENOENT)
vi.mock("node:fs", () => ({
  readFileSync: vi.fn(() => {
    const err = new Error("ENOENT: no such file or directory");
    throw err;
  }),
}));

const PROVIDER_COUNT = Object.keys(mockProviders).length;

describe("provider-registration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset the module so registrationPromise is cleared
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers all providers", async () => {
    const { ensureProvidersRegistered } = await import("./provider-registration.ts");
    await ensureProvidersRegistered();

    expect(mockRegisterProvider).toHaveBeenCalledTimes(PROVIDER_COUNT);
  });

  it("only registers once (memoization)", async () => {
    const { ensureProvidersRegistered } = await import("./provider-registration.ts");
    await ensureProvidersRegistered();
    await ensureProvidersRegistered();

    expect(mockRegisterProvider).toHaveBeenCalledTimes(PROVIDER_COUNT);
  });

  it("continues registering other providers when one fails", async () => {
    mockRegisterProvider.mockImplementation((provider: { id: string }) => {
      if (provider.id === "peloton") {
        throw new Error("Peloton init failed");
      }
    });

    const { ensureProvidersRegistered } = await import("./provider-registration.ts");
    await ensureProvidersRegistered();

    // Should have attempted all registrations even though peloton failed
    expect(mockRegisterProvider).toHaveBeenCalledTimes(PROVIDER_COUNT);
  });
});
