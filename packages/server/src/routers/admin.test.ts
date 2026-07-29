import { describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{ db: unknown; userId: string | null; timezone: string; sensorStore?: unknown }>()
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

vi.mock("dofek/admin/provider-rate-limit-status", () => ({
  getProviderRateLimitStatusFromRedis: vi.fn(async () => [
    {
      providerId: "strava",
      scope: "provider",
      userId: null,
      syncTier: "realtime",
      concurrency: 2,
      queueLimiterMax: 90,
      queueLimiterDurationMs: 900_000,
      defaultThrottleMs: 10_000,
      throttleMs: 8_000,
      inferredBudget: 35,
      observedCooldownSeconds: 900,
      requestCount: 12,
      windowStartMs: Date.now(),
      stravaShortUsage: 42,
      stravaShortLimit: 100,
      stravaDailyUsage: 120,
      stravaDailyLimit: 1_000,
      cooldownExpiresAt: null,
      consecutiveHits: null,
      hasLiveState: true,
    },
  ]),
}));

import { adminRouter } from "./admin.ts";

const createCaller = createTestCallerFactory(adminRouter);

function makeCaller(
  execute: ReturnType<typeof vi.fn>,
  sensorQuery = vi.fn().mockResolvedValue([]),
  timezone = "UTC",
) {
  return createCaller({
    db: { execute },
    sensorStore: { query: sensorQuery },
    userId: "admin-1",
    timezone,
  });
}

function getSqlText(query: unknown): string {
  if (typeof query !== "object" || query === null || !("queryChunks" in query)) {
    return "";
  }
  const queryChunks = query.queryChunks;
  if (!Array.isArray(queryChunks)) {
    return "";
  }
  return queryChunks
    .map((chunk) => {
      if (typeof chunk === "string") {
        return chunk;
      }
      if (typeof chunk !== "object" || chunk === null || !("value" in chunk)) {
        return "";
      }
      const value = chunk.value;
      return Array.isArray(value) ? value.join("") : "";
    })
    .join("");
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
      expect(result).toEqual([
        { table_name: "activity", row_count: "1000" },
        { table_name: "user_profile", row_count: "5" },
      ]);
    });

    it("uses catalog estimates instead of live table counts", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      const caller = makeCaller(execute);

      await caller.overview();

      const sqlText = getSqlText(execute.mock.calls[0]?.[0]);
      expect(sqlText).toContain("pg_class");
      expect(sqlText).toContain("reltuples");
      expect(sqlText).not.toContain("COUNT(*)");
    });

    it("includes supplement dose events in the catalog overview", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      const caller = makeCaller(execute);

      await caller.overview();

      expect(getSqlText(execute.mock.calls[0]?.[0])).toContain("supplement_dose_event");
    });

    it("uses chunk estimates for metric stream hypertable counts", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      const caller = makeCaller(execute);

      await caller.overview();

      const sqlText = getSqlText(execute.mock.calls[0]?.[0]);
      expect(sqlText).toContain("metric_stream_chunk_estimates");
      expect(sqlText).toContain("pg_inherits");
      expect(sqlText).toContain("parent_class.relname = 'metric_stream'");
      expect(sqlText).toContain(
        "GREATEST(base_estimates.row_count, metric_stream_chunk_estimates.row_count)",
      );
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
    it("returns profile, flags, billing, access, Stripe links, accounts, providers, and sessions for a user", async () => {
      const execute = vi.fn();
      execute.mockResolvedValueOnce([
        {
          id: "00000000-0000-0000-0000-000000000001",
          name: "Test",
          email: "test@test.com",
          birth_date: null,
          is_admin: false,
          created_at: "2024-01-01T00:00:00Z",
          updated_at: "2024-01-02T00:00:00Z",
        },
      ]);
      execute.mockResolvedValueOnce([{ value: true }]);
      execute.mockResolvedValueOnce([
        {
          user_id: "00000000-0000-0000-0000-000000000001",
          stripe_customer_id: "cus_123",
          stripe_subscription_id: "sub_123",
          stripe_subscription_status: "active",
          stripe_current_period_end: "2026-05-01T00:00:00Z",
          paid_grant_reason: null,
          created_at: "2024-01-03T00:00:00Z",
          updated_at: "2024-01-04T00:00:00Z",
        },
      ]);
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
      expect(result.profile.name).toBe("Test");
      expect(result.flags.providerGuideDismissed).toBe(true);
      expect(result.billing?.stripe_customer_id).toBe("cus_123");
      expect(result.billing?.stripe_subscription_status).toBe("active");
      expect(result.access).toEqual({
        kind: "full",
        paid: true,
        reason: "stripe_subscription",
      });
      expect(result.stripeLinks).toEqual({
        customer: "https://dashboard.stripe.com/customers/cus_123",
        subscription: "https://dashboard.stripe.com/subscriptions/sub_123",
      });
      expect(result.accounts).toHaveLength(1);
      expect(result.providers).toHaveLength(1);
      expect(result.sessions).toHaveLength(1);
      expect(result.accounts[0]?.auth_provider).toBe("google");
      expect(result.providers[0]?.id).toBe("whoop");
    });

    it("returns unpaid access and null Stripe links when billing is absent", async () => {
      const execute = vi.fn();
      execute.mockResolvedValueOnce([
        {
          id: "00000000-0000-0000-0000-000000000001",
          name: "Test",
          email: "test@test.com",
          birth_date: null,
          is_admin: false,
          created_at: "2026-07-21T01:30:00.000Z",
          updated_at: "2026-07-21T01:30:00.000Z",
        },
      ]);
      execute.mockResolvedValueOnce([]);
      execute.mockResolvedValueOnce([]);
      execute.mockResolvedValueOnce([]);
      execute.mockResolvedValueOnce([]);
      execute.mockResolvedValueOnce([]);
      const caller = makeCaller(execute, vi.fn().mockResolvedValue([]), "America/Los_Angeles");

      const result = await caller.userDetail({
        userId: "00000000-0000-0000-0000-000000000001",
      });

      expect(result.flags.providerGuideDismissed).toBe(false);
      expect(result.billing).toBeNull();
      expect(result.access).toEqual({
        kind: "limited",
        paid: false,
        reason: "free_signup_week",
        startDate: "2026-07-20",
        endDateExclusive: "2026-07-27",
      });
      expect(result.stripeLinks).toEqual({
        customer: null,
        subscription: null,
      });
    });

    it("uses paid grant reason from billing when present", async () => {
      const execute = vi.fn();
      execute.mockResolvedValueOnce([
        {
          id: "00000000-0000-0000-0000-000000000001",
          name: "Test",
          email: "test@test.com",
          birth_date: null,
          is_admin: false,
          created_at: "2026-04-10T18:30:00.000Z",
          updated_at: "2026-04-10T18:30:00.000Z",
        },
      ]);
      execute.mockResolvedValueOnce([{ value: false }]);
      execute.mockResolvedValueOnce([
        {
          user_id: "00000000-0000-0000-0000-000000000001",
          stripe_customer_id: null,
          stripe_subscription_id: null,
          stripe_subscription_status: null,
          stripe_current_period_end: null,
          paid_grant_reason: "existing_account",
          created_at: "2026-04-10T18:30:00.000Z",
          updated_at: "2026-04-10T18:30:00.000Z",
        },
      ]);
      execute.mockResolvedValueOnce([]);
      execute.mockResolvedValueOnce([]);
      execute.mockResolvedValueOnce([]);
      const caller = makeCaller(execute);

      const result = await caller.userDetail({
        userId: "00000000-0000-0000-0000-000000000001",
      });

      expect(result.flags.providerGuideDismissed).toBe(false);
      expect(result.access).toEqual({ kind: "full", paid: true, reason: "paid_grant" });
      expect(result.stripeLinks).toEqual({
        customer: null,
        subscription: null,
      });
    });

    it("throws when the target user does not exist", async () => {
      const caller = makeCaller(vi.fn().mockResolvedValueOnce([]));

      await expect(
        caller.userDetail({ userId: "00000000-0000-0000-0000-000000000099" }),
      ).rejects.toThrow("User not found");
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

  describe("setProviderGuideDismissed", () => {
    it("stores provider guide dismissal for the target user", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      const caller = makeCaller(execute);

      const result = await caller.setProviderGuideDismissed({
        userId: "00000000-0000-0000-0000-000000000002",
        dismissed: true,
      });

      expect(result).toEqual({ ok: true });
      expect(execute).toHaveBeenCalledOnce();
      expect(getSqlText(execute.mock.calls[0]?.[0])).toContain("fitness.user_settings");
      expect(getSqlText(execute.mock.calls[0]?.[0])).toContain("ON CONFLICT");
    });
  });

  describe("setPaidGrant", () => {
    it("stores an admin grant when free access is enabled", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      const caller = makeCaller(execute);

      const result = await caller.setPaidGrant({
        userId: "00000000-0000-0000-0000-000000000002",
        enabled: true,
      });

      expect(result).toEqual({ ok: true });
      expect(execute).toHaveBeenCalledOnce();
      expect(getSqlText(execute.mock.calls[0]?.[0])).toContain("fitness.user_billing");
      expect(getSqlText(execute.mock.calls[0]?.[0])).toContain("paid_grant_reason");
    });

    it("clears only the local paid grant when free access is disabled", async () => {
      const execute = vi.fn().mockResolvedValue([]);
      const caller = makeCaller(execute);

      const result = await caller.setPaidGrant({
        userId: "00000000-0000-0000-0000-000000000002",
        enabled: false,
      });

      expect(result).toEqual({ ok: true });
      expect(execute).toHaveBeenCalledOnce();
      const queryText = getSqlText(execute.mock.calls[0]?.[0]);
      expect(queryText).toContain("paid_grant_reason = null");
      expect(queryText).not.toContain("stripe_customer_id");
      expect(queryText).not.toContain("stripe_subscription_id");
      expect(queryText).not.toContain("stripe_subscription_status");
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
            record_count: 10,
            error_message: null,
            duration_ms: 60000,
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

    it("returns zero total when count query returns empty", async () => {
      const execute = mockPaginatedExecute([], []);
      const caller = makeCaller(execute);
      const result = await caller.syncLogs({ limit: 50, offset: 0 });
      expect(result.rows).toHaveLength(0);
      expect(result.total).toBe(0);
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
            canonical_type: "running",
            name: "Morning Run",
            started_at: "2024-01-01T08:00:00Z",
            duration_seconds: "1800",
            source_name: "garmin",
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

    it("returns zero total when count query returns empty", async () => {
      const execute = mockPaginatedExecute([], []);
      const caller = makeCaller(execute);
      const result = await caller.activities({ limit: 50, offset: 0 });
      expect(result.rows).toHaveLength(0);
      expect(result.total).toBe(0);
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
            source_name: "whoop",
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

    it("returns zero total when count query returns empty", async () => {
      const execute = mockPaginatedExecute([], []);
      const caller = makeCaller(execute);
      const result = await caller.sleepSessions({ limit: 50, offset: 0 });
      expect(result.rows).toHaveLength(0);
      expect(result.total).toBe(0);
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

    it("returns zero total when count query returns empty", async () => {
      const execute = mockPaginatedExecute([], []);
      const caller = makeCaller(execute);
      const result = await caller.sessions({ limit: 50, offset: 0 });
      expect(result.rows).toHaveLength(0);
      expect(result.total).toBe(0);
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
            food_name: "Chicken Breast",
            calories: "250",
            protein_g: "40",
            meal: "lunch",
            logged_at: "2024-01-01T12:00:00Z",
            provider_id: "fatsecret",
          },
        ],
        [{ count: "1000" }],
      );
      const caller = makeCaller(execute);
      const result = await caller.foodEntries({ limit: 50, offset: 0 });
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.food_name).toBe("Chicken Breast");
      expect(result.total).toBe("1000");
    });

    it("returns zero total when count query returns empty", async () => {
      const execute = mockPaginatedExecute([], []);
      const caller = makeCaller(execute);
      const result = await caller.foodEntries({ limit: 50, offset: 0 });
      expect(result.rows).toHaveLength(0);
      expect(result.total).toBe(0);
    });
  });

  describe("bodyMeasurements", () => {
    it("returns paginated body measurements with total count", async () => {
      const sensorQuery = vi
        .fn()
        .mockResolvedValueOnce([
          {
            id: "bm-1",
            user_id: "user-1",
            user_name: "Test",
            recorded_at: "2024-01-01T07:00:00Z",
            source_name: "withings",
            provider_id: "withings",
          },
        ])
        .mockResolvedValueOnce([{ count: "300" }]);
      const caller = makeCaller(vi.fn(), sensorQuery);
      const result = await caller.bodyMeasurements({ limit: 50, offset: 0 });
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]?.provider_id).toBe("withings");
      expect(result.total).toBe("300");
      expect(sensorQuery.mock.calls[0]?.[1]).toContain("FROM analytics.v_body_measurement");
    });

    it("returns zero total when count query returns empty", async () => {
      const sensorQuery = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([]);
      const caller = makeCaller(vi.fn(), sensorQuery);
      const result = await caller.bodyMeasurements({ limit: 50, offset: 0 });
      expect(result.rows).toHaveLength(0);
      expect(result.total).toBe(0);
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
            source_name: "whoop",
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

    it("returns zero total when count query returns empty", async () => {
      const execute = mockPaginatedExecute([], []);
      const caller = makeCaller(execute);
      const result = await caller.dailyMetrics({ limit: 50, offset: 0 });
      expect(result.rows).toHaveLength(0);
      expect(result.total).toBe(0);
    });
  });

  describe("oauthTokens", () => {
    it("returns token metadata without secrets", async () => {
      const rows = [
        {
          user_id: "user-1",
          user_name: "Test",
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
    it("returns provider sync stats with all fields", async () => {
      const rows = [
        {
          provider_id: "whoop",
          total: 50,
          succeeded: 48,
          failed: 2,
          last_sync: "2024-01-01T00:00:00Z",
        },
      ];
      const caller = makeCaller(vi.fn().mockResolvedValue(rows));
      const result = await caller.syncHealth();
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        provider_id: "whoop",
        total: 50,
        succeeded: 48,
        failed: 2,
        last_sync: "2024-01-01T00:00:00Z",
      });
    });
  });

  describe("rateLimits", () => {
    it("returns live provider rate-limit estimations", async () => {
      const caller = makeCaller(vi.fn());
      const result = await caller.rateLimits();
      expect(result).toHaveLength(1);
      expect(result[0]?.providerId).toBe("strava");
      expect(result[0]?.inferredBudget).toBe(35);
    });
  });
});
