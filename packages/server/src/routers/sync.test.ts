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
} = vi.hoisted(() => ({
  mockAdd: vi.fn().mockResolvedValue({ id: "job-123" }),
  mockGetJob: vi.fn(),
  mockGetJobs: vi.fn().mockResolvedValue([]),
  mockGetAllProviders: vi.fn(() => []),
  mockGetSyncProviders: vi.fn(() => []),
  mockRegisterProvider: vi.fn(),
  mockLoggerWarn: vi.fn(),
}));

// Mock trpc
vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const t = initTRPC.context<{ db: unknown; userId: string | null }>().create();
  return {
    router: t.router,
    protectedProcedure: t.procedure,
    cachedProtectedQuery: () => t.procedure,
    cachedProtectedQueryLight: () => t.procedure,
    CacheTTL: { SHORT: 120_000, MEDIUM: 600_000, LONG: 3_600_000 },
  };
});

vi.mock("dofek/jobs/queues", () => ({
  createSyncQueue: vi.fn(() => ({
    add: mockAdd,
    getJob: mockGetJob,
    getJobs: mockGetJobs,
  })),
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

vi.mock("../logger.ts", () => ({
  logger: { warn: mockLoggerWarn, info: vi.fn() },
}));

// Mock the dynamic provider imports used in doRegisterProviders
vi.mock("dofek/providers/wahoo", () => ({ WahooProvider: vi.fn() }));
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
  logsInput,
  REDACTED_ERROR_MESSAGE,
  syncRouter,
  syncStatusInput,
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
          authSetup: undefined,
        },
        {
          id: "strong-csv",
          name: "Strong CSV",
          validate: () => null,
          authSetup: undefined,
          importOnly: true,
        },
        {
          id: "cronometer-csv",
          name: "Cronometer CSV",
          validate: () => null,
          authSetup: undefined,
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
            .mockResolvedValueOnce([{ provider_id: "wahoo", last_synced: "2024-01-01" }]),
        },
        userId: "user-1",
      });

      const result = await caller.providers();

      // Peloton is filtered out because its validate() fails
      expect(result).toHaveLength(4);
      expect(result.find((p: { id: string }) => p.id === "peloton")).toBeUndefined();

      // Wahoo: needs OAuth, authorized (has token)
      const wahoo = result.find((p: { id: string }) => p.id === "wahoo");
      expect(wahoo?.needsOAuth).toBe(true);
      expect(wahoo?.needsCustomAuth).toBe(false);
      expect(wahoo?.authorized).toBe(true);
      expect(wahoo?.lastSyncedAt).toBe("2024-01-01");
      expect(wahoo?.importOnly).toBe(false);

      // WHOOP: needs custom auth, not authorized (no token)
      const whoop = result.find((p: { id: string }) => p.id === "whoop");
      expect(whoop?.needsCustomAuth).toBe(true);
      expect(whoop?.needsOAuth).toBe(false);
      expect(whoop?.authorized).toBe(false);

      // Strong CSV: import only
      const strongCsv = result.find((p: { id: string }) => p.id === "strong-csv");
      expect(strongCsv?.importOnly).toBe(true);

      // Cronometer CSV: import only
      const cronometerCsv = result.find((p: { id: string }) => p.id === "cronometer-csv");
      expect(cronometerCsv?.importOnly).toBe(true);
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
      });

      const result = await caller.providers();
      expect(result).toHaveLength(1);
      expect(result[0]?.needsOAuth).toBe(false);
    });
  });

  describe("triggerSync", () => {
    it("enqueues one sync job per configured provider when providerId is omitted", async () => {
      mockGetSyncProviders.mockReturnValue([
        { id: "strava", name: "Strava", validate: () => null },
        { id: "wahoo", name: "Wahoo", validate: () => null },
        { id: "peloton", name: "Peloton", validate: () => "Missing credentials" },
      ]);
      mockAdd
        .mockResolvedValueOnce({ id: "job-strava" })
        .mockResolvedValueOnce({ id: "job-wahoo" });

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });

      const result = await caller.triggerSync({});
      expect(result.jobId).toBe("job-strava");
      expect(result.jobIds).toEqual(["job-strava", "job-wahoo"]);
      expect(result.providerJobs).toEqual([
        { providerId: "strava", jobId: "job-strava" },
        { providerId: "wahoo", jobId: "job-wahoo" },
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

    it("excludes import-only providers from sync-all fan-out", async () => {
      mockGetSyncProviders.mockReturnValue([
        { id: "strava", name: "Strava", validate: () => null },
      ]);
      mockAdd.mockResolvedValueOnce({ id: "job-strava" });

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });

      const result = await caller.triggerSync({});
      expect(result.providerJobs).toEqual([{ providerId: "strava", jobId: "job-strava" }]);
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
      });

      const result = await caller.triggerSync({ providerId: "wahoo" });
      expect(result.jobId).toBe("job-123");
      expect(result.jobIds).toEqual(["job-123"]);
      expect(result.providerJobs).toEqual([{ providerId: "wahoo", jobId: "job-123" }]);
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
      });

      // Should find wahoo specifically, not just the first provider
      const result = await caller.triggerSync({ providerId: "wahoo" });
      expect(result.jobId).toBe("job-123");
    });

    it("reuses the sync queue across calls", async () => {
      const { createSyncQueue } = await import("dofek/jobs/queues");
      mockGetSyncProviders.mockReturnValue([{ id: "wahoo", name: "Wahoo", validate: () => null }]);

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });

      await caller.triggerSync({});
      await caller.triggerSync({});

      // Queue should be created at most once (lazy singleton)
      expect(vi.mocked(createSyncQueue).mock.calls.length).toBeLessThanOrEqual(1);
    });

    it("throws for unknown provider", async () => {
      mockGetAllProviders.mockReturnValue([]);
      mockGetSyncProviders.mockReturnValue([]);

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
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
      });

      await expect(caller.triggerSync({ providerId: "wahoo" })).rejects.toThrow(
        "Provider not configured: Missing API key",
      );
    });

    it("generates fallback jobId when BullMQ returns no id", async () => {
      mockAdd.mockResolvedValueOnce({ id: undefined });
      mockGetSyncProviders.mockReturnValue([{ id: "wahoo", name: "Wahoo", validate: () => null }]);

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
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
      });

      const result = await caller.syncStatus({ jobId: "missing-job" });
      expect(result).toBeNull();
    });

    it("returns null when Redis is unavailable", async () => {
      mockGetJob.mockRejectedValueOnce(new Error("Redis connection refused"));

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
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
      });

      const result = await caller.syncStatus({ jobId: "bad-data-job" });
      expect(result).toBeNull();
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
      });

      const result = await caller.activeSyncs();
      expect(result).toHaveLength(1);
      expect(result[0]?.jobId).toBe("job-1");
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
      });

      const result = await caller.activeSyncs();
      expect(result[0]?.jobId).toMatch(/^job-\d+$/);
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
      });

      const result = await caller.activeSyncs();
      expect(result).toHaveLength(1);
      expect(result[0]?.jobId).toBe("job-good");
    });
  });

  describe("providerStats", () => {
    it("maps database rows to provider stats", async () => {
      const caller = createCaller({
        db: {
          execute: vi.fn().mockResolvedValue([
            {
              provider_id: "wahoo",
              activities: "10",
              daily_metrics: "5",
              sleep_sessions: "3",
              body_measurements: "2",
              food_entries: "0",
              health_events: "1",
              metric_stream: "100",
              nutrition_daily: "7",
              lab_results: "4",
              journal_entries: "6",
            },
          ]),
        },
        userId: "user-1",
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
          labResults: 4,
          journalEntries: 6,
        },
      ]);
    });

    it("returns empty array when no providers", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });

      const result = await caller.providerStats();
      expect(result).toEqual([]);
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
      });

      const result = await caller.logs({});
      expect(result).toHaveLength(1);
      expect(result[0]?.errorMessage).toBe(REDACTED_ERROR_MESSAGE);
    });
  });
});
