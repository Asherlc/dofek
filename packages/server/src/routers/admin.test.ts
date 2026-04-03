import { describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{ db: unknown; userId: string | null; timezone: string }>()
    .create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
    adminProcedure: trpc.procedure,
    cachedProtectedQuery: () => trpc.procedure,
    cachedProtectedQueryLight: () => trpc.procedure,
    CacheTTL: { SHORT: 120_000, MEDIUM: 600_000, LONG: 3_600_000 },
  };
});

vi.mock("../lib/typed-sql.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/typed-sql.ts")>();
  return {
    ...original,
    executeWithSchema: vi.fn(
      async (
        db: { execute: (q: unknown) => Promise<unknown[]> },
        _schema: unknown,
        query: unknown,
      ) => db.execute(query),
    ),
  };
});

import { adminRouter } from "./admin.ts";

const createCaller = createTestCallerFactory(adminRouter);

function makeCaller(execute: ReturnType<typeof vi.fn>) {
  return createCaller({ db: { execute }, userId: "admin-1", timezone: "UTC" });
}

/** Helper: mock db.execute that returns different values on successive calls */
function mockPaginatedExecute(rows: unknown[], countRows: unknown[]) {
  const execute = vi.fn();
  execute.mockResolvedValueOnce(rows);
  execute.mockResolvedValueOnce(countRows);
  return execute;
}

describe("adminRouter", () => {
  describe("overview", () => {
    it("returns table row counts", async () => {
      const rows = [
        { table_name: "user_profile", row_count: "5" },
        { table_name: "activity", row_count: "1000" },
      ];
      const caller = makeCaller(vi.fn().mockResolvedValue(rows));
      const result = await caller.overview();
      expect(result).toEqual(rows);
    });
  });

  describe("users", () => {
    it("returns user profiles", async () => {
      const rows = [
        {
          id: "user-1",
          name: "Test",
          email: "test@test.com",
          birth_date: null,
          is_admin: false,
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-01T00:00:00Z",
        },
      ];
      const caller = makeCaller(vi.fn().mockResolvedValue(rows));
      const result = await caller.users();
      expect(result).toHaveLength(1);
      expect(result[0]?.name).toBe("Test");
    });
  });

  describe("userDetail", () => {
    it("returns accounts, providers, and sessions for a user", async () => {
      const execute = vi.fn();
      execute.mockResolvedValueOnce([
        {
          id: "acc-1",
          auth_provider: "google",
          provider_account_id: "goog-123",
          email: "test@test.com",
          name: "Test",
          created_at: "2024-01-01T00:00:00Z",
        },
      ]);
      execute.mockResolvedValueOnce([
        { id: "whoop", name: "WHOOP", created_at: "2024-01-01T00:00:00Z" },
      ]);
      execute.mockResolvedValueOnce([
        {
          id: "sess-1",
          created_at: "2024-01-01T00:00:00Z",
          expires_at: "2024-02-01T00:00:00Z",
        },
      ]);
      const caller = makeCaller(execute);
      const result = await caller.userDetail({
        userId: "00000000-0000-0000-0000-000000000001",
      });
      expect(result.accounts).toHaveLength(1);
      expect(result.providers).toHaveLength(1);
      expect(result.sessions).toHaveLength(1);
      expect(result.accounts[0]?.auth_provider).toBe("google");
      expect(result.providers[0]?.id).toBe("whoop");
    });
  });

  describe("setAdmin", () => {
    it("updates admin status", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      const caller = makeCaller(execute);
      const result = await caller.setAdmin({
        userId: "00000000-0000-0000-0000-000000000002",
        isAdmin: true,
      });
      expect(result).toEqual({ ok: true });
      expect(execute).toHaveBeenCalledOnce();
    });
  });

  describe("syncLogs", () => {
    it("returns paginated sync logs with total count", async () => {
      const execute = mockPaginatedExecute(
        [
          {
            id: "log-1",
            provider_id: "whoop",
            user_id: "user-1",
            user_name: "Test",
            data_type: "sleep",
            status: "success",
            record_count: "10",
            error_message: null,
            duration_ms: "60000",
            synced_at: "2024-01-01T00:00:00Z",
          },
        ],
        [{ count: "100" }],
      );
      const caller = makeCaller(execute);
      const result = await caller.syncLogs({ limit: 50, offset: 0 });
      expect(result.rows).toHaveLength(1);
      expect(result.total).toBe("100");
    });
  });

  describe("activities", () => {
    it("returns paginated activities with total count", async () => {
      const execute = mockPaginatedExecute(
        [
          {
            id: "act-1",
            user_id: "user-1",
            user_name: "Test",
            provider_id: "garmin",
            activity_type: "running",
            name: "Morning Run",
            started_at: "2024-01-01T08:00:00Z",
            duration_seconds: "1800",
            source: "garmin",
          },
        ],
        [{ count: "500" }],
      );
      const caller = makeCaller(execute);
      const result = await caller.activities({ limit: 50, offset: 0 });
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.name).toBe("Morning Run");
      expect(result.total).toBe("500");
    });
  });

  describe("sleepSessions", () => {
    it("returns paginated sleep sessions with total count", async () => {
      const execute = mockPaginatedExecute(
        [
          {
            id: "sleep-1",
            user_id: "user-1",
            user_name: "Test",
            provider_id: "whoop",
            started_at: "2024-01-01T22:00:00Z",
            ended_at: "2024-01-02T06:00:00Z",
            sleep_type: "night",
            source: "whoop",
          },
        ],
        [{ count: "200" }],
      );
      const caller = makeCaller(execute);
      const result = await caller.sleepSessions({ limit: 50, offset: 0 });
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.sleep_type).toBe("night");
      expect(result.total).toBe("200");
    });
  });

  describe("sessions", () => {
    it("returns paginated sessions with expiry status", async () => {
      const execute = mockPaginatedExecute(
        [
          {
            id: "sess-1",
            user_id: "user-1",
            user_name: "Test",
            created_at: "2024-01-01T00:00:00Z",
            expires_at: "2024-02-01T00:00:00Z",
            is_expired: false,
          },
        ],
        [{ count: "10" }],
      );
      const caller = makeCaller(execute);
      const result = await caller.sessions({ limit: 50, offset: 0 });
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.is_expired).toBe(false);
      expect(result.total).toBe("10");
    });
  });

  describe("deleteSession", () => {
    it("deletes a session", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      const caller = makeCaller(execute);
      const result = await caller.deleteSession({ sessionId: "session-abc" });
      expect(result).toEqual({ ok: true });
      expect(execute).toHaveBeenCalledOnce();
    });
  });

  describe("foodEntries", () => {
    it("returns paginated food entries with total count", async () => {
      const execute = mockPaginatedExecute(
        [
          {
            id: "food-1",
            user_id: "user-1",
            user_name: "Test",
            name: "Chicken Breast",
            calories: "250",
            protein_g: "40",
            meal: "lunch",
            eaten_at: "2024-01-01T12:00:00Z",
            source: "slack",
          },
        ],
        [{ count: "1000" }],
      );
      const caller = makeCaller(execute);
      const result = await caller.foodEntries({ limit: 50, offset: 0 });
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.name).toBe("Chicken Breast");
      expect(result.total).toBe("1000");
    });
  });

  describe("bodyMeasurements", () => {
    it("returns paginated body measurements with total count", async () => {
      const execute = mockPaginatedExecute(
        [
          {
            id: "bm-1",
            user_id: "user-1",
            user_name: "Test",
            measured_at: "2024-01-01T07:00:00Z",
            source: "withings",
            provider_id: "withings",
          },
        ],
        [{ count: "300" }],
      );
      const caller = makeCaller(execute);
      const result = await caller.bodyMeasurements({ limit: 50, offset: 0 });
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.provider_id).toBe("withings");
      expect(result.total).toBe("300");
    });
  });

  describe("dailyMetrics", () => {
    it("returns paginated daily metrics with total count", async () => {
      const execute = mockPaginatedExecute(
        [
          {
            id: "dm-1",
            user_id: "user-1",
            user_name: "Test",
            date: "2024-01-01",
            provider_id: "whoop",
            source: "whoop",
          },
        ],
        [{ count: "365" }],
      );
      const caller = makeCaller(execute);
      const result = await caller.dailyMetrics({ limit: 50, offset: 0 });
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.date).toBe("2024-01-01");
      expect(result.total).toBe("365");
    });
  });

  describe("oauthTokens", () => {
    it("returns token metadata without secrets", async () => {
      const rows = [
        {
          provider_id: "whoop",
          expires_at: "2025-01-01T00:00:00Z",
          scopes: "read:recovery read:sleep",
          updated_at: "2024-01-01T00:00:00Z",
        },
      ];
      const caller = makeCaller(vi.fn().mockResolvedValue(rows));
      const result = await caller.oauthTokens();
      expect(result).toHaveLength(1);
      expect(result[0]?.provider_id).toBe("whoop");
      expect(result[0]?.scopes).toBe("read:recovery read:sleep");
    });
  });

  describe("syncHealth", () => {
    it("returns provider sync stats", async () => {
      const rows = [
        {
          provider_id: "whoop",
          total: "50",
          succeeded: "48",
          failed: "2",
          last_sync: "2024-01-01T00:00:00Z",
        },
      ];
      const caller = makeCaller(vi.fn().mockResolvedValue(rows));
      const result = await caller.syncHealth();
      expect(result).toHaveLength(1);
      expect(result[0]?.provider_id).toBe("whoop");
    });
  });
});
