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

vi.mock("../providers/wahoo/provider.ts", () => ({
  WahooProvider: vi.fn(() => mockProviders.wahoo),
}));
vi.mock("../providers/withings.ts", () => ({
  WithingsProvider: vi.fn(() => mockProviders.withings),
}));
vi.mock("../providers/peloton.ts", () => ({
  PelotonProvider: vi.fn(() => mockProviders.peloton),
}));
vi.mock("../providers/fatsecret/provider.ts", () => ({
  FatSecretProvider: vi.fn(() => mockProviders.fatsecret),
}));
vi.mock("../providers/whoop/provider.ts", () => ({
  WhoopProvider: vi.fn(() => mockProviders.whoop),
}));
vi.mock("../providers/ride-with-gps.ts", () => ({
  RideWithGpsProvider: vi.fn(() => mockProviders["ride-with-gps"]),
}));
vi.mock("../providers/strong-csv.ts", () => ({
  StrongCsvProvider: vi.fn(() => mockProviders["strong-csv"]),
}));
vi.mock("../providers/polar/provider.ts", () => ({
  PolarProvider: vi.fn(() => mockProviders.polar),
}));
vi.mock("../providers/garmin/provider.ts", () => ({
  GarminProvider: vi.fn(() => mockProviders.garmin),
}));
vi.mock("../providers/garmin-dump.ts", () => ({
  GarminDumpProvider: vi.fn(() => mockProviders["garmin-dump"]),
}));
vi.mock("../providers/fit-file.ts", () => ({
  FitFileProvider: vi.fn(() => mockProviders["fit-file"]),
}));
vi.mock("../providers/strava.ts", () => ({
  StravaProvider: vi.fn(() => mockProviders.strava),
}));
vi.mock("../providers/cronometer-csv.ts", () => ({
  CronometerCsvProvider: vi.fn(() => mockProviders["cronometer-csv"]),
}));
vi.mock("../providers/oura/provider.ts", () => ({
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
vi.mock("../providers/concept2.ts", () => ({
  Concept2Provider: vi.fn(() => mockProviders.concept2),
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
vi.mock("../providers/velohero.ts", () => ({
  VeloHeroProvider: vi.fn(() => mockProviders.velohero),
}));
vi.mock("../providers/mountain-project.ts", () => ({
  MountainProjectProvider: vi.fn(() => mockProviders["mountain-project"]),
}));
vi.mock("../providers/auto-supplements.ts", () => ({
  AutoSupplementsProvider: vi.fn(() => mockProviders["auto-supplements"]),
}));
vi.mock("../providers/amazfit-zepp.ts", () => ({
  AmazfitZeppProvider: vi.fn(() => mockProviders["amazfit-zepp"]),
}));
vi.mock("../providers/kaya/provider.ts", () => ({
  KayaProvider: vi.fn(() => mockProviders["kaya-export"]),
}));
vi.mock("../providers/zos-app/provider.ts", () => ({
  ZosAppProvider: vi.fn(() => mockProviders["zos-app"]),
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
