import { afterEach, describe, expect, it, vi } from "vitest";

const mockRegisterProvider = vi.fn();

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
  queryCache: {
    invalidateByPrefix: vi.fn(),
    get: vi.fn(),
    set: vi.fn(),
    invalidateAll: vi.fn(),
  },
}));

vi.mock("../lib/start-worker.ts", () => ({
  startWorker: vi.fn(),
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
  WahooProvider: vi.fn(() => ({ id: "wahoo" })),
}));
vi.mock("dofek/providers/withings", () => ({
  WithingsProvider: vi.fn(() => ({ id: "withings" })),
}));
vi.mock("dofek/providers/peloton", () => ({ PelotonProvider: vi.fn(() => ({ id: "peloton" })) }));
vi.mock("dofek/providers/fatsecret", () => ({
  FatSecretProvider: vi.fn(() => ({ id: "fatsecret" })),
}));
vi.mock("dofek/providers/whoop", () => ({ WhoopProvider: vi.fn(() => ({ id: "whoop" })) }));
vi.mock("dofek/providers/ride-with-gps", () => ({
  RideWithGpsProvider: vi.fn(() => ({ id: "ride-with-gps" })),
}));
vi.mock("dofek/providers/strong-csv", () => ({
  StrongCsvProvider: vi.fn(() => ({ id: "strong-csv" })),
}));
vi.mock("dofek/providers/polar", () => ({ PolarProvider: vi.fn(() => ({ id: "polar" })) }));
vi.mock("dofek/providers/fitbit", () => ({ FitbitProvider: vi.fn(() => ({ id: "fitbit" })) }));
vi.mock("dofek/providers/garmin", () => ({ GarminProvider: vi.fn(() => ({ id: "garmin" })) }));
vi.mock("dofek/providers/strava", () => ({ StravaProvider: vi.fn(() => ({ id: "strava" })) }));
vi.mock("dofek/providers/cronometer-csv", () => ({
  CronometerCsvProvider: vi.fn(() => ({ id: "cronometer-csv" })),
}));
vi.mock("dofek/providers/oura", () => ({ OuraProvider: vi.fn(() => ({ id: "oura" })) }));
vi.mock("dofek/providers/bodyspec", () => ({
  BodySpecProvider: vi.fn(() => ({ id: "bodyspec" })),
}));
vi.mock("dofek/providers/eight-sleep", () => ({
  EightSleepProvider: vi.fn(() => ({ id: "eight-sleep" })),
}));
vi.mock("dofek/providers/zwift", () => ({ ZwiftProvider: vi.fn(() => ({ id: "zwift" })) }));
vi.mock("dofek/providers/trainerroad", () => ({
  TrainerRoadProvider: vi.fn(() => ({ id: "trainerroad" })),
}));
vi.mock("dofek/providers/ultrahuman", () => ({
  UltrahumanProvider: vi.fn(() => ({ id: "ultrahuman" })),
}));
vi.mock("dofek/providers/mapmyfitness", () => ({
  MapMyFitnessProvider: vi.fn(() => ({ id: "mapmyfitness" })),
}));
vi.mock("dofek/providers/suunto", () => ({ SuuntoProvider: vi.fn(() => ({ id: "suunto" })) }));
vi.mock("dofek/providers/coros", () => ({ CorosProvider: vi.fn(() => ({ id: "coros" })) }));
vi.mock("dofek/providers/concept2", () => ({
  Concept2Provider: vi.fn(() => ({ id: "concept2" })),
}));
vi.mock("dofek/providers/komoot", () => ({ KomootProvider: vi.fn(() => ({ id: "komoot" })) }));
vi.mock("dofek/providers/xert", () => ({ XertProvider: vi.fn(() => ({ id: "xert" })) }));
vi.mock("dofek/providers/cycling-analytics", () => ({
  CyclingAnalyticsProvider: vi.fn(() => ({ id: "cycling-analytics" })),
}));
vi.mock("dofek/providers/wger", () => ({ WgerProvider: vi.fn(() => ({ id: "wger" })) }));
vi.mock("dofek/providers/decathlon", () => ({
  DecathlonProvider: vi.fn(() => ({ id: "decathlon" })),
}));
vi.mock("dofek/providers/velohero", () => ({
  VeloHeroProvider: vi.fn(() => ({ id: "velohero" })),
}));
vi.mock("dofek/providers/auto-supplements", () => ({
  AutoSupplementsProvider: vi.fn(() => ({ id: "auto-supplements" })),
}));

describe("ensureProvidersRegistered failure path", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("wraps provider registration errors with provider context", async () => {
    mockRegisterProvider.mockImplementation((provider: { id: string }) => {
      if (provider.id === "fatsecret") {
        throw new Error("FATSECRET_CONSUMER_KEY is not set");
      }
    });

    const { ensureProvidersRegistered } = await import("./sync.ts");

    await expect(ensureProvidersRegistered()).rejects.toThrow(
      "Failed to register fatsecret provider: FATSECRET_CONSUMER_KEY is not set",
    );
  });
});
