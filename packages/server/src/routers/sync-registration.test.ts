import { afterEach, describe, expect, it, vi } from "vitest";

const mockRegisterProvider = vi.fn();
const mockProviderConstructor = vi.hoisted(
  () => (id: string) =>
    vi.fn(function vitestConstructor() {
      return { id };
    }),
);

vi.mock("dofek/providers/registry", () => ({
  registerProvider: (...args: unknown[]) => mockRegisterProvider(...args),
  getAllProviders: vi.fn(() => []),
  getSyncProviders: vi.fn(() => []),
}));

vi.mock("dofek/jobs/provider-queue-config", () => ({
  getConfiguredProviderIds: vi.fn(() => []),
}));

vi.mock("dofek/jobs/queues", () => ({
  createSyncQueue: vi.fn(() => ({ add: vi.fn(), getJob: vi.fn(), getJobs: vi.fn() })),
  createProviderSyncQueue: vi.fn(() => ({ add: vi.fn(), getJob: vi.fn(), getJobs: vi.fn() })),
  getProviderSyncQueue: vi.fn(() => ({ add: vi.fn(), getJob: vi.fn(), getJobs: vi.fn() })),
  providerSyncQueueName: vi.fn((providerId: string) => providerId),
}));

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{ db: unknown; userId: string | null; timezone: string }>()
    .create();
  return {
    router: trpc.router,
    publicProcedure: trpc.procedure,
    protectedProcedure: trpc.procedure,
    cachedProtectedQuery: () => trpc.procedure,
    CacheTTL: { SHORT: 120_000, MEDIUM: 600_000, LONG: 3_600_000 },
  };
});

vi.mock("dofek/lib/cache", () => ({
  invalidateAllUserQueries: vi.fn(),
  queryCache: {
    invalidateByPrefix: vi.fn(),
    get: vi.fn(),
    set: vi.fn(),
    invalidateAll: vi.fn(),
  },
}));

vi.mock("../lib/typed-sql.ts", () => ({
  executeWithSchema: vi.fn(),
}));

vi.mock("../logger.ts", () => ({
  logger: { warn: vi.fn(), info: vi.fn() },
}));

vi.mock("dofek/providers/provider-model", () => ({
  ProviderModel: class {},
}));

vi.mock("../repositories/sync-repository.ts", () => ({
  SyncRepository: class {},
}));

vi.mock("dofek/providers/wahoo/provider", () => ({
  WahooProvider: mockProviderConstructor("wahoo"),
}));
vi.mock("dofek/providers/withings", () => ({
  WithingsProvider: mockProviderConstructor("withings"),
}));
vi.mock("dofek/providers/peloton", () => ({ PelotonProvider: mockProviderConstructor("peloton") }));
vi.mock("dofek/providers/fatsecret", () => ({
  FatSecretProvider: mockProviderConstructor("fatsecret"),
}));
vi.mock("dofek/providers/whoop", () => ({ WhoopProvider: mockProviderConstructor("whoop") }));
vi.mock("dofek/providers/ride-with-gps", () => ({
  RideWithGpsProvider: mockProviderConstructor("ride-with-gps"),
}));
vi.mock("dofek/providers/strong-csv", () => ({
  StrongCsvProvider: mockProviderConstructor("strong-csv"),
}));
vi.mock("dofek/providers/polar", () => ({ PolarProvider: mockProviderConstructor("polar") }));
vi.mock("dofek/providers/fitbit", () => ({ FitbitProvider: mockProviderConstructor("fitbit") }));
vi.mock("dofek/providers/garmin", () => ({ GarminProvider: mockProviderConstructor("garmin") }));
vi.mock("dofek/providers/garmin-dump", () => ({
  GarminDumpProvider: mockProviderConstructor("garmin-dump"),
}));
vi.mock("dofek/providers/fit-file", () => ({
  FitFileProvider: mockProviderConstructor("fit-file"),
}));
vi.mock("dofek/providers/strava", () => ({ StravaProvider: mockProviderConstructor("strava") }));
vi.mock("dofek/providers/cronometer-csv", () => ({
  CronometerCsvProvider: mockProviderConstructor("cronometer-csv"),
}));
vi.mock("dofek/providers/oura", () => ({ OuraProvider: mockProviderConstructor("oura") }));
vi.mock("dofek/providers/bodyspec", () => ({
  BodySpecProvider: mockProviderConstructor("bodyspec"),
}));
vi.mock("dofek/providers/eight-sleep", () => ({
  EightSleepProvider: mockProviderConstructor("eight-sleep"),
}));
vi.mock("dofek/providers/zwift", () => ({ ZwiftProvider: mockProviderConstructor("zwift") }));
vi.mock("dofek/providers/trainerroad", () => ({
  TrainerRoadProvider: mockProviderConstructor("trainerroad"),
}));
vi.mock("dofek/providers/ultrahuman", () => ({
  UltrahumanProvider: mockProviderConstructor("ultrahuman"),
}));
vi.mock("dofek/providers/amazfit-zepp", () => ({
  AmazfitZeppProvider: mockProviderConstructor("amazfit-zepp"),
}));
vi.mock("dofek/providers/mapmyfitness", () => ({
  MapMyFitnessProvider: mockProviderConstructor("mapmyfitness"),
}));
vi.mock("dofek/providers/suunto", () => ({ SuuntoProvider: mockProviderConstructor("suunto") }));
vi.mock("dofek/providers/coros", () => ({ CorosProvider: mockProviderConstructor("coros") }));
vi.mock("dofek/providers/concept2", () => ({
  Concept2Provider: mockProviderConstructor("concept2"),
}));
vi.mock("dofek/providers/komoot", () => ({ KomootProvider: mockProviderConstructor("komoot") }));
vi.mock("dofek/providers/xert", () => ({ XertProvider: mockProviderConstructor("xert") }));
vi.mock("dofek/providers/cycling-analytics", () => ({
  CyclingAnalyticsProvider: mockProviderConstructor("cycling_analytics"),
}));
vi.mock("dofek/providers/wger", () => ({ WgerProvider: mockProviderConstructor("wger") }));
vi.mock("dofek/providers/decathlon", () => ({
  DecathlonProvider: mockProviderConstructor("decathlon"),
}));
vi.mock("dofek/providers/velohero", () => ({
  VeloHeroProvider: mockProviderConstructor("velohero"),
}));
vi.mock("dofek/providers/auto-supplements", () => ({
  AutoSupplementsProvider: mockProviderConstructor("auto-supplements"),
}));
vi.mock("dofek/providers/kaya/provider", () => ({
  KayaProvider: mockProviderConstructor("kaya-export"),
}));
vi.mock("dofek/providers/zos-app/provider", () => ({
  ZosAppProvider: mockProviderConstructor("zos-app"),
}));

describe("ensureProvidersRegistered failure path", () => {
  afterEach(() => {
    vi.clearAllMocks();
    mockRegisterProvider.mockReset();
    vi.resetModules();
  });

  it("wraps provider registration errors with provider context", async () => {
    mockRegisterProvider.mockImplementation((provider: { id: string }) => {
      if (provider.id === "fatsecret") {
        throw new Error("FATSECRET_CONSUMER_KEY is not set");
      }
    });

    const { ensureProvidersRegistered } = await import("./sync-helpers.ts");

    await expect(ensureProvidersRegistered()).rejects.toThrow(
      "Failed to register fatsecret provider: FATSECRET_CONSUMER_KEY is not set",
    );
  });

  it("registers the Kaya file-import provider", async () => {
    const { ensureProvidersRegistered } = await import("./sync-helpers.ts");

    await ensureProvidersRegistered();

    expect(mockRegisterProvider).toHaveBeenCalledWith({ id: "kaya-export" });
  });

  it("registers self-service providers but omits externally gated providers", async () => {
    const { ensureProvidersRegistered } = await import("./sync-helpers.ts");

    await ensureProvidersRegistered();

    const registeredIds = mockRegisterProvider.mock.calls.map(
      ([provider]: [{ id: string }]) => provider.id,
    );
    expect(registeredIds).toEqual(
      expect.arrayContaining(["bodyspec", "cycling_analytics", "ultrahuman", "wger"]),
    );
    expect(registeredIds).not.toEqual(
      expect.arrayContaining(["fitbit", "suunto", "coros", "komoot", "decathlon", "mapmyfitness"]),
    );
  });
});
