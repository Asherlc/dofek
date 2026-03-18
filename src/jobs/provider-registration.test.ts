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

    expect(mockRegisterProvider).toHaveBeenCalledTimes(14);
  });

  it("only registers once (memoization)", async () => {
    const { ensureProvidersRegistered } = await import("./provider-registration.ts");
    await ensureProvidersRegistered();
    await ensureProvidersRegistered();

    expect(mockRegisterProvider).toHaveBeenCalledTimes(14);
  });

  it("continues registering other providers when one fails", async () => {
    mockRegisterProvider.mockImplementation((provider: { id: string }) => {
      if (provider.id === "peloton") {
        throw new Error("Peloton init failed");
      }
    });

    const { ensureProvidersRegistered } = await import("./provider-registration.ts");
    await ensureProvidersRegistered();

    // Should have attempted all 13 registrations even though peloton failed
    expect(mockRegisterProvider).toHaveBeenCalledTimes(14);
  });
});
