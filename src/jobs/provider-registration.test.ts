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
  kaya: { id: "kaya" },
  "ride-with-gps": { id: "ride-with-gps" },
  "strong-csv": { id: "strong-csv" },
  polar: { id: "polar" },
  garmin: { id: "garmin" },
  "garmin-dump": { id: "garmin-dump" },
  "fit-file": { id: "fit-file" },
  strava: { id: "strava" },
  "cronometer-csv": { id: "cronometer-csv" },
  oura: { id: "oura" },
  bodyspec: { id: "bodyspec" },
  "eight-sleep": { id: "eight-sleep" },
  zwift: { id: "zwift" },
  trainerroad: { id: "trainerroad" },
  ultrahuman: { id: "ultrahuman" },
  concept2: { id: "concept2" },
  xert: { id: "xert" },
  "cycling-analytics": { id: "cycling-analytics" },
  wger: { id: "wger" },
  velohero: { id: "velohero" },
  "mountain-project": { id: "mountain-project" },
  "auto-supplements": { id: "auto-supplements" },
  "amazfit-zepp": { id: "amazfit-zepp" },
  "kaya-export": { id: "kaya-export" },
  "zos-app": { id: "zos-app" },
};

function mockProviderConstructor(provider: { id: string }) {
  return vi.fn(function vitestConstructor() {
    return provider;
  });
}

vi.mock("../providers/wahoo/provider.ts", () => ({
  WahooProvider: mockProviderConstructor(mockProviders.wahoo),
}));
vi.mock("../providers/withings.ts", () => ({
  WithingsProvider: mockProviderConstructor(mockProviders.withings),
}));
vi.mock("../providers/peloton.ts", () => ({
  PelotonProvider: mockProviderConstructor(mockProviders.peloton),
}));
vi.mock("../providers/fatsecret/provider.ts", () => ({
  FatSecretProvider: mockProviderConstructor(mockProviders.fatsecret),
}));
vi.mock("../providers/whoop/provider.ts", () => ({
  WhoopProvider: mockProviderConstructor(mockProviders.whoop),
}));
vi.mock("../providers/kaya-sync.ts", () => ({
  KayaSyncProvider: mockProviderConstructor(mockProviders.kaya),
}));
vi.mock("../providers/ride-with-gps.ts", () => ({
  RideWithGpsProvider: mockProviderConstructor(mockProviders["ride-with-gps"]),
}));
vi.mock("../providers/strong-csv.ts", () => ({
  StrongCsvProvider: mockProviderConstructor(mockProviders["strong-csv"]),
}));
vi.mock("../providers/polar/provider.ts", () => ({
  PolarProvider: mockProviderConstructor(mockProviders.polar),
}));
vi.mock("../providers/garmin/provider.ts", () => ({
  GarminProvider: mockProviderConstructor(mockProviders.garmin),
}));
vi.mock("../providers/garmin-dump.ts", () => ({
  GarminDumpProvider: mockProviderConstructor(mockProviders["garmin-dump"]),
}));
vi.mock("../providers/fit-file.ts", () => ({
  FitFileProvider: mockProviderConstructor(mockProviders["fit-file"]),
}));
vi.mock("../providers/strava.ts", () => ({
  StravaProvider: mockProviderConstructor(mockProviders.strava),
}));
vi.mock("../providers/cronometer-csv.ts", () => ({
  CronometerCsvProvider: mockProviderConstructor(mockProviders["cronometer-csv"]),
}));
vi.mock("../providers/oura/provider.ts", () => ({
  OuraProvider: mockProviderConstructor(mockProviders.oura),
}));
vi.mock("../providers/bodyspec.ts", () => ({
  BodySpecProvider: mockProviderConstructor(mockProviders.bodyspec),
}));
vi.mock("../providers/eight-sleep.ts", () => ({
  EightSleepProvider: mockProviderConstructor(mockProviders["eight-sleep"]),
}));
vi.mock("../providers/zwift.ts", () => ({
  ZwiftProvider: mockProviderConstructor(mockProviders.zwift),
}));
vi.mock("../providers/trainerroad.ts", () => ({
  TrainerRoadProvider: mockProviderConstructor(mockProviders.trainerroad),
}));
vi.mock("../providers/ultrahuman.ts", () => ({
  UltrahumanProvider: mockProviderConstructor(mockProviders.ultrahuman),
}));
vi.mock("../providers/concept2.ts", () => ({
  Concept2Provider: mockProviderConstructor(mockProviders.concept2),
}));
vi.mock("../providers/xert.ts", () => ({
  XertProvider: mockProviderConstructor(mockProviders.xert),
}));
vi.mock("../providers/cycling-analytics.ts", () => ({
  CyclingAnalyticsProvider: mockProviderConstructor(mockProviders["cycling-analytics"]),
}));
vi.mock("../providers/wger.ts", () => ({
  WgerProvider: mockProviderConstructor(mockProviders.wger),
}));
vi.mock("../providers/velohero.ts", () => ({
  VeloHeroProvider: mockProviderConstructor(mockProviders.velohero),
}));
vi.mock("../providers/mountain-project.ts", () => ({
  MountainProjectProvider: mockProviderConstructor(mockProviders["mountain-project"]),
}));
vi.mock("../providers/auto-supplements.ts", () => ({
  AutoSupplementsProvider: mockProviderConstructor(mockProviders["auto-supplements"]),
}));
vi.mock("../providers/amazfit-zepp.ts", () => ({
  AmazfitZeppProvider: mockProviderConstructor(mockProviders["amazfit-zepp"]),
}));
vi.mock("../providers/kaya/provider.ts", () => ({
  KayaProvider: mockProviderConstructor(mockProviders["kaya-export"]),
}));
vi.mock("../providers/zos-app/provider.ts", () => ({
  ZosAppProvider: mockProviderConstructor(mockProviders["zos-app"]),
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

  it("registers all production providers", async () => {
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

  it("fails loudly when a provider registration throws", async () => {
    mockRegisterProvider.mockImplementation((provider: { id: string }) => {
      if (provider.id === "peloton") {
        throw new Error("Peloton init failed");
      }
    });

    const { ensureProvidersRegistered } = await import("./provider-registration.ts");
    await expect(ensureProvidersRegistered()).rejects.toThrow(
      "Failed to register peloton provider: Peloton init failed",
    );

    expect(mockRegisterProvider).toHaveBeenCalledTimes(3);
  });
});
