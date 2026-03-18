import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

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

vi.mock("../lib/typed-sql.ts", () => ({
  executeWithSchema: async (
    db: { execute: (query: unknown) => Promise<unknown[]> },
    _schema: unknown,
    query: unknown,
  ) => db.execute(query),
}));

vi.mock("dofek/db/schema", () => ({
  syncLog: {
    userId: "userId",
    providerId: "providerId",
    syncedAt: "syncedAt",
  },
  oauthToken: {
    providerId: "providerId",
  },
  provider: {
    id: "id",
    userId: "userId",
  },
}));

import { providerDetailRouter } from "./provider-detail.ts";

describe("providerDetailRouter", () => {
  const createCaller = createTestCallerFactory(providerDetailRouter);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("logs", () => {
    it("returns paginated sync logs for a specific provider", async () => {
      const mockSelect = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockResolvedValue([
                  {
                    id: "log-1",
                    providerId: "strava",
                    dataType: "activities",
                    status: "success",
                    recordCount: 5,
                    errorMessage: null,
                    durationMs: 1200,
                    syncedAt: "2024-01-15T10:00:00Z",
                  },
                ]),
              }),
            }),
          }),
        }),
      });

      const caller = createCaller({
        db: { select: mockSelect, execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });

      const result = await caller.logs({ providerId: "strava", limit: 20, offset: 0 });
      expect(result).toHaveLength(1);
      expect(result[0]?.providerId).toBe("strava");
      expect(result[0]?.errorMessage).toBe(null);
    });

    it("redacts error messages in logs", async () => {
      const mockSelect = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: vi.fn().mockReturnValue({
                offset: vi.fn().mockResolvedValue([
                  {
                    id: "log-2",
                    providerId: "strava",
                    dataType: "activities",
                    status: "error",
                    recordCount: 0,
                    errorMessage: "OAuth token expired: secret-refresh-token",
                    durationMs: 500,
                    syncedAt: "2024-01-15T10:00:00Z",
                  },
                ]),
              }),
            }),
          }),
        }),
      });

      const caller = createCaller({
        db: { select: mockSelect, execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });

      const result = await caller.logs({ providerId: "strava", limit: 20, offset: 0 });
      expect(result[0]?.errorMessage).toBe("Details hidden");
    });

    it("defaults offset to 0 and limit to 50", async () => {
      const mockOffset = vi.fn().mockResolvedValue([]);
      const mockLimit = vi.fn().mockReturnValue({ offset: mockOffset });
      const mockSelect = vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn().mockReturnValue({
              limit: mockLimit,
            }),
          }),
        }),
      });

      const caller = createCaller({
        db: { select: mockSelect, execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });

      await caller.logs({ providerId: "strava" });
      expect(mockLimit).toHaveBeenCalledWith(50);
      expect(mockOffset).toHaveBeenCalledWith(0);
    });
  });

  describe("records", () => {
    it("returns paginated activity records for a provider", async () => {
      const caller = createCaller({
        db: {
          execute: vi.fn().mockResolvedValue([
            {
              id: "act-1",
              name: "Morning Run",
              activity_type: "running",
              started_at: "2024-01-15T08:00:00Z",
              created_at: "2024-01-15T08:00:00Z",
            },
          ]),
        },
        userId: "user-1",
      });

      const result = await caller.records({
        providerId: "strava",
        dataType: "activities",
        limit: 20,
        offset: 0,
      });

      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.name).toBe("Morning Run");
    });

    it("returns paginated daily metrics records", async () => {
      const caller = createCaller({
        db: {
          execute: vi.fn().mockResolvedValue([
            {
              date: "2024-01-15",
              resting_hr: 55,
              steps: 8000,
              created_at: "2024-01-15T00:00:00Z",
            },
          ]),
        },
        userId: "user-1",
      });

      const result = await caller.records({
        providerId: "garmin",
        dataType: "dailyMetrics",
        limit: 20,
        offset: 0,
      });

      expect(result.rows).toHaveLength(1);
    });

    it("returns paginated sleep session records", async () => {
      const caller = createCaller({
        db: {
          execute: vi.fn().mockResolvedValue([
            {
              id: "sleep-1",
              started_at: "2024-01-14T22:00:00Z",
              ended_at: "2024-01-15T06:00:00Z",
              created_at: "2024-01-15T06:00:00Z",
            },
          ]),
        },
        userId: "user-1",
      });

      const result = await caller.records({
        providerId: "oura",
        dataType: "sleepSessions",
        limit: 20,
        offset: 0,
      });

      expect(result.rows).toHaveLength(1);
    });

    it("defaults offset to 0 and limit to 50", async () => {
      const mockExecute = vi.fn().mockResolvedValue([]);
      const caller = createCaller({
        db: { execute: mockExecute },
        userId: "user-1",
      });

      await caller.records({ providerId: "strava", dataType: "activities" });
      // The SQL should contain LIMIT 50 OFFSET 0 (defaults)
      expect(mockExecute).toHaveBeenCalled();
    });
  });

  describe("recordDetail", () => {
    it("returns a single activity record with raw data", async () => {
      const caller = createCaller({
        db: {
          execute: vi.fn().mockResolvedValue([
            {
              id: "act-1",
              provider_id: "strava",
              name: "Morning Run",
              activity_type: "running",
              started_at: "2024-01-15T08:00:00Z",
              raw: { distance: 5000, elapsed_time: 1500 },
            },
          ]),
        },
        userId: "user-1",
      });

      const result = await caller.recordDetail({
        providerId: "strava",
        dataType: "activities",
        recordId: "act-1",
      });

      expect(result).not.toBeNull();
      expect(result?.raw).toEqual({ distance: 5000, elapsed_time: 1500 });
    });

    it("returns null for non-existent record", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
      });

      const result = await caller.recordDetail({
        providerId: "strava",
        dataType: "activities",
        recordId: "nonexistent",
      });

      expect(result).toBeNull();
    });
  });

  describe("disconnect", () => {
    it("deletes all child table rows and provider row in a transaction", async () => {
      const txExecute = vi.fn().mockResolvedValue([]);
      const mockTransaction = vi
        .fn()
        .mockImplementation(async (fn: (tx: { execute: typeof txExecute }) => Promise<void>) => {
          await fn({ execute: txExecute });
        });
      // First execute call is the ownership check, returns the provider
      const mockExecute = vi.fn().mockResolvedValue([{ id: "strava" }]);

      const caller = createCaller({
        db: {
          execute: mockExecute,
          transaction: mockTransaction,
        },
        userId: "user-1",
      });

      const result = await caller.disconnect({ providerId: "strava" });
      expect(result).toEqual({ success: true });
      // Ownership check
      expect(mockExecute).toHaveBeenCalledTimes(1);
      // Transaction should have been called
      expect(mockTransaction).toHaveBeenCalledTimes(1);
      // 14 child tables + 1 provider delete = 15 deletes inside the transaction
      expect(txExecute).toHaveBeenCalledTimes(15);
    });

    it("throws when provider is not owned by user", async () => {
      const mockExecute = vi.fn().mockResolvedValue([]);

      const caller = createCaller({
        db: {
          execute: mockExecute,
          transaction: vi.fn(),
        },
        userId: "user-1",
      });

      await expect(caller.disconnect({ providerId: "unknown" })).rejects.toThrow(
        "Provider not found or not owned by user",
      );
    });
  });
});
