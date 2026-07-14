import { beforeEach, describe, expect, it, vi } from "vitest";
import { collectSqlText, createTestCallerFactory } from "./test-helpers.ts";

const {
  mockAdd,
  mockGetJob,
  mockGetJobs,
  mockGetJobCounts,
  mockGetProviderSyncQueue,
  mockImportQueueGetJobs,
  mockImportQueueGetJobCounts,
  mockGetAllProviders,
  mockGetSyncProviders,
  mockRegisterProvider,
  mockLoggerWarn,
  mockCaptureException,
  mockInvalidateByPrefix,
  mockVeloHeroProvider,
  mockStartWorker,
  mockCachedProtectedQuery,
  mockProtectedQueryCache,
} = vi.hoisted(() => ({
  mockAdd: vi.fn().mockResolvedValue({ id: "job-123" }),
  mockGetJob: vi.fn(),
  mockGetJobs: vi.fn().mockResolvedValue([]),
  mockGetJobCounts: vi.fn(),
  mockGetProviderSyncQueue: vi.fn((id: string) => ({
    add: mockAdd,
    getJob: mockGetJob,
    getJobs: mockGetJobs,
    getJobCounts: (...states: string[]) => mockGetJobCounts(id, states),
  })),
  mockImportQueueGetJobs: vi.fn().mockResolvedValue([]),
  mockImportQueueGetJobCounts: vi.fn(),
  mockGetAllProviders: vi.fn(() => []),
  mockGetSyncProviders: vi.fn(() => []),
  mockRegisterProvider: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockCaptureException: vi.fn(),
  mockInvalidateByPrefix: vi.fn().mockResolvedValue(undefined),
  mockVeloHeroProvider: vi.fn(() => ({ id: "velohero" })),
  mockStartWorker: vi.fn(),
  mockCachedProtectedQuery: vi.fn(),
  mockProtectedQueryCache: new Map<string, { data: unknown; expiresAt: number }>(),
}));

// Mock trpc
type MockAdminDb = {
  execute: (query: unknown) => Promise<Array<{ is_admin: boolean }>>;
};

interface MockCachePolicy {
  maxAge: number;
}

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const { TRPCError } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{ db: MockAdminDb; sensorStore?: unknown; userId: string | null; timezone: string }>()
    .create();
  const adminProcedure = trpc.procedure.use(async ({ ctx, next }) => {
    if (!ctx.userId) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: "Not authenticated" });
    }
    const rows = await ctx.db.execute({ type: "admin-check" });
    if (rows[0]?.is_admin !== true) {
      throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
    }
    return next({ ctx });
  });
  mockCachedProtectedQuery.mockImplementation((policy: MockCachePolicy) =>
    trpc.procedure.use(async ({ ctx, path, getRawInput, next }) => {
      const rawInput = await getRawInput();
      const key = `${ctx.userId ?? "anon"}:${path}:${JSON.stringify(rawInput)}`;
      const hit = mockProtectedQueryCache.get(key);
      if (hit && hit.expiresAt > Date.now()) {
        return { ok: true as const, data: hit.data };
      }

      const result = await next();
      if (result.ok) {
        mockProtectedQueryCache.set(key, {
          data: result.data,
          expiresAt: Date.now() + policy.maxAge,
        });
      }
      return result;
    }),
  );
  return {
    router: trpc.router,
    publicProcedure: trpc.procedure,
    protectedProcedure: trpc.procedure,
    adminProcedure,
    cachedProtectedQuery: mockCachedProtectedQuery,
    CacheTTL: { SHORT: 120_000, MEDIUM: 600_000, LONG: 3_600_000 },
  };
});

vi.mock("dofek/jobs/provider-queue-config", () => ({
  getConfiguredProviderIds: vi.fn(() => ["strava", "garmin", "whoop"]),
}));

vi.mock("dofek/jobs/queues", () => ({
  SYNC_JOB_RETRY_OPTIONS: {
    attempts: 288,
    backoff: { type: "fixed", delay: 300_000 },
    removeOnComplete: { age: 86_400, count: 1_000 },
    removeOnFail: { age: 604_800, count: 1_000 },
  },
  IMPORT_QUEUE: "import",
  createSyncQueue: vi.fn(() => ({
    add: mockAdd,
    getJob: mockGetJob,
    getJobs: mockGetJobs,
  })),
  getImportQueue: vi.fn(() => ({
    getJobs: mockImportQueueGetJobs,
    getJobCounts: mockImportQueueGetJobCounts,
  })),
  createProviderSyncQueue: vi.fn(() => ({
    add: mockAdd,
    getJob: mockGetJob,
    getJobs: mockGetJobs,
    getJobCounts: (...states: string[]) => mockGetJobCounts("created-provider", states),
  })),
  getProviderSyncQueue: mockGetProviderSyncQueue,
  providerSyncQueueName: vi.fn((id: string) => `sync-${id}`),
}));

vi.mock("dofek/providers/registry", () => ({
  getAllProviders: mockGetAllProviders,
  getSyncProviders: mockGetSyncProviders,
  registerProvider: mockRegisterProvider,
}));

vi.mock("dofek/providers/types", () => ({
  isSyncProvider: (p: { importOnly?: boolean }) => p.importOnly !== true,
}));

vi.mock("../lib/start-worker.ts", () => ({
  startWorker: mockStartWorker,
}));

vi.mock("dofek/lib/cache", () => ({
  queryCache: {
    invalidateByPrefix: mockInvalidateByPrefix,
    get: vi.fn().mockResolvedValue(undefined),
    set: vi.fn().mockResolvedValue(undefined),
    invalidateAll: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("../lib/typed-sql.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/typed-sql.ts")>()),
  executeWithSchema: vi.fn(
    async (db: { execute: (q: unknown) => Promise<unknown[]> }, _schema: unknown, query: unknown) =>
      db.execute(query),
  ),
}));

vi.mock("../logger.ts", () => ({
  logger: { warn: mockLoggerWarn, info: vi.fn() },
}));

vi.mock("@sentry/node", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

// Mock the dynamic provider imports used in doRegisterProviders
vi.mock("dofek/providers/wahoo/provider", () => ({ WahooProvider: vi.fn() }));
vi.mock("dofek/providers/withings", () => ({ WithingsProvider: vi.fn() }));
vi.mock("dofek/providers/peloton", () => ({ PelotonProvider: vi.fn() }));
vi.mock("dofek/providers/fatsecret", () => ({ FatSecretProvider: vi.fn() }));
vi.mock("dofek/providers/whoop", () => ({ WhoopProvider: vi.fn() }));
vi.mock("dofek/providers/ride-with-gps", () => ({ RideWithGpsProvider: vi.fn() }));
vi.mock("dofek/providers/strong-csv", () => ({ StrongCsvProvider: vi.fn() }));
vi.mock("dofek/providers/polar", () => ({ PolarProvider: vi.fn() }));
vi.mock("dofek/providers/fitbit", () => ({ FitbitProvider: vi.fn() }));
vi.mock("dofek/providers/garmin", () => ({ GarminProvider: vi.fn() }));
vi.mock("dofek/providers/garmin-dump", () => ({ GarminDumpProvider: vi.fn() }));
vi.mock("dofek/providers/strava", () => ({ StravaProvider: vi.fn() }));
vi.mock("dofek/providers/cronometer-csv", () => ({ CronometerCsvProvider: vi.fn() }));
vi.mock("dofek/providers/oura", () => ({ OuraProvider: vi.fn() }));
vi.mock("dofek/providers/eight-sleep", () => ({ EightSleepProvider: vi.fn() }));
vi.mock("dofek/providers/zwift", () => ({ ZwiftProvider: vi.fn() }));
vi.mock("dofek/providers/trainerroad", () => ({ TrainerRoadProvider: vi.fn() }));
vi.mock("dofek/providers/ultrahuman", () => ({ UltrahumanProvider: vi.fn() }));
vi.mock("dofek/providers/mapmyfitness", () => ({ MapMyFitnessProvider: vi.fn() }));
vi.mock("dofek/providers/suunto", () => ({ SuuntoProvider: vi.fn() }));
vi.mock("dofek/providers/coros", () => ({ CorosProvider: vi.fn() }));
vi.mock("dofek/providers/concept2", () => ({ Concept2Provider: vi.fn() }));
vi.mock("dofek/providers/komoot", () => ({ KomootProvider: vi.fn() }));
vi.mock("dofek/providers/xert", () => ({ XertProvider: vi.fn() }));
vi.mock("dofek/providers/cycling-analytics", () => ({ CyclingAnalyticsProvider: vi.fn() }));
vi.mock("dofek/providers/wger", () => ({ WgerProvider: vi.fn() }));
vi.mock("dofek/providers/decathlon", () => ({ DecathlonProvider: vi.fn() }));
vi.mock("dofek/providers/velohero", () => ({
  VeloHeroProvider: mockVeloHeroProvider,
}));

// Mock schema and drizzle-orm for logs query
vi.mock("dofek/db/schema/events", () => ({
  syncLog: {
    userId: "userId",
    syncedAt: "syncedAt",
  },
}));

import * as enqueueSyncJobModule from "dofek/jobs/enqueue-sync-job";
import { SyncRepository } from "../repositories/sync-repository.ts";
import {
  logsInput,
  sanitizeErrorMessage,
  syncRouter,
  syncStatusInput,
  triggerSyncInput,
} from "./sync.ts";
import { ensureProvidersRegistered, parseJobId, toJobId } from "./sync-helpers.ts";

const routerConstructionCachedTtlValues = mockCachedProtectedQuery.mock.calls.map(
  (call) => call[0],
);

function createProvidersDbMock() {
  return {
    execute: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]),
  };
}

function createSensorStoreQuery(responses: { providerStats?: Record<string, unknown>[] | Error }) {
  return vi.fn(async (_schema: unknown, sql: string) => {
    if (sql.includes("provider_stats")) {
      if (responses.providerStats instanceof Error) throw responses.providerStats;
      return responses.providerStats ?? [];
    }
    return [];
  });
}

describe("syncRouter", () => {
  const createCaller = createTestCallerFactory(syncRouter);

  it("uses a short cache for read-heavy protected queries", () => {
    expect(routerConstructionCachedTtlValues).toEqual([
      { maxAge: 120_000 },
      { maxAge: 120_000 },
      { maxAge: 120_000 },
      { maxAge: 120_000 },
    ]);
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockProtectedQueryCache.clear();
    mockGetAllProviders.mockReturnValue([]);
    mockRegisterProvider.mockImplementation(() => undefined);
    mockVeloHeroProvider.mockImplementation(() => ({ id: "velohero" }));
    mockGetProviderSyncQueue.mockImplementation((id: string) => ({
      add: mockAdd,
      getJob: mockGetJob,
      getJobs: mockGetJobs,
      getJobCounts: (...states: string[]) => mockGetJobCounts(id, states),
    }));
    mockGetJobs.mockResolvedValue([]);
    mockImportQueueGetJobs.mockResolvedValue([]);
    mockImportQueueGetJobCounts.mockResolvedValue({
      waiting: 0,
      active: 0,
      delayed: 0,
      failed: 0,
    });
  });

  describe("ensureProvidersRegistered", () => {
    it("registers providers once and returns the same promise on subsequent calls", async () => {
      const first = ensureProvidersRegistered();
      expect(first).toBeInstanceOf(Promise);

      // Second call should return the cached promise (not create a new one)
      const second = ensureProvidersRegistered();
      expect(second).toBe(first);

      await first;
      expect(mockRegisterProvider).toHaveBeenCalled();
      expect(mockRegisterProvider.mock.calls.length).toBeGreaterThanOrEqual(12);
    });
  });

  describe("usableProviders", () => {
    it("returns only configured providers with a connection or import flow", async () => {
      mockGetAllProviders.mockReturnValue([
        {
          id: "strava",
          name: "Strava",
          validate: () => null,
          authSetup: () => ({ oauthConfig: { authUrl: "https://example.com" } }),
        },
        {
          id: "broken",
          name: "Broken",
          validate: () => "Missing credentials",
          authSetup: () => ({ oauthConfig: { authUrl: "https://example.com" } }),
        },
        {
          id: "no-flow",
          name: "No Flow",
          validate: () => null,
        },
        {
          id: "strong-csv",
          name: "Strong CSV",
          validate: () => null,
          importOnly: true,
        },
      ]);

      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: null,
        timezone: "UTC",
      });

      const result = await caller.usableProviders();
      expect(result.map((provider: { id: string }) => provider.id)).toEqual([
        "apple_health",
        "strava",
        "strong-csv",
      ]);
    });
  });

  describe("providers", () => {
    it("returns provider list with enabled/auth status", async () => {
      mockGetAllProviders.mockReturnValue([
        {
          id: "wahoo",
          name: "Wahoo",
          validate: () => null,
          authSetup: () => ({ oauthConfig: { authUrl: "https://example.com" } }),
        },
        {
          id: "peloton",
          name: "Peloton",
          validate: () => "Missing credentials",
          authSetup: undefined,
        },
        {
          id: "whoop",
          name: "WHOOP",
          validate: () => null,
          authSetup: () => undefined,
        },
        {
          id: "strong-csv",
          name: "Strong CSV",
          validate: () => null,
          importOnly: true,
        },
        {
          id: "cronometer-csv",
          name: "Cronometer CSV",
          validate: () => null,
          importOnly: true,
        },
      ]);

      const caller = createCaller({
        db: {
          execute: vi
            .fn()
            // First call: oauth tokens
            .mockResolvedValueOnce([{ provider_id: "wahoo" }])
            // Second call: last syncs
            .mockResolvedValueOnce([{ provider_id: "wahoo", last_synced: "2024-01-01" }])
            // Third call: latest errors (none)
            .mockResolvedValueOnce([]),
        },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.providers();

      // Peloton is filtered out because its validate() fails
      expect(result).toHaveLength(6);
      expect(result.find((p: { id: string }) => p.id === "peloton")).toBeUndefined();

      const bleHeartRate = result.find((p: { id: string }) => p.id === "ble_heart_rate");
      expect(bleHeartRate?.authType).toBe("push:mobile");
      expect(bleHeartRate?.pushOnly).toBe(true);
      expect(bleHeartRate?.name).toBe("Heart Rate Monitor (Bluetooth)");

      const whoopBle = result.find((p: { id: string }) => p.id === "whoop_ble");
      expect(whoopBle?.authType).toBe("push:mobile");
      expect(whoopBle?.pushOnly).toBe(true);
      expect(whoopBle?.importOnly).toBe(false);
      expect(whoopBle?.needsReauth).toBe(false);
      expect(whoopBle?.authorized).toBe(false);
      expect(whoopBle?.name).toBe("WHOOP (Bluetooth)");
      expect(whoopBle?.description).toBe(
        "Synced from the iOS app when your WHOOP strap is nearby.",
      );

      // Wahoo: OAuth provider, authorized (has token)
      const wahoo = result.find((p: { id: string }) => p.id === "wahoo");
      expect(wahoo?.authType).toBe("oauth");
      expect(wahoo?.authorized).toBe(true);
      expect(wahoo?.lastSyncedAt).toBe("2024-01-01");
      expect(wahoo?.importOnly).toBe(false);
      expect(wahoo?.pushOnly).toBe(false);
      expect(wahoo?.needsReauth).toBe(false);

      // WHOOP: custom auth, not authorized (no token)
      const whoop = result.find((p: { id: string }) => p.id === "whoop");
      expect(whoop?.authType).toBe("custom:whoop");
      expect(whoop?.authorized).toBe(false);
      expect(whoop?.needsReauth).toBe(false);

      // Strong CSV: import only
      const strongCsv = result.find((p: { id: string }) => p.id === "strong-csv");
      expect(strongCsv?.importOnly).toBe(true);

      // Cronometer CSV: import only
      const cronometerCsv = result.find((p: { id: string }) => p.id === "cronometer-csv");
      expect(cronometerCsv?.importOnly).toBe(true);
    });

    it("returns needsReauth=true when latest sync has auth error", async () => {
      mockGetAllProviders.mockReturnValue([
        {
          id: "polar",
          name: "Polar",
          validate: () => null,
          authSetup: () => ({ oauthConfig: { authUrl: "https://flow.polar.com" } }),
        },
        {
          id: "wahoo",
          name: "Wahoo",
          validate: () => null,
          authSetup: () => ({ oauthConfig: { authUrl: "https://api.wahoo.com" } }),
        },
      ]);

      const caller = createCaller({
        db: {
          execute: vi
            .fn()
            // oauth tokens — both have tokens
            .mockResolvedValueOnce([{ provider_id: "polar" }, { provider_id: "wahoo" }])
            // last syncs
            .mockResolvedValueOnce([
              { provider_id: "polar", last_synced: "2024-01-01" },
              { provider_id: "wahoo", last_synced: "2024-01-01" },
            ])
            // latest errors — polar has an auth error, wahoo has a non-auth error
            .mockResolvedValueOnce([
              {
                provider_id: "polar",
                error_message: "Polar authorization failed while syncing exercises",
                auth_failure_reason: "authorization_failed",
                synced_at: new Date("2026-06-02T10:00:00Z"),
              },
              {
                provider_id: "wahoo",
                error_message: "Network timeout after 30s",
                auth_failure_reason: null,
                synced_at: new Date("2026-06-02T10:00:00Z"),
              },
            ]),
        },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.providers();

      const polar = result.find((p: { id: string }) => p.id === "polar");
      expect(polar?.authorized).toBe(true);
      expect(polar?.needsReauth).toBe(true);

      const wahoo = result.find((p: { id: string }) => p.id === "wahoo");
      expect(wahoo?.authorized).toBe(true);
      expect(wahoo?.needsReauth).toBe(false);
    });

    it("returns needsReauth=true for a reconnect auth error after tokens are deleted", async () => {
      mockGetAllProviders.mockReturnValue([
        {
          id: "withings",
          name: "Withings",
          validate: () => null,
          authSetup: () => ({ oauthConfig: { authUrl: "https://account.withings.com" } }),
        },
      ]);

      const caller = createCaller({
        db: {
          execute: vi
            .fn()
            // no oauth tokens after stale refresh-token cleanup
            .mockResolvedValueOnce([])
            // last syncs
            .mockResolvedValueOnce([{ provider_id: "withings", last_synced: "2026-06-02" }])
            // latest errors
            .mockResolvedValueOnce([
              {
                provider_id: "withings",
                error_message:
                  "Withings authorization revoked — re-connect the provider to resume syncing.",
                auth_failure_reason: "refresh_token_revoked",
                synced_at: new Date("2026-06-02T10:00:00Z"),
              },
            ]),
        },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.providers();

      const withings = result.find((provider: { id: string }) => provider.id === "withings");
      expect(withings?.authorized).toBe(false);
      expect(withings?.needsReauth).toBe(true);
    });

    it("clears needsReauth when tokens were updated after the latest auth error", async () => {
      mockGetAllProviders.mockReturnValue([
        {
          id: "peloton",
          name: "Peloton",
          validate: () => null,
          authSetup: () => ({
            oauthConfig: { authUrl: "https://auth.onepeloton.com" },
            automatedLogin: async () => ({}),
          }),
        },
      ]);

      const caller = createCaller({
        db: {
          execute: vi
            .fn()
            // oauth tokens saved after reconnect
            .mockResolvedValueOnce([
              { provider_id: "peloton", updated_at: new Date("2026-06-02T10:05:00Z") },
            ])
            // last syncs
            .mockResolvedValueOnce([{ provider_id: "peloton", last_synced: "2026-06-02" }])
            // latest error happened before reconnect
            .mockResolvedValueOnce([
              {
                provider_id: "peloton",
                error_message:
                  "Peloton authorization revoked — re-connect the provider to resume syncing.",
                auth_failure_reason: "refresh_token_revoked",
                synced_at: new Date("2026-06-02T10:00:00Z"),
              },
            ]),
        },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.providers();

      const peloton = result.find((provider: { id: string }) => provider.id === "peloton");
      expect(peloton?.authorized).toBe(true);
      expect(peloton?.needsReauth).toBe(false);
    });

    it("marks push provider authorized when metric stream data exists", async () => {
      mockGetAllProviders.mockReturnValue([]);

      const caller = createCaller({
        db: createProvidersDbMock(),
        sensorStore: {
          query: createSensorStoreQuery({
            providerStats: [
              {
                provider_id: "whoop_ble",
                activities: 0,
                daily_metrics: 0,
                sleep_sessions: 0,
                body_measurements: 0,
                food_entries: 0,
                health_events: 0,
                metric_stream: 4,
                nutrition_daily: 0,
                lab_panels: 0,
                lab_results: 0,
                journal_entries: 0,
              },
            ],
          }),
        },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.providers();
      const whoopBle = result.find((provider: { id: string }) => provider.id === "whoop_ble");
      expect(whoopBle?.authorized).toBe(true);
      expect(whoopBle?.lastSyncedAt).toBeNull();
    });

    it("logs and continues when provider stats lookup fails", async () => {
      mockGetAllProviders.mockReturnValue([]);

      const caller = createCaller({
        db: createProvidersDbMock(),
        sensorStore: {
          query: createSensorStoreQuery({
            providerStats: new Error("ClickHouse provider stats unavailable"),
          }),
        },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.providers();

      expect(mockLoggerWarn).toHaveBeenCalledWith(
        "[sync.providers] provider stats lookup failed: ClickHouse provider stats unavailable",
      );
      expect(mockCaptureException).toHaveBeenCalledWith(
        expect.objectContaining({ message: "ClickHouse provider stats unavailable" }),
      );
      expect(
        result.find((provider: { id: string }) => provider.id === "whoop_ble")?.authorized,
      ).toBe(false);
    });

    it("logs non-Error provider stats failures with String(error)", async () => {
      mockGetAllProviders.mockReturnValue([]);

      const caller = createCaller({
        db: createProvidersDbMock(),
        sensorStore: {
          query: vi.fn(async (_schema, sql: string) => {
            if (sql.includes("provider_stats")) {
              throw "string stats failure";
            }
            return [];
          }),
        },
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.providers();

      expect(mockLoggerWarn).toHaveBeenCalledWith(
        "[sync.providers] provider stats lookup failed: string stats failure",
      );
      expect(mockCaptureException).toHaveBeenCalledWith("string stats failure");
    });

    it("skips ClickHouse provider stats when sensor store is not configured", async () => {
      mockGetAllProviders.mockReturnValue([]);
      const getProviderStats = vi.spyOn(SyncRepository.prototype, "getProviderStats");

      const caller = createCaller({
        db: createProvidersDbMock(),
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.providers();
      expect(getProviderStats).not.toHaveBeenCalled();
      getProviderStats.mockRestore();
    });

    it("handles authSetup throwing", async () => {
      mockGetAllProviders.mockReturnValue([
        {
          id: "broken",
          name: "Broken",
          validate: () => null,
          authSetup: () => {
            throw new Error("no credentials");
          },
        },
      ]);

      const caller = createCaller({
        db: {
          execute: vi.fn().mockResolvedValue([]),
        },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.providers();
      expect(result).toHaveLength(3);
      expect(result[0]?.authType).toBe("none");
      expect(result[1]?.id).toBe("whoop_ble");
      expect(result[2]?.id).toBe("ble_heart_rate");
    });
  });

  describe("triggerSync", () => {
    it("enqueues one sync job per configured provider when providerId is omitted", async () => {
      mockGetAllProviders.mockReturnValue([
        { id: "strava", name: "Strava", validate: () => null },
        { id: "wahoo", name: "Wahoo", validate: () => null },
        { id: "peloton", name: "Peloton", validate: () => "Missing credentials" },
      ]);
      mockAdd
        .mockResolvedValueOnce({ id: "job-strava" })
        .mockResolvedValueOnce({ id: "job-wahoo" });

      const caller = createCaller({
        db: {
          execute: vi
            .fn()
            // tokens query — no auth needed for these providers (no authSetup)
            .mockResolvedValueOnce([]),
        },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.triggerSync({});
      expect(result.jobId).toBe("strava:job-strava");
      expect(result.jobIds).toEqual(["strava:job-strava", "wahoo:job-wahoo"]);
      expect(result.providerJobs).toEqual([
        { providerId: "strava", jobId: "strava:job-strava", queueName: "sync-strava" },
        { providerId: "wahoo", jobId: "wahoo:job-wahoo", queueName: "sync-wahoo" },
      ]);
      expect(mockAdd).toHaveBeenNthCalledWith(
        1,
        "sync",
        expect.objectContaining({
          providerId: "strava",
          sinceDays: undefined,
          sinceIso: "1970-01-01T00:00:00.000Z",
          targetRefreshWindow: { type: "full" },
          userId: "user-1",
        }),
        expect.objectContaining({ attempts: 288 }),
      );
      expect(mockAdd).toHaveBeenNthCalledWith(
        2,
        "sync",
        expect.objectContaining({
          providerId: "wahoo",
          sinceDays: undefined,
          sinceIso: "1970-01-01T00:00:00.000Z",
          targetRefreshWindow: { type: "full" },
          userId: "user-1",
        }),
        expect.objectContaining({ attempts: 288 }),
      );
    });

    it("returns per-provider outcomes when one sync-all provider is rate limited", async () => {
      mockGetAllProviders.mockReturnValue([
        {
          id: "garmin",
          name: "Garmin",
          validate: () => null,
          authSetup: () => ({ oauthConfig: { authUrl: "https://example.com" } }),
        },
        {
          id: "wahoo",
          name: "Wahoo",
          validate: () => null,
          authSetup: () => ({ oauthConfig: { authUrl: "https://example.com" } }),
        },
      ]);
      const enqueueSpy = vi
        .spyOn(enqueueSyncJobModule, "enqueueSyncJob")
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(Object.assign({ id: "job-wahoo" }, { alreadyQueued: false }));

      const caller = createCaller({
        db: {
          execute: vi
            .fn()
            .mockResolvedValueOnce([{ provider_id: "garmin" }, { provider_id: "wahoo" }]),
        },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.triggerSync({ sinceDays: 1 });
      enqueueSpy.mockRestore();

      expect(result.providerResults).toEqual([
        {
          providerId: "garmin",
          status: "skippedCooldown",
          message: "Provider sync skipped: rate-limit cooldown active",
        },
        {
          providerId: "wahoo",
          status: "started",
          jobId: "wahoo:job-wahoo",
          queueName: "sync-wahoo",
        },
      ]);
      expect(result.providerJobs).toEqual([
        { providerId: "wahoo", jobId: "wahoo:job-wahoo", queueName: "sync-wahoo" },
      ]);
      expect(result.jobIds).toEqual(["wahoo:job-wahoo"]);
    });

    it("returns skippedCooldown for a single provider instead of throwing rate limit errors", async () => {
      mockGetAllProviders.mockReturnValue([{ id: "garmin", name: "Garmin", validate: () => null }]);
      const enqueueSpy = vi
        .spyOn(enqueueSyncJobModule, "enqueueSyncJob")
        .mockResolvedValueOnce(null);

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.triggerSync({ providerId: "garmin" });
      enqueueSpy.mockRestore();

      expect(result.providerResults).toEqual([
        {
          providerId: "garmin",
          status: "skippedCooldown",
          message: "Provider sync skipped: rate-limit cooldown active",
        },
      ]);
      expect(result.providerJobs).toEqual([]);
      expect(result.jobIds).toEqual([]);
      expect(mockStartWorker).not.toHaveBeenCalled();
    });

    it("reports an already queued provider without failing sync all", async () => {
      mockGetAllProviders.mockReturnValue([
        {
          id: "whoop",
          name: "WHOOP",
          validate: () => null,
          authSetup: () => ({ oauthConfig: { authUrl: "https://example.com" } }),
        },
      ]);
      mockGetJob.mockResolvedValueOnce({
        id: "job-whoop",
        getState: vi.fn().mockResolvedValue("waiting"),
        remove: vi.fn(),
      });

      const caller = createCaller({
        db: {
          execute: vi.fn().mockResolvedValueOnce([{ provider_id: "whoop" }]),
        },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.triggerSync({ sinceDays: 1 });

      expect(result.providerResults).toEqual([
        {
          providerId: "whoop",
          status: "alreadyQueued",
          jobId: "whoop:job-whoop",
          queueName: "sync-whoop",
        },
      ]);
      expect(result.providerJobs).toEqual([
        { providerId: "whoop", jobId: "whoop:job-whoop", queueName: "sync-whoop" },
      ]);
      expect(result.jobIds).toEqual(["whoop:job-whoop"]);
      expect(mockAdd).not.toHaveBeenCalled();
    });

    it("reports a failed provider without hiding successful providers", async () => {
      mockGetAllProviders.mockReturnValue([
        {
          id: "polar",
          name: "Polar",
          validate: () => null,
          authSetup: () => ({ oauthConfig: { authUrl: "https://example.com" } }),
        },
        {
          id: "wahoo",
          name: "Wahoo",
          validate: () => null,
          authSetup: () => ({ oauthConfig: { authUrl: "https://example.com" } }),
        },
      ]);
      const enqueueSpy = vi
        .spyOn(enqueueSyncJobModule, "enqueueSyncJob")
        .mockRejectedValueOnce(new Error("provider queue unavailable"))
        .mockResolvedValueOnce(Object.assign({ id: "job-wahoo" }, { alreadyQueued: false }));

      const caller = createCaller({
        db: {
          execute: vi
            .fn()
            .mockResolvedValueOnce([{ provider_id: "polar" }, { provider_id: "wahoo" }]),
        },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.triggerSync({ sinceDays: 1 });
      enqueueSpy.mockRestore();

      expect(result.providerResults).toEqual([
        {
          providerId: "polar",
          status: "failed",
          message: "provider queue unavailable",
        },
        {
          providerId: "wahoo",
          status: "started",
          jobId: "wahoo:job-wahoo",
          queueName: "sync-wahoo",
        },
      ]);
      expect(result.providerJobs).toEqual([
        { providerId: "wahoo", jobId: "wahoo:job-wahoo", queueName: "sync-wahoo" },
      ]);
      expect(result.jobIds).toEqual(["wahoo:job-wahoo"]);
      expect(mockCaptureException).toHaveBeenCalledWith(
        expect.objectContaining({ message: "provider queue unavailable" }),
      );
    });

    it("excludes unconnected providers from sync-all fan-out", async () => {
      mockGetAllProviders.mockReturnValue([
        {
          id: "strava",
          name: "Strava",
          validate: () => null,
          authSetup: () => ({ oauthConfig: { authUrl: "https://example.com" } }),
        },
        {
          id: "wahoo",
          name: "Wahoo",
          validate: () => null,
          authSetup: () => ({ oauthConfig: { authUrl: "https://example.com" } }),
        },
        {
          id: "whoop",
          name: "WHOOP",
          validate: () => null,
        },
        {
          id: "intervals",
          name: "Intervals.icu",
          validate: () => null,
        },
      ]);
      // Only strava has tokens
      mockAdd
        .mockResolvedValueOnce({ id: "job-strava" })
        .mockResolvedValueOnce({ id: "job-intervals" });

      const caller = createCaller({
        db: {
          execute: vi
            .fn()
            // tokens query — only strava has tokens
            .mockResolvedValueOnce([{ provider_id: "strava" }]),
        },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.triggerSync({});
      // wahoo has authSetup but no token — excluded
      // whoop has no token — excluded when custom auth overrides mark it as needing auth
      // strava has authSetup and has token — included
      // intervals has no authSetup — included (no auth needed)
      expect(result.providerJobs).toEqual([
        { providerId: "strava", jobId: "strava:job-strava", queueName: "sync-strava" },
        { providerId: "intervals", jobId: "intervals:job-intervals", queueName: "sync-intervals" },
      ]);
      expect(mockAdd).toHaveBeenCalledTimes(2);
    });

    it("excludes import-only providers from sync-all fan-out", async () => {
      mockGetAllProviders.mockReturnValue([
        { id: "strava", name: "Strava", validate: () => null },
        { id: "strong-csv", name: "Strong CSV", validate: () => null, importOnly: true },
      ]);
      mockAdd.mockResolvedValueOnce({ id: "job-strava" });

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValueOnce([]) },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.triggerSync({});
      expect(result.providerJobs).toEqual([
        { providerId: "strava", jobId: "strava:job-strava", queueName: "sync-strava" },
      ]);
      expect(mockAdd).toHaveBeenCalledTimes(1);
      expect(mockAdd).toHaveBeenCalledWith(
        "sync",
        expect.objectContaining({
          providerId: "strava",
          sinceDays: undefined,
          sinceIso: "1970-01-01T00:00:00.000Z",
          targetRefreshWindow: { type: "full" },
          userId: "user-1",
        }),
        expect.objectContaining({ attempts: 288 }),
      );
    });

    it("validates provider exists before enqueuing", async () => {
      mockGetAllProviders.mockReturnValue([{ id: "wahoo", name: "Wahoo", validate: () => null }]);

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.triggerSync({ providerId: "wahoo" });
      expect(result.jobId).toBe("wahoo:job-123");
      expect(result.jobIds).toEqual(["wahoo:job-123"]);
      expect(result.providerJobs).toEqual([
        { providerId: "wahoo", jobId: "wahoo:job-123", queueName: "sync-wahoo" },
      ]);
      expect(mockAdd).toHaveBeenCalledWith(
        "sync",
        expect.objectContaining({
          providerId: "wahoo",
          sinceDays: undefined,
          sinceIso: "1970-01-01T00:00:00.000Z",
          targetRefreshWindow: { type: "full" },
          userId: "user-1",
        }),
        expect.objectContaining({ attempts: 288 }),
      );
    });

    it("stores a fixed since timestamp when sinceDays is provided", async () => {
      vi.setSystemTime(new Date("2026-04-28T12:00:00.000Z"));
      mockGetAllProviders.mockReturnValue([{ id: "wahoo", name: "Wahoo", validate: () => null }]);

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.triggerSync({ providerId: "wahoo", sinceDays: 7 });
      vi.useRealTimers();

      expect(mockAdd).toHaveBeenCalledWith(
        "sync",
        expect.objectContaining({
          providerId: "wahoo",
          sinceDays: 7,
          sinceIso: "2026-04-21T00:00:00.000Z",
          untilIso: "2026-04-28T23:59:59.999Z",
          targetRefreshWindow: { type: "days", days: 7 },
          userId: "user-1",
        }),
        expect.objectContaining({
          attempts: 288,
          backoff: { type: "fixed", delay: 300_000 },
        }),
      );
    });

    it("uses one sync window for every job in a sync-all fan-out", async () => {
      const dateNowSpy = vi
        .spyOn(Date, "now")
        .mockReturnValueOnce(Date.parse("2026-04-28T12:00:00.000Z"))
        .mockReturnValueOnce(Date.parse("2026-04-29T12:00:00.000Z"))
        .mockReturnValue(Date.parse("2026-04-30T12:00:00.000Z"));
      mockGetAllProviders.mockReturnValue([
        { id: "strava", name: "Strava", validate: () => null },
        { id: "wahoo", name: "Wahoo", validate: () => null },
      ]);
      mockAdd
        .mockResolvedValueOnce({ id: "job-strava" })
        .mockResolvedValueOnce({ id: "job-wahoo" });

      const caller = createCaller({
        db: {
          execute: vi.fn().mockResolvedValueOnce([]),
        },
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.triggerSync({ sinceDays: 7 });
      dateNowSpy.mockRestore();

      expect(mockAdd).toHaveBeenNthCalledWith(
        1,
        "sync",
        expect.objectContaining({
          sinceIso: "2026-04-21T00:00:00.000Z",
          untilIso: "2026-04-28T23:59:59.999Z",
        }),
        expect.anything(),
      );
      expect(mockAdd).toHaveBeenNthCalledWith(
        2,
        "sync",
        expect.objectContaining({
          sinceIso: "2026-04-21T00:00:00.000Z",
          untilIso: "2026-04-28T23:59:59.999Z",
        }),
        expect.anything(),
      );
    });

    it("finds the correct provider among multiple", async () => {
      mockGetAllProviders.mockReturnValue([
        { id: "peloton", name: "Peloton", validate: () => "Not configured" },
        { id: "wahoo", name: "Wahoo", validate: () => null },
      ]);

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });

      // Should find wahoo specifically, not just the first provider
      const result = await caller.triggerSync({ providerId: "wahoo" });
      expect(result.jobId).toBe("wahoo:job-123");
    });

    it("uses same queue instance across calls (not recreated)", async () => {
      const { createSyncQueue } = await import("dofek/jobs/queues");
      mockGetAllProviders.mockReturnValue([{ id: "wahoo", name: "Wahoo", validate: () => null }]);

      const callCountBefore = vi.mocked(createSyncQueue).mock.calls.length;

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });

      await caller.triggerSync({});
      await caller.triggerSync({});

      // No additional queue creation calls — the module-level instance is reused
      expect(vi.mocked(createSyncQueue).mock.calls.length).toBe(callCountBefore);
    });

    it("throws for unknown provider", async () => {
      mockGetAllProviders.mockReturnValue([]);
      mockGetSyncProviders.mockReturnValue([]);

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });

      await expect(caller.triggerSync({ providerId: "nonexistent" })).rejects.toThrow(
        "Unknown provider: nonexistent",
      );
    });

    it("throws for unconfigured provider", async () => {
      mockGetAllProviders.mockReturnValue([
        { id: "wahoo", name: "Wahoo", validate: () => "Missing API key" },
      ]);

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });

      await expect(caller.triggerSync({ providerId: "wahoo" })).rejects.toThrow(
        "Provider not configured: Missing API key",
      );
    });

    it("generates fallback jobId when BullMQ returns no id", async () => {
      mockAdd.mockResolvedValueOnce({ id: undefined });
      mockGetAllProviders.mockReturnValue([{ id: "wahoo", name: "Wahoo", validate: () => null }]);

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.triggerSync({});
      expect(result.jobId).toMatch(/^job-wahoo-\d+$/);
      expect(result.jobIds).toHaveLength(1);
      expect(result.providerJobs[0]?.providerId).toBe("wahoo");
    });

    it("returns skippedCooldown when sync enqueue is skipped for rate-limit cooldown", async () => {
      mockGetAllProviders.mockReturnValue([{ id: "wahoo", name: "Wahoo", validate: () => null }]);
      const enqueueSpy = vi
        .spyOn(enqueueSyncJobModule, "enqueueSyncJob")
        .mockResolvedValueOnce(null);

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.triggerSync({ providerId: "wahoo" });
      enqueueSpy.mockRestore();

      expect(result.providerResults).toEqual([
        {
          providerId: "wahoo",
          status: "skippedCooldown",
          message: "Provider sync skipped: rate-limit cooldown active",
        },
      ]);
    });
  });

  describe("queueBackpressure", () => {
    it("returns counts for provider sync queues and the import queue", async () => {
      mockGetJobCounts.mockImplementation((providerId: string) => {
        if (providerId === "garmin") {
          return Promise.resolve({ waiting: 2, active: 1, delayed: 3, failed: 4 });
        }
        if (providerId === "strava") {
          return Promise.resolve({ waiting: 5, active: 0, delayed: 1, failed: 0 });
        }
        return Promise.resolve({ waiting: 0, active: 0, delayed: 0, failed: 0 });
      });
      mockImportQueueGetJobCounts.mockResolvedValueOnce({
        waiting: 7,
        active: 1,
        delayed: 0,
        failed: 2,
      });

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([{ is_admin: true }]) },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.queueBackpressure();

      expect(result).toEqual([
        {
          queueName: "sync-strava",
          providerId: "strava",
          waiting: 5,
          active: 0,
          delayed: 1,
          failed: 0,
        },
        {
          queueName: "sync-garmin",
          providerId: "garmin",
          waiting: 2,
          active: 1,
          delayed: 3,
          failed: 4,
        },
        {
          queueName: "sync-whoop",
          providerId: "whoop",
          waiting: 0,
          active: 0,
          delayed: 0,
          failed: 0,
        },
        {
          queueName: "import",
          waiting: 7,
          active: 1,
          delayed: 0,
          failed: 2,
        },
      ]);
      expect(mockGetProviderSyncQueue).toHaveBeenCalledWith("strava");
      expect(mockGetProviderSyncQueue).toHaveBeenCalledWith("garmin");
      expect(mockGetProviderSyncQueue).toHaveBeenCalledWith("whoop");
      expect(mockGetJobCounts).toHaveBeenCalledWith("strava", [
        "waiting",
        "active",
        "delayed",
        "failed",
      ]);
      expect(mockImportQueueGetJobCounts).toHaveBeenCalledWith(
        "waiting",
        "active",
        "delayed",
        "failed",
      );
    });

    it("rejects non-admin users before returning global queue counts", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([{ is_admin: false }]) },
        userId: "user-1",
        timezone: "UTC",
      });

      await expect(caller.queueBackpressure()).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: "Admin access required",
      });
      expect(mockGetProviderSyncQueue).not.toHaveBeenCalled();
      expect(mockImportQueueGetJobCounts).not.toHaveBeenCalled();
    });
  });

  describe("syncStatus", () => {
    it("returns null for empty jobId without querying the queue", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.syncStatus({ jobId: "" });
      expect(result).toBeNull();
      // Early return should prevent any queue interaction
      expect(mockGetJob).not.toHaveBeenCalled();
    });

    it("returns null when job not found", async () => {
      mockGetJob.mockResolvedValueOnce(undefined);

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.syncStatus({ jobId: "missing-job" });
      expect(result).toBeNull();
    });

    it("returns null when Redis is unavailable", async () => {
      mockGetJob.mockRejectedValueOnce(new Error("Redis connection refused"));

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.syncStatus({ jobId: "some-job" });
      expect(result).toBeNull();
    });

    it("returns null when job belongs to different user", async () => {
      mockGetJob.mockResolvedValueOnce({
        data: { userId: "other-user" },
        getState: vi.fn().mockResolvedValue("completed"),
        progress: {},
      });

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.syncStatus({ jobId: "other-job" });
      expect(result).toBeNull();
    });

    it("returns running status for active job", async () => {
      mockGetJob.mockResolvedValueOnce({
        data: { userId: "user-1" },
        getState: vi.fn().mockResolvedValue("active"),
        progress: {
          providers: {
            wahoo: { status: "running", message: "Syncing..." },
          },
        },
      });

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.syncStatus({ jobId: "active-job" });
      expect(result?.status).toBe("running");
      expect(result?.message).toBeUndefined();
      expect(result?.providers).toEqual({
        wahoo: { status: "running", message: "Syncing..." },
      });
    });

    it("returns percentage from job progress", async () => {
      mockGetJob.mockResolvedValueOnce({
        data: { userId: "user-1" },
        getState: vi.fn().mockResolvedValue("active"),
        progress: {
          providers: { wahoo: { status: "running" } },
          percentage: 55,
        },
      });

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.syncStatus({ jobId: "active-job-percentage" });
      expect(result?.percentage).toBe(55);
    });

    it("returns undefined percentage when not present in progress", async () => {
      mockGetJob.mockResolvedValueOnce({
        data: { userId: "user-1" },
        getState: vi.fn().mockResolvedValue("active"),
        progress: {
          providers: { wahoo: { status: "running" } },
        },
      });

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.syncStatus({ jobId: "active-no-percentage" });
      expect(result?.percentage).toBeUndefined();
    });

    it("parses progress with all valid status values", async () => {
      mockGetJob.mockResolvedValueOnce({
        data: { userId: "user-1" },
        getState: vi.fn().mockResolvedValue("active"),
        progress: {
          providers: {
            a: { status: "pending" },
            b: { status: "running" },
            c: { status: "done" },
            d: { status: "error", message: "Failed" },
          },
        },
      });

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.syncStatus({ jobId: "multi-status" });
      expect(result?.providers).toEqual({
        a: { status: "pending" },
        b: { status: "running" },
        c: { status: "done" },
        d: { status: "error", message: "Failed" },
      });
    });

    it("returns done status for completed job", async () => {
      mockGetJob.mockResolvedValueOnce({
        data: { userId: "user-1" },
        getState: vi.fn().mockResolvedValue("completed"),
        progress: { providers: {} },
      });

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.syncStatus({ jobId: "done-job" });
      expect(result?.status).toBe("done");
      expect(result?.message).toBe("Sync complete");
    });

    it("returns error status with failedReason for failed job", async () => {
      mockGetJob.mockResolvedValueOnce({
        data: { userId: "user-1" },
        getState: vi.fn().mockResolvedValue("failed"),
        failedReason: "Connection timeout",
        progress: {},
      });

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.syncStatus({ jobId: "failed-job" });
      expect(result?.status).toBe("error");
      expect(result?.message).toBe("Connection timeout");
    });

    it("returns null when job data is malformed", async () => {
      mockGetJob.mockResolvedValueOnce({
        data: { notAUserId: 123 },
        getState: vi.fn().mockResolvedValue("active"),
        progress: {},
      });

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.syncStatus({ jobId: "bad-data-job" });
      expect(result).toBeNull();
    });

    it("invalidates all user caches when job completes", async () => {
      mockGetJob.mockResolvedValueOnce({
        data: { userId: "user-1" },
        getState: vi.fn().mockResolvedValue("completed"),
        progress: { providers: {} },
      });

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });

      await caller.syncStatus({ jobId: "done-job" });

      // Should invalidate ALL user caches so data queries (sleep.list, etc.)
      // pick up fresh data from the refreshed materialized views
      expect(mockInvalidateByPrefix).toHaveBeenCalledWith("user-1:");
    });

    it("invalidates all user caches when job fails", async () => {
      mockGetJob.mockResolvedValueOnce({
        data: { userId: "user-1" },
        getState: vi.fn().mockResolvedValue("failed"),
        failedReason: "Connection timeout",
        progress: {},
      });

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });

      await caller.syncStatus({ jobId: "failed-job" });

      expect(mockInvalidateByPrefix).toHaveBeenCalledWith("user-1:");
    });

    it("does not invalidate cache for active jobs", async () => {
      mockGetJob.mockResolvedValueOnce({
        data: { userId: "user-1" },
        getState: vi.fn().mockResolvedValue("active"),
        progress: { providers: { wahoo: { status: "running" } } },
      });

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });

      await caller.syncStatus({ jobId: "active-job" });

      expect(mockInvalidateByPrefix).not.toHaveBeenCalled();
    });

    it("returns empty providers when progress has no providers", async () => {
      mockGetJob.mockResolvedValueOnce({
        data: { userId: "user-1" },
        getState: vi.fn().mockResolvedValue("waiting"),
        progress: undefined,
      });

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.syncStatus({ jobId: "waiting-job" });
      expect(result?.status).toBe("running");
      expect(result?.providers).toEqual({});
    });
  });

  describe("activeSyncs", () => {
    it("returns empty array when no active jobs", async () => {
      mockGetJobs.mockResolvedValueOnce([]);

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.activeSyncs();
      expect(result).toEqual([]);
      expect(mockGetJobs).toHaveBeenCalledWith(["active", "waiting", "delayed"]);
    });

    it("returns only jobs belonging to the current user", async () => {
      mockGetJobs.mockResolvedValueOnce([
        {
          id: "job-1",
          data: { userId: "user-1" },
          getState: vi.fn().mockResolvedValue("active"),
          progress: {
            providers: {
              wahoo: { status: "running", message: "Syncing..." },
            },
          },
        },
        {
          id: "job-2",
          data: { userId: "other-user" },
          getState: vi.fn().mockResolvedValue("active"),
          progress: { providers: { strava: { status: "running" } } },
        },
      ]);

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.activeSyncs();
      expect(result).toHaveLength(1);
      expect(result[0]?.jobId).toBe("unknown:job-1");
      expect(result[0]?.status).toBe("running");
      expect(result[0]?.providers).toEqual({
        wahoo: { status: "running", message: "Syncing..." },
      });
    });

    it("includes percentage from job progress", async () => {
      mockGetJobs.mockResolvedValueOnce([
        {
          id: "job-1",
          data: { userId: "user-1" },
          getState: vi.fn().mockResolvedValue("active"),
          progress: {
            providers: { wahoo: { status: "running" } },
            percentage: 73,
          },
        },
      ]);

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.activeSyncs();
      expect(result).toHaveLength(1);
      expect(result[0]?.percentage).toBe(73);
    });

    it("returns empty array when Redis is unavailable", async () => {
      mockGetJobs.mockRejectedValueOnce(new Error("Redis connection refused"));

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.activeSyncs();
      expect(result).toEqual([]);
    });

    it("handles jobs with no progress data", async () => {
      mockGetJobs.mockResolvedValueOnce([
        {
          id: "job-1",
          data: { userId: "user-1" },
          getState: vi.fn().mockResolvedValue("waiting"),
          progress: undefined,
        },
      ]);

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.activeSyncs();
      expect(result).toHaveLength(1);
      expect(result[0]?.providers).toEqual({});
    });

    it("generates fallback jobId when BullMQ job has no id", async () => {
      mockGetJobs.mockResolvedValueOnce([
        {
          id: undefined,
          data: { userId: "user-1" },
          getState: vi.fn().mockResolvedValue("active"),
          progress: {},
        },
      ]);

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.activeSyncs();
      expect(result[0]?.jobId).toMatch(/^job-unknown-\d+$/);
    });

    it("skips jobs with malformed data", async () => {
      mockGetJobs.mockResolvedValueOnce([
        {
          id: "job-good",
          data: { userId: "user-1" },
          getState: vi.fn().mockResolvedValue("active"),
          progress: { providers: { wahoo: { status: "running" } } },
        },
        {
          id: "job-bad",
          data: { notAUserId: 123 },
          getState: vi.fn().mockResolvedValue("active"),
          progress: {},
        },
        {
          id: "job-null",
          data: null,
          getState: vi.fn().mockResolvedValue("active"),
          progress: {},
        },
      ]);

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.activeSyncs();
      expect(result).toHaveLength(1);
      expect(result[0]?.jobId).toBe("unknown:job-good");
    });
  });

  describe("activeImports", () => {
    it("returns progress for current-user import jobs", async () => {
      mockImportQueueGetJobs.mockResolvedValueOnce([
        {
          id: "job-garmin",
          data: {
            userId: "user-1",
            importType: "garmin-dump",
            filePath: "/tmp/garmin.zip",
            since: "1970-01-01T00:00:00.000Z",
          },
          progress: { percentage: 64, message: "Importing activities" },
          getState: vi.fn().mockResolvedValue("active"),
        },
        {
          id: "job-other-user",
          data: {
            userId: "user-2",
            importType: "garmin-dump",
            filePath: "/tmp/other.zip",
            since: "1970-01-01T00:00:00.000Z",
          },
          progress: 20,
          getState: vi.fn().mockResolvedValue("active"),
        },
      ]);

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.activeImports();

      expect(mockImportQueueGetJobs).toHaveBeenCalledWith(["active", "waiting", "delayed"]);
      expect(result).toEqual([
        {
          jobId: "job-garmin",
          providerId: "garmin-dump",
          progress: 64,
          message: "Importing activities",
        },
      ]);
    });

    it("uses queued defaults and skips unknown import types", async () => {
      mockImportQueueGetJobs.mockResolvedValueOnce([
        {
          id: "job-waiting",
          data: {
            userId: "user-1",
            importType: "garmin-dump",
            filePath: "/tmp/garmin.zip",
            since: "1970-01-01T00:00:00.000Z",
          },
          progress: undefined,
          getState: vi.fn().mockResolvedValue("waiting"),
        },
        {
          id: "job-unknown",
          data: { userId: "user-1", importType: "unknown" },
          progress: 10,
          getState: vi.fn().mockResolvedValue("active"),
        },
      ]);

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });

      await expect(caller.activeImports()).resolves.toEqual([
        {
          jobId: "job-waiting",
          providerId: "garmin-dump",
          progress: 0,
          message: "Waiting to import...",
        },
      ]);
    });

    it("uses a stable fallback jobId when an import job has no id", async () => {
      mockImportQueueGetJobs.mockResolvedValueOnce([
        {
          id: undefined,
          data: {
            userId: "user-1",
            importType: "garmin-dump",
            filePath: "/tmp/garmin.zip",
            since: "1970-01-01T00:00:00.000Z",
          },
          progress: 20,
          getState: vi.fn().mockResolvedValue("active"),
        },
      ]);

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.activeImports();
      expect(result[0]?.jobId).toBe("job-garmin-dump");
    });

    it("surfaces an actionable error when the import queue is unavailable", async () => {
      mockImportQueueGetJobs.mockRejectedValueOnce(new Error("Redis connection refused"));
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });

      await expect(caller.activeImports()).rejects.toThrow(
        "Unable to check import progress because the queue service is unavailable.",
      );
    });
  });

  describe("providerStats", () => {
    it("maps ClickHouse rows to provider stats", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        db: {
          execute,
        },
        sensorStore: {
          query: vi.fn().mockResolvedValue([
            {
              provider_id: "wahoo",
              activities: 10,
              daily_metrics: 5,
              sleep_sessions: 3,
              body_measurements: 2,
              food_entries: 8,
              health_events: 1,
              metric_stream: 100,
              nutrition_daily: 7,
              lab_panels: 2,
              lab_results: 4,
              journal_entries: 6,
            },
          ]),
        },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.providerStats();

      expect(result).toEqual([
        {
          providerId: "wahoo",
          totalRecords: 148,
          activities: 10,
          dailyMetrics: 5,
          sleepSessions: 3,
          bodyMeasurements: 2,
          foodEntries: 8,
          healthEvents: 1,
          metricStream: 100,
          nutritionDaily: 7,
          labPanels: 2,
          labResults: 4,
          journalEntries: 6,
        },
      ]);
      expect(execute).not.toHaveBeenCalled();
    });

    it("returns empty array when no providers", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        db: { execute },
        sensorStore: {
          query: vi.fn().mockResolvedValue([]),
        },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.providerStats();
      expect(result).toEqual([]);
      expect(execute).not.toHaveBeenCalled();
    });

    it("throws a precondition error when ClickHouse is not configured", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });

      await expect(caller.providerStats()).rejects.toMatchObject({
        code: "PRECONDITION_FAILED",
        message:
          "sync.providerStats requires the ClickHouse provider stats store. Set CLICKHOUSE_URL and retry.",
      });
    });
  });

  describe("sanitizeErrorMessage", () => {
    it("returns null when errorMessage is null", () => {
      expect(sanitizeErrorMessage(null)).toBeNull();
    });

    it("returns null when errorMessage is empty string", () => {
      expect(sanitizeErrorMessage("")).toBeNull();
    });

    it("passes through non-empty error messages", () => {
      expect(sanitizeErrorMessage("some error")).toBe("some error");
      expect(sanitizeErrorMessage("Connect API authentication failed")).toBe(
        "Connect API authentication failed",
      );
    });
  });

  describe("input schemas", () => {
    it("triggerSyncInput accepts providerId and sinceDays", () => {
      const result = triggerSyncInput.parse({ providerId: "wahoo", sinceDays: 7 });
      expect(result.providerId).toBe("wahoo");
      expect(result.sinceDays).toBe(7);
    });

    it("triggerSyncInput rejects invalid calendar dates", () => {
      expect(() =>
        triggerSyncInput.parse({
          providerId: "wahoo",
          sinceDate: "2026-02-31",
          untilDate: "2026-03-01",
        }),
      ).toThrow("Invalid calendar date");
    });

    it("triggerSyncInput accepts a valid date range", () => {
      const result = triggerSyncInput.parse({
        providerId: "wahoo",
        sinceDate: "2026-02-28",
        untilDate: "2026-03-01",
      });

      expect(result).toEqual({
        providerId: "wahoo",
        sinceDate: "2026-02-28",
        untilDate: "2026-03-01",
      });
    });

    it("triggerSyncInput rejects mixing sinceDays with a date range", () => {
      expect(() =>
        triggerSyncInput.parse({
          providerId: "wahoo",
          sinceDays: 7,
          sinceDate: "2026-02-28",
          untilDate: "2026-03-01",
        }),
      ).toThrow("Use either sinceDays or sinceDate/untilDate, not both");
    });

    it("triggerSyncInput rejects sinceDate without untilDate", () => {
      expect(() =>
        triggerSyncInput.parse({
          providerId: "wahoo",
          sinceDate: "2026-02-28",
        }),
      ).toThrow("untilDate is required when sinceDate is set");
    });

    it("triggerSyncInput rejects untilDate without sinceDate", () => {
      expect(() =>
        triggerSyncInput.parse({
          providerId: "wahoo",
          untilDate: "2026-03-01",
        }),
      ).toThrow("sinceDate is required when untilDate is set");
    });

    it("syncStatusInput requires jobId string", () => {
      const result = syncStatusInput.parse({ jobId: "abc-123" });
      expect(result.jobId).toBe("abc-123");
      expect(() => syncStatusInput.parse({})).toThrow();
    });

    it("logsInput defaults limit to 100", () => {
      const result = logsInput.parse({});
      expect(result.limit).toBe(100);
    });
  });

  describe("logs", () => {
    it("queries sync log from database", async () => {
      const mockSelect = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockResolvedValue([
                {
                  id: "log-1",
                  providerId: "wahoo",
                  syncedAt: "2024-01-01",
                  errorMessage: "provider stack trace here",
                },
              ]),
            }),
          }),
        }),
      });

      const caller = createCaller({
        db: { select: mockSelect, execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.logs({});
      expect(result).toHaveLength(1);
      expect(result[0]?.errorMessage).toBe("provider stack trace here");
    });
  });

  describe("sanitizeErrorMessage (additional cases)", () => {
    it("preserves the original error string", () => {
      expect(sanitizeErrorMessage("OAuth2 token expired")).toBe("OAuth2 token expired");
    });

    it("returns null for falsy values", () => {
      expect(sanitizeErrorMessage(null)).toBeNull();
      expect(sanitizeErrorMessage("")).toBeNull();
    });
  });

  describe("toJobId", () => {
    it("returns providerId:id when id is defined as a number", () => {
      expect(toJobId(123, "wahoo")).toBe("wahoo:123");
    });

    it("returns providerId:id when id is defined as a string", () => {
      expect(toJobId("abc-456", "wahoo")).toBe("wahoo:abc-456");
    });

    it("generates fallback ID when id is undefined", () => {
      const result = toJobId(undefined, "wahoo");
      expect(result).toMatch(/^job-wahoo-\d+$/);
    });

    it("includes the providerId in the fallback", () => {
      const result = toJobId(undefined, "garmin");
      expect(result).toContain("garmin");
      expect(result).toMatch(/^job-garmin-/);
    });

    it("uses strict === undefined check (0 and empty string are valid IDs)", () => {
      expect(toJobId(0, "wahoo")).toBe("wahoo:0");
      expect(toJobId("", "wahoo")).toBe("wahoo:");
    });
  });

  describe("parseJobId", () => {
    it("parses composite jobId with provider prefix", () => {
      expect(parseJobId("wahoo:123")).toEqual({ providerId: "wahoo", rawId: "123" });
    });

    it("handles legacy plain numeric jobId", () => {
      expect(parseJobId("123")).toEqual({ providerId: null, rawId: "123" });
    });

    it("handles fallback jobId format", () => {
      expect(parseJobId("job-wahoo-1234567890")).toEqual({
        providerId: null,
        rawId: "job-wahoo-1234567890",
      });
    });
  });

  describe("dataHealth", () => {
    function createHealthyDataHealthCaller() {
      const mockExecute = vi
        .fn()
        .mockResolvedValueOnce([{ rawRows: 42, latestRawAt: "2026-06-29T12:00:00.000Z" }])
        .mockResolvedValueOnce([{ rawRows: 8, latestRawAt: "2026-06-29T08:00:00.000Z" }])
        .mockResolvedValueOnce([{ rawRows: 3, latestRawAt: "2026-06-29T10:00:00.000Z" }]);
      const sensorStore = {
        query: vi.fn(async (_schema: unknown, queryText: string) => {
          if (queryText.includes("analytics.daily_recovery")) {
            return [{ latestReadModelAt: "2026-06-29T12:00:00.000Z" }];
          }
          if (queryText.includes("analytics.daily_sleep")) {
            return [{ latestReadModelAt: "2026-06-29T08:00:00.000Z" }];
          }
          if (queryText.includes("analytics.activity_summary_rows")) {
            return [{ latestReadModelAt: "2026-06-29T10:00:00.000Z" }];
          }
          return [];
        }),
      };
      return createCaller({
        db: { execute: mockExecute },
        sensorStore,
        userId: "user-1",
        timezone: "UTC",
      });
    }

    it("reuses data health freshness for the same user within the short cache window", async () => {
      const mockExecute = vi
        .fn()
        .mockResolvedValueOnce([{ rawRows: 42, latestRawAt: "2026-06-29T12:00:00.000Z" }])
        .mockResolvedValueOnce([{ rawRows: 8, latestRawAt: "2026-06-29T08:00:00.000Z" }])
        .mockResolvedValueOnce([{ rawRows: 3, latestRawAt: "2026-06-29T10:00:00.000Z" }]);
      const sensorStore = {
        query: vi.fn(async (_schema: unknown, queryText: string) => {
          if (queryText.includes("analytics.daily_recovery")) {
            return [{ latestReadModelAt: "2026-06-29T12:00:00.000Z" }];
          }
          if (queryText.includes("analytics.daily_sleep")) {
            return [{ latestReadModelAt: "2026-06-29T08:00:00.000Z" }];
          }
          if (queryText.includes("analytics.activity_summary_rows")) {
            return [{ latestReadModelAt: "2026-06-29T10:00:00.000Z" }];
          }
          return [];
        }),
      };
      const caller = createCaller({
        db: { execute: mockExecute },
        sensorStore,
        userId: "user-1",
        timezone: "UTC",
      });

      const first = await caller.dataHealth();
      const second = await caller.dataHealth();

      expect(second).toEqual(first);
      expect(mockExecute).toHaveBeenCalledTimes(3);
      expect(sensorStore.query).toHaveBeenCalledTimes(3);
    });

    it("does not share cached data health freshness across users", async () => {
      const mockExecute = vi
        .fn()
        .mockResolvedValueOnce([{ rawRows: 42, latestRawAt: "2026-06-29T12:00:00.000Z" }])
        .mockResolvedValueOnce([{ rawRows: 8, latestRawAt: "2026-06-29T08:00:00.000Z" }])
        .mockResolvedValueOnce([{ rawRows: 3, latestRawAt: "2026-06-29T10:00:00.000Z" }])
        .mockResolvedValueOnce([{ rawRows: 7, latestRawAt: "2026-06-30T12:00:00.000Z" }])
        .mockResolvedValueOnce([{ rawRows: 4, latestRawAt: "2026-06-30T08:00:00.000Z" }])
        .mockResolvedValueOnce([{ rawRows: 2, latestRawAt: "2026-06-30T10:00:00.000Z" }]);
      const sensorStore = {
        query: vi.fn(async (_schema: unknown, queryText: string) => {
          if (queryText.includes("analytics.daily_recovery")) {
            return [{ latestReadModelAt: "2026-06-30T12:00:00.000Z" }];
          }
          if (queryText.includes("analytics.daily_sleep")) {
            return [{ latestReadModelAt: "2026-06-30T08:00:00.000Z" }];
          }
          if (queryText.includes("analytics.activity_summary_rows")) {
            return [{ latestReadModelAt: "2026-06-30T10:00:00.000Z" }];
          }
          return [];
        }),
      };
      const firstCaller = createCaller({
        db: { execute: mockExecute },
        sensorStore,
        userId: "user-1",
        timezone: "UTC",
      });
      const secondCaller = createCaller({
        db: { execute: mockExecute },
        sensorStore,
        userId: "user-2",
        timezone: "UTC",
      });

      const first = await firstCaller.dataHealth();
      const second = await secondCaller.dataHealth();

      expect(first.datasets[0]?.rawRows).toBe(42);
      expect(second.datasets[0]?.rawRows).toBe(7);
      expect(mockExecute).toHaveBeenCalledTimes(6);
      expect(sensorStore.query).toHaveBeenCalledTimes(6);
    });

    it("does not cache data health infrastructure errors as successful data", async () => {
      mockGetJobs.mockRejectedValueOnce(new Error("Redis connection refused"));
      const mockExecute = vi
        .fn()
        .mockResolvedValueOnce([{ rawRows: 0, latestRawAt: null }])
        .mockResolvedValueOnce([{ rawRows: 0, latestRawAt: null }])
        .mockResolvedValueOnce([{ rawRows: 0, latestRawAt: null }])
        .mockResolvedValueOnce([{ rawRows: 0, latestRawAt: null }])
        .mockResolvedValueOnce([{ rawRows: 0, latestRawAt: null }])
        .mockResolvedValueOnce([{ rawRows: 0, latestRawAt: null }]);
      const caller = createCaller({
        db: { execute: mockExecute },
        userId: "user-1",
        timezone: "UTC",
      });

      await expect(caller.dataHealth()).rejects.toMatchObject({
        code: "INTERNAL_SERVER_ERROR",
        message: "Unable to check sync readiness because the queue service is unavailable.",
      });

      mockGetJobs.mockResolvedValue([]);
      const result = await caller.dataHealth();
      const cachedResult = await caller.dataHealth();

      expect(result.overallStatus).toBe("missing");
      expect(cachedResult).toEqual(result);
      expect(mockGetJobs).toHaveBeenCalledTimes(6);
      expect(mockExecute).toHaveBeenCalledTimes(6);
    });

    it("returns structured freshness state for primary datasets", async () => {
      const mockExecute = vi
        .fn()
        .mockResolvedValueOnce([{ rawRows: 42, latestRawAt: "2026-06-29T12:00:00.000Z" }])
        .mockResolvedValueOnce([{ rawRows: 8, latestRawAt: "2026-06-29T08:00:00.000Z" }])
        .mockResolvedValueOnce([{ rawRows: 3, latestRawAt: "2026-06-29T10:00:00.000Z" }]);
      const sensorStore = {
        query: vi.fn(async (_schema: unknown, queryText: string) => {
          if (queryText.includes("analytics.daily_recovery")) {
            return [{ latestReadModelAt: "2026-06-29T12:00:00.000Z" }];
          }
          if (queryText.includes("analytics.daily_sleep")) {
            return [{ latestReadModelAt: "2026-06-29T08:00:00.000Z" }];
          }
          if (queryText.includes("analytics.activity_summary_rows")) {
            return [{ latestReadModelAt: "2026-06-29T10:00:00.000Z" }];
          }
          return [];
        }),
      };
      const caller = createCaller({
        db: { execute: mockExecute },
        sensorStore,
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.dataHealth();

      expect(result.overallStatus).toBe("healthy");
      expect(result.syncingProviders).toEqual([]);
      expect(result.generatedAt).toEqual(expect.any(String));
      expect(result.datasets).toEqual([
        expect.objectContaining({
          key: "dailyMetrics",
          label: "Daily metrics",
          rawRows: 42,
          latestRawAt: "2026-06-29T12:00:00.000Z",
          latestReadModelAt: "2026-06-29T12:00:00.000Z",
          cdcLagSeconds: 0,
          readModelLagSeconds: 0,
          status: "healthy",
        }),
        expect.objectContaining({
          key: "sleep",
          label: "Sleep",
          rawRows: 8,
          status: "healthy",
        }),
        expect.objectContaining({
          key: "activity",
          label: "Activities",
          rawRows: 3,
          status: "healthy",
        }),
      ]);
      expect(mockExecute).toHaveBeenCalledTimes(3);
      expect(sensorStore.query).toHaveBeenCalledTimes(3);
      expect(sensorStore.query).toHaveBeenCalledWith(
        expect.any(Object),
        expect.stringContaining("{userId:UUID}"),
        { userId: "user-1" },
        { priority: "dashboard" },
      );
      const readModelQueries = sensorStore.query.mock.calls.map((call) => call[1]);
      expect(readModelQueries).toHaveLength(3);
      expect(readModelQueries.every((queryText) => queryText.includes("{userId:UUID}"))).toBe(true);
      expect(readModelQueries.every((queryText) => !queryText.includes("{userId:String}"))).toBe(
        true,
      );
      expect(
        readModelQueries.filter((queryText) => queryText.includes("maxOrNull(date)")),
      ).toHaveLength(2);
      expect(
        readModelQueries.some((queryText) => queryText.includes("maxOrNull(started_at)")),
      ).toBe(true);
      expect(readModelQueries.every((queryText) => !queryText.includes("max(date)"))).toBe(true);
      const rawFreshnessSql = mockExecute.mock.calls
        .map((call) => collectSqlText(call[0]))
        .join("\n");
      expect(rawFreshnessSql).toContain("max(started_at)");
      expect(rawFreshnessSql).toContain("started_at - INTERVAL '6 hours'");
      expect(rawFreshnessSql).not.toContain("max(start_time)");
      expect(mockLoggerWarn).not.toHaveBeenCalled();
    });

    it("marks all datasets missing when no raw rows exist", async () => {
      const mockExecute = vi
        .fn()
        .mockResolvedValueOnce([{ rawRows: 0, latestRawAt: null }])
        .mockResolvedValueOnce([{ rawRows: 0, latestRawAt: null }])
        .mockResolvedValueOnce([{ rawRows: 0, latestRawAt: null }]);
      const sensorStore = {
        query: vi.fn().mockResolvedValue([]),
      };
      const caller = createCaller({
        db: { execute: mockExecute },
        sensorStore,
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.dataHealth();

      expect(result.overallStatus).toBe("missing");
      expect(result.datasets).toEqual([
        expect.objectContaining({
          key: "dailyMetrics",
          rawRows: 0,
          latestRawAt: null,
          latestReadModelAt: null,
          cdcLagSeconds: null,
          readModelLagSeconds: null,
          status: "missing",
          message: "No daily metrics data has been synced yet.",
        }),
        expect.objectContaining({
          key: "sleep",
          rawRows: 0,
          status: "missing",
          message: "No sleep data has been synced yet.",
        }),
        expect.objectContaining({
          key: "activity",
          rawRows: 0,
          status: "missing",
          message: "No activities data has been synced yet.",
        }),
      ]);
      expect(sensorStore.query).toHaveBeenCalledTimes(3);
    });

    it("marks read models stale when ClickHouse summaries lag raw data by more than one day", async () => {
      const mockExecute = vi
        .fn()
        .mockResolvedValueOnce([{ rawRows: 42, latestRawAt: "2026-06-29T12:00:00.000Z" }])
        .mockResolvedValueOnce([{ rawRows: 8, latestRawAt: "2026-06-29T08:00:00.000Z" }])
        .mockResolvedValueOnce([{ rawRows: 3, latestRawAt: "2026-06-29T10:00:00.000Z" }]);
      const sensorStore = {
        query: vi.fn(async (_schema: unknown, queryText: string) => {
          if (queryText.includes("analytics.daily_recovery")) {
            return [{ latestReadModelAt: "2026-06-27" }];
          }
          if (queryText.includes("analytics.daily_sleep")) {
            return [{ latestReadModelAt: "2026-06-29T08:00:00.000Z" }];
          }
          if (queryText.includes("analytics.activity_summary_rows")) {
            return [{ latestReadModelAt: "2026-06-29T10:00:00.000Z" }];
          }
          return [];
        }),
      };
      const caller = createCaller({
        db: { execute: mockExecute },
        sensorStore,
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.dataHealth();

      expect(result.overallStatus).toBe("stale");
      expect(result.datasets[0]).toEqual(
        expect.objectContaining({
          key: "dailyMetrics",
          latestRawAt: "2026-06-29T12:00:00.000Z",
          latestReadModelAt: "2026-06-27T00:00:00.000Z",
          cdcLagSeconds: 172800,
          readModelLagSeconds: 172800,
          status: "stale",
          message: "Daily metrics data is synced, but dashboard summaries are still catching up.",
        }),
      );
      expect(result.datasets[1]?.status).toBe("healthy");
      expect(result.datasets[2]?.status).toBe("healthy");
    });

    it("treats same-day read-model timestamps as healthy", async () => {
      const mockExecute = vi
        .fn()
        .mockResolvedValueOnce([{ rawRows: 42, latestRawAt: "2026-06-29T12:00:00.000Z" }])
        .mockResolvedValueOnce([{ rawRows: 8, latestRawAt: "2026-06-29T08:00:00.000Z" }])
        .mockResolvedValueOnce([{ rawRows: 3, latestRawAt: "2026-06-29T10:00:00.000Z" }]);
      const sensorStore = {
        query: vi.fn(async (_schema: unknown, queryText: string) => {
          if (queryText.includes("analytics.daily_recovery")) {
            return [{ latestReadModelAt: "2026-06-29T11:00:00.000Z" }];
          }
          if (queryText.includes("analytics.daily_sleep")) {
            return [{ latestReadModelAt: "2026-06-29T08:00:00.000Z" }];
          }
          if (queryText.includes("analytics.activity_summary_rows")) {
            return [{ latestReadModelAt: "2026-06-29T10:00:00.000Z" }];
          }
          return [];
        }),
      };
      const caller = createCaller({
        db: { execute: mockExecute },
        sensorStore,
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.dataHealth();

      expect(result.overallStatus).toBe("healthy");
      expect(result.datasets[0]).toEqual(
        expect.objectContaining({
          key: "dailyMetrics",
          cdcLagSeconds: 0,
          readModelLagSeconds: 0,
          status: "healthy",
        }),
      );
    });

    it("compares activity read-model freshness at timestamp grain", async () => {
      const mockExecute = vi
        .fn()
        .mockResolvedValueOnce([{ rawRows: 42, latestRawAt: "2026-06-29T12:00:00.000Z" }])
        .mockResolvedValueOnce([{ rawRows: 8, latestRawAt: "2026-06-29T08:00:00.000Z" }])
        .mockResolvedValueOnce([{ rawRows: 3, latestRawAt: "2026-06-29T18:00:00.000Z" }]);
      const sensorStore = {
        query: vi.fn(async (_schema: unknown, queryText: string) => {
          if (queryText.includes("analytics.daily_recovery")) {
            return [{ latestReadModelAt: "2026-06-29T12:00:00.000Z" }];
          }
          if (queryText.includes("analytics.daily_sleep")) {
            return [{ latestReadModelAt: "2026-06-29T08:00:00.000Z" }];
          }
          if (queryText.includes("analytics.activity_summary_rows")) {
            return [{ latestReadModelAt: "2026-06-29T06:00:00.000Z" }];
          }
          return [];
        }),
      };
      const caller = createCaller({
        db: { execute: mockExecute },
        sensorStore,
        userId: "user-1",
        timezone: "America/Los_Angeles",
      });

      const result = await caller.dataHealth();

      expect(result.overallStatus).toBe("stale");
      expect(result.datasets[2]).toEqual(
        expect.objectContaining({
          key: "activity",
          latestRawAt: "2026-06-29T18:00:00.000Z",
          latestReadModelAt: "2026-06-29T06:00:00.000Z",
          readModelLagSeconds: 43200,
          status: "stale",
        }),
      );
    });

    it("compares daily read-model freshness at date grain", async () => {
      const mockExecute = vi
        .fn()
        .mockResolvedValueOnce([{ rawRows: 42, latestRawAt: "2026-06-29T23:59:00.000Z" }])
        .mockResolvedValueOnce([{ rawRows: 8, latestRawAt: "2026-06-29T18:00:00.000Z" }])
        .mockResolvedValueOnce([{ rawRows: 3, latestRawAt: "2026-06-29T20:00:00.000Z" }]);
      const sensorStore = {
        query: vi.fn(async (_schema: unknown, queryText: string) => {
          if (queryText.includes("analytics.activity_summary_rows")) {
            return [{ latestReadModelAt: "2026-06-29T20:00:00.000Z" }];
          }
          return [{ latestReadModelAt: "2026-06-29" }];
        }),
      };
      const caller = createCaller({
        db: { execute: mockExecute },
        sensorStore,
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.dataHealth();

      expect(result.overallStatus).toBe("healthy");
      expect(result.datasets.map((dataset) => dataset.readModelLagSeconds)).toEqual([0, 0, 0]);
      expect(result.datasets.map((dataset) => dataset.status)).toEqual([
        "healthy",
        "healthy",
        "healthy",
      ]);
    });

    it("marks data blocked when raw data exists but read models are unavailable", async () => {
      const mockExecute = vi
        .fn()
        .mockResolvedValueOnce([{ rawRows: 12, latestRawAt: "2026-06-29T12:00:00.000Z" }])
        .mockResolvedValueOnce([{ rawRows: 0, latestRawAt: null }])
        .mockResolvedValueOnce([{ rawRows: 0, latestRawAt: null }]);
      const caller = createCaller({
        db: { execute: mockExecute },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.dataHealth();

      expect(result.overallStatus).toBe("blocked");
      expect(result.datasets[0]).toEqual(
        expect.objectContaining({
          key: "dailyMetrics",
          status: "blocked",
          latestReadModelAt: null,
          message: expect.stringContaining("ClickHouse mirrors are not current"),
        }),
      );
    });

    it("marks overall status missing when only some primary datasets are missing", async () => {
      const mockExecute = vi
        .fn()
        .mockResolvedValueOnce([{ rawRows: 12, latestRawAt: "2026-06-29T12:00:00.000Z" }])
        .mockResolvedValueOnce([{ rawRows: 0, latestRawAt: null }])
        .mockResolvedValueOnce([{ rawRows: 0, latestRawAt: null }]);
      const sensorStore = {
        query: vi.fn(async (_schema: unknown, queryText: string) => {
          if (queryText.includes("analytics.daily_recovery")) {
            return [{ latestReadModelAt: "2026-06-29T12:00:00.000Z" }];
          }
          return [];
        }),
      };
      const caller = createCaller({
        db: { execute: mockExecute },
        sensorStore,
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.dataHealth();

      expect(result.overallStatus).toBe("missing");
      expect(result.datasets.map((dataset) => dataset.status)).toEqual([
        "healthy",
        "missing",
        "missing",
      ]);
    });

    it("ignores active sync jobs for other users", async () => {
      mockGetJobs.mockResolvedValue([
        {
          id: "job-1",
          data: { userId: "other-user", providerId: "garmin" },
          progress: {},
          getState: vi.fn().mockResolvedValue("waiting"),
        },
      ]);
      const mockExecute = vi
        .fn()
        .mockResolvedValueOnce([{ rawRows: 0, latestRawAt: null }])
        .mockResolvedValueOnce([{ rawRows: 0, latestRawAt: null }])
        .mockResolvedValueOnce([{ rawRows: 0, latestRawAt: null }]);
      const caller = createCaller({
        db: { execute: mockExecute },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.dataHealth();

      expect(result.overallStatus).toBe("missing");
      expect(result.syncingProviders).toEqual([]);
      expect(result.datasets.map((dataset) => dataset.status)).toEqual([
        "missing",
        "missing",
        "missing",
      ]);
    });

    it("marks overall status syncing when an active provider sync exists", async () => {
      mockGetAllProviders.mockReturnValue([
        {
          id: "garmin",
          name: "Garmin",
          validate: () => null,
        },
      ]);
      mockGetJobs.mockResolvedValue([
        {
          id: "job-1",
          data: { userId: "user-1", providerId: "garmin" },
          progress: {},
          getState: vi.fn().mockResolvedValue("waiting"),
        },
      ]);
      const mockExecute = vi
        .fn()
        .mockResolvedValueOnce([{ rawRows: 0, latestRawAt: null }])
        .mockResolvedValueOnce([{ rawRows: 0, latestRawAt: null }])
        .mockResolvedValueOnce([{ rawRows: 0, latestRawAt: null }]);
      const caller = createCaller({
        db: { execute: mockExecute },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.dataHealth();

      expect(result.overallStatus).toBe("syncing");
      expect(result.syncingProviders).toEqual([{ id: "garmin", name: "Garmin" }]);
      expect(result.datasets[0]?.status).toBe("missing");
    });

    it("ignores active provider sync jobs for other users when datasets are healthy", async () => {
      mockGetJobs.mockResolvedValue([
        {
          id: "job-1",
          data: { userId: "other-user", providerId: "garmin" },
          progress: {},
          getState: vi.fn().mockResolvedValue("waiting"),
        },
      ]);
      const caller = createHealthyDataHealthCaller();

      const result = await caller.dataHealth();

      expect(result.overallStatus).toBe("healthy");
      expect(result.syncingProviders).toEqual([]);
    });

    it("sorts syncing providers alphabetically by display name", async () => {
      mockGetAllProviders.mockReturnValue([
        { id: "whoop", name: "WHOOP", validate: () => null },
        { id: "garmin", name: "Garmin", validate: () => null },
      ]);
      mockGetJobs.mockResolvedValue([
        {
          id: "job-whoop",
          data: { userId: "user-1", providerId: "whoop" },
          progress: {},
          getState: vi.fn().mockResolvedValue("waiting"),
        },
        {
          id: "job-garmin",
          data: { userId: "user-1", providerId: "garmin" },
          progress: {},
          getState: vi.fn().mockResolvedValue("waiting"),
        },
      ]);
      const caller = createHealthyDataHealthCaller();

      const result = await caller.dataHealth();

      expect(result.syncingProviders).toEqual([
        { id: "garmin", name: "Garmin" },
        { id: "whoop", name: "WHOOP" },
      ]);
    });

    it("uses push provider display names for active push sync jobs", async () => {
      mockGetAllProviders.mockReturnValue([
        {
          id: "whoop_ble",
          name: "Registered WHOOP BLE",
          validate: () => null,
        },
      ]);
      mockGetJobs.mockResolvedValue([
        {
          id: "job-ble",
          data: { userId: "user-1", providerId: "whoop_ble" },
          progress: {},
          getState: vi.fn().mockResolvedValue("active"),
        },
      ]);
      const caller = createHealthyDataHealthCaller();

      const result = await caller.dataHealth();

      expect(result.syncingProviders).toEqual([{ id: "whoop_ble", name: "WHOOP (Bluetooth)" }]);
    });

    it("marks overall status syncing for active jobs in registered provider queues", async () => {
      mockGetAllProviders.mockReturnValue([
        {
          id: "cycling-analytics",
          name: "Cycling Analytics",
          validate: () => null,
          authSetup: () => ({ oauthConfig: { authUrl: "https://example.com" } }),
        },
      ]);
      mockGetProviderSyncQueue.mockImplementation((id: string) => ({
        add: mockAdd,
        getJob: mockGetJob,
        getJobs: vi.fn().mockResolvedValue(
          id === "cycling-analytics"
            ? [
                {
                  id: "job-1",
                  data: { userId: "user-1", providerId: "cycling-analytics" },
                  progress: {},
                  getState: vi.fn().mockResolvedValue("waiting"),
                },
              ]
            : [],
        ),
        getJobCounts: (...states: string[]) => mockGetJobCounts(id, states),
      }));
      const mockExecute = vi
        .fn()
        .mockResolvedValueOnce([{ rawRows: 0, latestRawAt: null }])
        .mockResolvedValueOnce([{ rawRows: 0, latestRawAt: null }])
        .mockResolvedValueOnce([{ rawRows: 0, latestRawAt: null }]);
      const caller = createCaller({
        db: { execute: mockExecute },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.dataHealth();

      expect(result.overallStatus).toBe("syncing");
      expect(result.syncingProviders).toEqual([
        { id: "cycling-analytics", name: "Cycling Analytics" },
      ]);
      expect(mockGetProviderSyncQueue).toHaveBeenCalledWith("cycling-analytics");
    });

    it("marks overall status syncing when an import job exists for the user", async () => {
      mockImportQueueGetJobs.mockResolvedValue([
        {
          id: "import-1",
          data: {
            userId: "user-1",
            importType: "apple-health",
            filePath: "/tmp/apple-health.zip",
            since: "2020-01-01T00:00:00.000Z",
          },
          progress: {},
          getState: vi.fn().mockResolvedValue("waiting"),
        },
      ]);
      const mockExecute = vi
        .fn()
        .mockResolvedValueOnce([{ rawRows: 0, latestRawAt: null }])
        .mockResolvedValueOnce([{ rawRows: 0, latestRawAt: null }])
        .mockResolvedValueOnce([{ rawRows: 0, latestRawAt: null }]);
      const caller = createCaller({
        db: { execute: mockExecute },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.dataHealth();

      expect(result.overallStatus).toBe("syncing");
      expect(result.syncingProviders).toEqual([{ id: "apple_health", name: "Apple Health" }]);
      expect(mockImportQueueGetJobs).toHaveBeenCalledWith(["waiting", "active"]);
    });

    it("ignores import jobs with unknown import types", async () => {
      mockImportQueueGetJobs.mockResolvedValue([
        {
          id: "import-stale",
          data: {
            userId: "user-1",
            importType: "unknown-import-type",
            filePath: "/tmp/stale.zip",
            since: "2020-01-01T00:00:00.000Z",
          },
          progress: {},
          getState: vi.fn().mockResolvedValue("waiting"),
        },
      ]);
      const caller = createHealthyDataHealthCaller();

      const result = await caller.dataHealth();

      expect(result.overallStatus).toBe("healthy");
      expect(result.syncingProviders).toEqual([]);
    });

    it("ignores active import jobs for other users when datasets are healthy", async () => {
      mockImportQueueGetJobs.mockResolvedValue([
        {
          id: "import-other-user",
          data: {
            userId: "other-user",
            importType: "apple-health",
            filePath: "/tmp/apple-health.zip",
            since: "2020-01-01T00:00:00.000Z",
          },
          progress: {},
          getState: vi.fn().mockResolvedValue("waiting"),
        },
      ]);
      const caller = createHealthyDataHealthCaller();

      const result = await caller.dataHealth();

      expect(result.overallStatus).toBe("healthy");
      expect(result.syncingProviders).toEqual([]);
    });

    it("ignores import jobs with non-string importType values", async () => {
      mockImportQueueGetJobs.mockResolvedValue([
        {
          id: "import-bad-type",
          data: {
            userId: "user-1",
            importType: 123,
            filePath: "/tmp/apple-health.zip",
            since: "2020-01-01T00:00:00.000Z",
          },
          progress: {},
          getState: vi.fn().mockResolvedValue("waiting"),
        },
      ]);
      const caller = createHealthyDataHealthCaller();

      const result = await caller.dataHealth();

      expect(result.overallStatus).toBe("healthy");
      expect(result.syncingProviders).toEqual([]);
    });

    it("ignores import jobs missing importType", async () => {
      mockImportQueueGetJobs.mockResolvedValue([
        {
          id: "import-no-type",
          data: {
            userId: "user-1",
            filePath: "/tmp/apple-health.zip",
            since: "2020-01-01T00:00:00.000Z",
          },
          progress: {},
          getState: vi.fn().mockResolvedValue("waiting"),
        },
      ]);
      const caller = createHealthyDataHealthCaller();

      const result = await caller.dataHealth();

      expect(result.overallStatus).toBe("healthy");
      expect(result.syncingProviders).toEqual([]);
    });

    it("marks overall status syncing for cronometer and zos import jobs", async () => {
      mockImportQueueGetJobs.mockResolvedValue([
        {
          id: "import-cronometer",
          data: {
            userId: "user-1",
            importType: "cronometer-csv",
            filePath: "/tmp/cronometer.csv",
            since: "2020-01-01T00:00:00.000Z",
          },
          progress: {},
          getState: vi.fn().mockResolvedValue("waiting"),
        },
        {
          id: "import-zos",
          data: {
            userId: "user-1",
            importType: "zos-app",
            filePath: "/tmp/zos.zip",
            since: "2020-01-01T00:00:00.000Z",
          },
          progress: {},
          getState: vi.fn().mockResolvedValue("active"),
        },
      ]);
      const caller = createHealthyDataHealthCaller();

      const result = await caller.dataHealth();

      expect(result.overallStatus).toBe("syncing");
      expect(result.syncingProviders).toEqual([
        { id: "cronometer-csv", name: "cronometer-csv" },
        { id: "zos-app", name: "zos-app" },
      ]);
    });

    it("ignores provider sync jobs with malformed job data", async () => {
      mockGetJobs.mockResolvedValue([
        {
          id: "job-null-data",
          data: null,
          progress: {},
          getState: vi.fn().mockResolvedValue("waiting"),
        },
        {
          id: "job-string-data",
          data: "invalid",
          progress: {},
          getState: vi.fn().mockResolvedValue("waiting"),
        },
      ]);
      const caller = createHealthyDataHealthCaller();

      const result = await caller.dataHealth();

      expect(result.overallStatus).toBe("healthy");
      expect(result.syncingProviders).toEqual([]);
    });

    it("falls back to queue provider id when sync job payload has empty providerId", async () => {
      mockGetAllProviders.mockReturnValue([
        {
          id: "garmin",
          name: "Garmin",
          validate: () => null,
        },
      ]);
      mockGetJobs.mockResolvedValue([
        {
          id: "job-empty-provider",
          data: { userId: "user-1", providerId: "" },
          progress: {},
          getState: vi.fn().mockResolvedValue("waiting"),
        },
      ]);
      const caller = createHealthyDataHealthCaller();

      const result = await caller.dataHealth();

      expect(result.overallStatus).toBe("syncing");
      expect(result.syncingProviders).toEqual([{ id: "garmin", name: "Garmin" }]);
    });

    it("falls back to queue provider id when sync job payload has stale providerId", async () => {
      mockGetAllProviders.mockReturnValue([
        {
          id: "garmin",
          name: "Garmin",
          validate: () => null,
        },
      ]);
      mockGetJobs.mockResolvedValue([
        {
          id: "job-stale-provider",
          data: { userId: "user-1", providerId: "stale-unknown-provider" },
          progress: {},
          getState: vi.fn().mockResolvedValue("waiting"),
        },
      ]);
      const caller = createHealthyDataHealthCaller();

      const result = await caller.dataHealth();

      expect(result.overallStatus).toBe("syncing");
      expect(result.syncingProviders).toEqual([{ id: "garmin", name: "Garmin" }]);
    });

    it("does not mark overall status syncing for delayed-only jobs", async () => {
      mockGetJobs.mockResolvedValue([]);
      mockImportQueueGetJobs.mockResolvedValue([]);
      const caller = createHealthyDataHealthCaller();

      const result = await caller.dataHealth();

      expect(result.overallStatus).toBe("healthy");
      expect(result.syncingProviders).toEqual([]);
      expect(mockGetJobs).toHaveBeenCalledWith(["waiting", "active"]);
    });

    it("surfaces queue failures as stable readiness errors", async () => {
      mockGetJobs.mockRejectedValueOnce(new Error("Redis connection refused"));
      const mockExecute = vi
        .fn()
        .mockResolvedValueOnce([{ rawRows: 0, latestRawAt: null }])
        .mockResolvedValueOnce([{ rawRows: 0, latestRawAt: null }])
        .mockResolvedValueOnce([{ rawRows: 0, latestRawAt: null }]);
      const caller = createCaller({
        db: { execute: mockExecute },
        userId: "user-1",
        timezone: "UTC",
      });

      await expect(caller.dataHealth()).rejects.toMatchObject({
        code: "INTERNAL_SERVER_ERROR",
        message: "Unable to check sync readiness because the queue service is unavailable.",
      });
      expect(mockCaptureException).toHaveBeenCalledWith(expect.any(Error));
    });
  });
});
