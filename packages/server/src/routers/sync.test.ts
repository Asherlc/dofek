import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

const {
  mockAdd,
  mockGetJob,
  mockGetJobs,
  mockGetAllProviders,
  mockGetSyncProviders,
  mockRegisterProvider,
  mockLoggerWarn,
  mockInvalidateByPrefix,
} = vi.hoisted(() => ({
  mockAdd: vi.fn().mockResolvedValue({ id: "job-123" }),
  mockGetJob: vi.fn(),
  mockGetJobs: vi.fn().mockResolvedValue([]),
  mockGetAllProviders: vi.fn(() => []),
  mockGetSyncProviders: vi.fn(() => []),
  mockRegisterProvider: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockInvalidateByPrefix: vi.fn().mockResolvedValue(undefined),
}));

// Mock trpc
vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{ db: unknown; userId: string | null; timezone: string }>()
    .create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
    cachedProtectedQuery: () => trpc.procedure,
    CacheTTL: { SHORT: 120_000, MEDIUM: 600_000, LONG: 3_600_000 },
  };
});

vi.mock("dofek/jobs/provider-queue-config", () => ({
  getConfiguredProviderIds: vi.fn(() => ["strava", "garmin", "whoop"]),
}));

vi.mock("dofek/jobs/queues", () => ({
  createSyncQueue: vi.fn(() => ({
    add: mockAdd,
    getJob: mockGetJob,
    getJobs: mockGetJobs,
  })),
  createProviderSyncQueue: vi.fn(() => ({
    add: mockAdd,
    getJob: mockGetJob,
    getJobs: mockGetJobs,
  })),
  getProviderSyncQueue: vi.fn(() => ({
    add: mockAdd,
    getJob: mockGetJob,
    getJobs: mockGetJobs,
  })),
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
  startWorker: vi.fn(),
}));

vi.mock("../lib/cache.ts", () => ({
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
  VeloHeroProvider: vi.fn(() => {
    throw new Error("test-registration-error");
  }),
}));

// Mock schema and drizzle-orm for logs query
vi.mock("dofek/db/schema", () => ({
  syncLog: {
    userId: "userId",
    syncedAt: "syncedAt",
  },
}));

import {
  ensureProvidersRegistered,
  isAuthError,
  logsInput,
  mapBullMqStateToSyncStatus,
  parseJobId,
  sanitizeErrorMessage,
  syncRouter,
  syncStatusInput,
  toJobId,
  triggerSyncInput,
} from "./sync.ts";

describe("syncRouter", () => {
  const createCaller = createTestCallerFactory(syncRouter);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("ensureProvidersRegistered", () => {
    it("registers all providers and returns the same promise on subsequent calls", async () => {
      const first = ensureProvidersRegistered();
      expect(first).toBeInstanceOf(Promise);

      // Second call should return the cached promise (not create a new one)
      const second = ensureProvidersRegistered();
      expect(second).toBe(first);

      await first;
      // Verify registerProvider was called for each provider in the list
      // (minus 1 for velohero which throws during construction)
      expect(mockRegisterProvider).toHaveBeenCalled();
      expect(mockRegisterProvider.mock.calls.length).toBeGreaterThanOrEqual(12);

      // Verify error handling: velohero throws but doesn't prevent other providers
      expect(mockLoggerWarn).toHaveBeenCalledWith(expect.stringContaining("velohero"));
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
      expect(result).toHaveLength(4);
      expect(result.find((p: { id: string }) => p.id === "peloton")).toBeUndefined();

      // Wahoo: OAuth provider, authorized (has token)
      const wahoo = result.find((p: { id: string }) => p.id === "wahoo");
      expect(wahoo?.authType).toBe("oauth");
      expect(wahoo?.authorized).toBe(true);
      expect(wahoo?.lastSyncedAt).toBe("2024-01-01");
      expect(wahoo?.importOnly).toBe(false);
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
              },
              {
                provider_id: "wahoo",
                error_message: "Network timeout after 30s",
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
      expect(result).toHaveLength(1);
      expect(result[0]?.authType).toBe("none");
    });
  });

  describe("isAuthError", () => {
    it("detects authorization failure messages", () => {
      expect(isAuthError("Polar authorization failed while syncing exercises")).toBe(true);
      expect(isAuthError("Strava API unauthorized (401): /athlete/activities")).toBe(true);
      expect(isAuthError("Eight Sleep token expired — please re-authenticate via Settings")).toBe(
        true,
      );
      expect(isAuthError("VeloHero session expired — please re-authenticate via Settings")).toBe(
        true,
      );
      expect(isAuthError("Connect API authentication failed: invalid token")).toBe(true);
    });

    it("rejects non-auth errors", () => {
      expect(isAuthError("Network timeout after 30s")).toBe(false);
      expect(isAuthError("Rate limited by provider")).toBe(false);
      expect(isAuthError("Internal server error")).toBe(false);
    });

    it("handles null/empty", () => {
      expect(isAuthError(null)).toBe(false);
      expect(isAuthError("")).toBe(false);
    });

    it("detects each AUTH_ERROR_PATTERNS entry individually", () => {
      // Each of the 6 patterns must individually trigger true
      expect(isAuthError("authorization failed")).toBe(true);
      expect(isAuthError("unauthorized")).toBe(true);
      expect(isAuthError("re-authenticate")).toBe(true);
      expect(isAuthError("token expired")).toBe(true);
      expect(isAuthError("session expired")).toBe(true);
      expect(isAuthError("authentication failed")).toBe(true);
    });

    it("is case-insensitive (matches uppercase input)", () => {
      expect(isAuthError("AUTHORIZATION FAILED")).toBe(true);
      expect(isAuthError("UNAUTHORIZED")).toBe(true);
      expect(isAuthError("RE-AUTHENTICATE")).toBe(true);
      expect(isAuthError("TOKEN EXPIRED")).toBe(true);
      expect(isAuthError("SESSION EXPIRED")).toBe(true);
      expect(isAuthError("AUTHENTICATION FAILED")).toBe(true);
    });

    it("returns false for a partial match that does not contain any pattern", () => {
      expect(isAuthError("author")).toBe(false);
      expect(isAuthError("expire")).toBe(false);
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
      expect(mockAdd).toHaveBeenNthCalledWith(1, "sync", {
        providerId: "strava",
        sinceDays: undefined,
        userId: "user-1",
      });
      expect(mockAdd).toHaveBeenNthCalledWith(2, "sync", {
        providerId: "wahoo",
        sinceDays: undefined,
        userId: "user-1",
      });
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
          authSetup: () => ({
            oauthConfig: { clientId: "whoop", authorizeUrl: "", tokenUrl: "", redirectUri: "" },
            automatedLogin: async () => ({}),
          }),
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
      // whoop has authSetup but no token — excluded
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
      expect(mockAdd).toHaveBeenCalledWith("sync", {
        providerId: "strava",
        sinceDays: undefined,
        userId: "user-1",
      });
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
      expect(mockAdd).toHaveBeenCalledWith("sync", {
        providerId: "wahoo",
        sinceDays: undefined,
        userId: "user-1",
      });
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

  describe("providerStats", () => {
    it("maps database rows to provider stats", async () => {
      const caller = createCaller({
        db: {
          execute: vi.fn().mockResolvedValue([
            {
              provider_id: "wahoo",
              activities: 10,
              daily_metrics: 5,
              sleep_sessions: 3,
              body_measurements: 2,
              food_entries: 0,
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
          activities: 10,
          dailyMetrics: 5,
          sleepSessions: 3,
          bodyMeasurements: 2,
          foodEntries: 0,
          healthEvents: 1,
          metricStream: 100,
          nutritionDaily: 7,
          labPanels: 2,
          labResults: 4,
          journalEntries: 6,
        },
      ]);
    });

    it("returns empty array when no providers", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.providerStats();
      expect(result).toEqual([]);
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
    it("returns row counts for base tables and materialized views", async () => {
      const mockExecute = vi.fn().mockResolvedValue([{ count: 42 }]);
      const caller = createCaller({
        db: { execute: mockExecute },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.dataHealth();
      expect(result.dailyMetrics).toEqual({ baseTable: 42, materializedView: 42 });
      expect(result.sleep).toEqual({ baseTable: 42, materializedView: 42 });
      expect(result.activity).toEqual({ baseTable: 42, materializedView: 42 });
      expect(result.hasStaleViews).toBe(false);
    });

    it("detects stale views when base has data but view is empty", async () => {
      let callCount = 0;
      const mockExecute = vi.fn().mockImplementation(() => {
        callCount++;
        // Odd calls (base tables) return data, even calls (views) return 0
        return Promise.resolve([{ count: callCount % 2 === 1 ? 100 : 0 }]);
      });
      const caller = createCaller({
        db: { execute: mockExecute },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.dataHealth();
      expect(result.hasStaleViews).toBe(true);
      expect(mockLoggerWarn).toHaveBeenCalledWith(
        expect.stringContaining("stale materialized views"),
      );
    });
  });

  describe("mapBullMqStateToSyncStatus", () => {
    it("maps 'completed' to 'done'", () => {
      expect(mapBullMqStateToSyncStatus("completed")).toBe("done");
    });

    it("maps 'failed' to 'error'", () => {
      expect(mapBullMqStateToSyncStatus("failed")).toBe("error");
    });

    it("maps 'active' to 'running' (default)", () => {
      expect(mapBullMqStateToSyncStatus("active")).toBe("running");
    });

    it("maps 'waiting' to 'running' (default)", () => {
      expect(mapBullMqStateToSyncStatus("waiting")).toBe("running");
    });

    it("maps unknown states to 'running' (default)", () => {
      expect(mapBullMqStateToSyncStatus("delayed")).toBe("running");
      expect(mapBullMqStateToSyncStatus("")).toBe("running");
    });

    it("does not swap 'completed' and 'failed' mappings", () => {
      expect(mapBullMqStateToSyncStatus("completed")).not.toBe("error");
      expect(mapBullMqStateToSyncStatus("failed")).not.toBe("done");
    });
  });
});
