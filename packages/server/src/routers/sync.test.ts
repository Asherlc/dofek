import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

const { mockAdd, mockGetJob, mockGetAllProviders, mockRegisterProvider } = vi.hoisted(() => ({
  mockAdd: vi.fn().mockResolvedValue({ id: "job-123" }),
  mockGetJob: vi.fn(),
  mockGetAllProviders: vi.fn(() => []),
  mockRegisterProvider: vi.fn(),
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
  })),
}));

vi.mock("dofek/providers/registry", () => ({
  getAllProviders: mockGetAllProviders,
  registerProvider: mockRegisterProvider,
}));

vi.mock("../lib/start-worker.ts", () => ({
  startWorker: vi.fn(),
}));

vi.mock("../logger.ts", () => ({
  getSystemLogs: vi.fn((limit: number) => [`log1`, `log2`].slice(0, limit)),
  logger: { warn: vi.fn(), info: vi.fn() },
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

// Mock schema and drizzle-orm for logs query
vi.mock("dofek/db/schema", () => ({
  syncLog: {
    userId: "userId",
    syncedAt: "syncedAt",
  },
}));

import { ensureProvidersRegistered, syncRouter } from "./sync.ts";

describe("syncRouter", () => {
  const createCaller = createTestCallerFactory(syncRouter);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("ensureProvidersRegistered", () => {
    it("returns a promise", () => {
      const result = ensureProvidersRegistered();
      expect(result).toBeInstanceOf(Promise);
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

      expect(result).toHaveLength(4);

      // Wahoo: enabled, needs OAuth, authorized (has token)
      const wahoo = result.find((p: { id: string }) => p.id === "wahoo");
      expect(wahoo?.enabled).toBe(true);
      expect(wahoo?.needsOAuth).toBe(true);
      expect(wahoo?.authorized).toBe(true);
      expect(wahoo?.lastSyncedAt).toBe("2024-01-01");
      expect(wahoo?.importOnly).toBe(false);

      // Peloton: not enabled (validation error), no OAuth needed
      const peloton = result.find((p: { id: string }) => p.id === "peloton");
      expect(peloton?.enabled).toBe(false);
      expect(peloton?.error).toBe("Missing credentials");

      // WHOOP: needs custom auth, not authorized (no token)
      const whoop = result.find((p: { id: string }) => p.id === "whoop");
      expect(whoop?.needsCustomAuth).toBe(true);
      expect(whoop?.authorized).toBe(false);

      // Strong CSV: import only
      const strongCsv = result.find((p: { id: string }) => p.id === "strong-csv");
      expect(strongCsv?.importOnly).toBe(true);
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
    it("enqueues a sync job and returns jobId", async () => {
      mockGetAllProviders.mockReturnValue([]);

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });

      const result = await caller.triggerSync({});
      expect(result.jobId).toBe("job-123");
      expect(mockAdd).toHaveBeenCalledWith("sync", {
        providerId: undefined,
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
    });

    it("throws for unknown provider", async () => {
      mockGetAllProviders.mockReturnValue([]);

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
      mockGetAllProviders.mockReturnValue([]);

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });

      const result = await caller.triggerSync({});
      expect(result.jobId).toMatch(/^job-\d+$/);
    });
  });

  describe("syncStatus", () => {
    it("returns null for empty jobId", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });

      const result = await caller.syncStatus({ jobId: "" });
      expect(result).toBeNull();
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
      expect(result?.providers).toEqual({
        wahoo: { status: "running", message: "Syncing..." },
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

  describe("systemLogs", () => {
    it("returns system logs with default limit", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });

      const result = await caller.systemLogs({});
      expect(result).toEqual(["log1", "log2"]);
    });

    it("respects limit parameter", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });

      const result = await caller.systemLogs({ limit: 1 });
      expect(result).toEqual(["log1"]);
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

  describe("logs", () => {
    it("queries sync log from database", async () => {
      const mockSelect = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi
                .fn()
                .mockResolvedValue([{ id: "log-1", providerId: "wahoo", syncedAt: "2024-01-01" }]),
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
    });
  });
});
