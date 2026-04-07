import { describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

const { mockLoggerInfo, mockLoggerError, mockCaptureException } = vi.hoisted(() => ({
  mockLoggerInfo: vi.fn(),
  mockLoggerError: vi.fn(),
  mockCaptureException: vi.fn(),
}));

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

vi.mock("whoop-whoop/client", () => ({
  WhoopClient: {
    signIn: vi.fn(),
    verifyCode: vi.fn(),
  },
}));

vi.mock("../logger.ts", () => ({
  logger: {
    info: mockLoggerInfo,
    error: mockLoggerError,
  },
}));

vi.mock("@sentry/node", () => ({
  captureException: mockCaptureException,
}));

vi.mock("dofek/db/tokens", () => ({
  ensureProvider: vi.fn(),
  saveTokens: vi.fn(),
}));

vi.mock("../lib/cache.ts", () => ({
  queryCache: { invalidateByPrefix: vi.fn() },
}));

import { trendsRouter } from "./trends.ts";
import { weeklyReportRouter } from "./weekly-report.ts";
import { whoopAuthRouter } from "./whoop-auth.ts";

// ── Trends Router ──

describe("trendsRouter", () => {
  const createCaller = createTestCallerFactory(trendsRouter);

  function makeCaller(rows: Record<string, unknown>[] = []) {
    return createCaller({
      db: { execute: vi.fn().mockResolvedValue(rows) },
      userId: "user-1",
      timezone: "UTC",
    });
  }

  describe("daily", () => {
    it("returns daily trend rows", async () => {
      const rows = [
        {
          date: "2024-01-15",
          avg_hr: 145.3,
          max_hr: 180,
          avg_power: 200.7,
          max_power: 350,
          avg_cadence: 85.2,
          avg_speed: 8.456,
          total_samples: 3600,
          hr_samples: 3500,
          power_samples: 3000,
          activity_count: 1,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.daily({ days: 365 });

      expect(result).toHaveLength(1);
      expect(result[0]?.avgHr).toBe(145.3);
      expect(result[0]?.avgSpeed).toBe(8.46); // rounded to 2 decimals
    });

    it("handles null values", async () => {
      const rows = [
        {
          date: "2024-01-15",
          avg_hr: null,
          max_hr: null,
          avg_power: null,
          max_power: null,
          avg_cadence: null,
          avg_speed: null,
          total_samples: 0,
          hr_samples: 0,
          power_samples: 0,
          activity_count: 0,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.daily({ days: 365 });

      expect(result[0]?.avgHr).toBeNull();
      expect(result[0]?.maxPower).toBeNull();
    });
  });

  describe("weekly", () => {
    it("returns weekly trend rows", async () => {
      const rows = [
        {
          period: "2024-01-15",
          avg_hr: 150,
          max_hr: 185,
          avg_power: 210,
          max_power: 380,
          avg_cadence: 88,
          avg_speed: 9.12,
          total_samples: 25000,
          hr_samples: 24000,
          power_samples: 20000,
          activity_count: 5,
        },
      ];
      const caller = makeCaller(rows);
      const result = await caller.weekly({ weeks: 52 });

      expect(result).toHaveLength(1);
      expect(result[0]?.week).toBe("2024-01-15");
      expect(result[0]?.activityCount).toBe(5);
    });
  });
});

// ── Weekly Report Router ──

describe("weeklyReportRouter", () => {
  const createCaller = createTestCallerFactory(weeklyReportRouter);

  describe("report", () => {
    it("returns empty report when no data", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.report({ weeks: 12 });

      expect(result.current).toBeNull();
      expect(result.history).toEqual([]);
    });

    it("returns report with current and history", async () => {
      const rows = [
        {
          week_start: "2024-01-08",
          total_hours: 5.5,
          activity_count: 4,
          avg_daily_load: 50,
          avg_sleep_min: 440,
          avg_resting_hr: 55,
          avg_hrv: 62,
          chronic_avg_load: 45,
          prev_3wk_avg_sleep: 430,
        },
        {
          week_start: "2024-01-15",
          total_hours: 6.2,
          activity_count: 5,
          avg_daily_load: 55,
          avg_sleep_min: 450,
          avg_resting_hr: 54,
          avg_hrv: 65,
          chronic_avg_load: 48,
          prev_3wk_avg_sleep: 440,
        },
      ];
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue(rows) },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.report({ weeks: 12 });

      expect(result.current).not.toBeNull();
      expect(result.current?.weekStart).toBe("2024-01-15");
      expect(result.history).toHaveLength(1);
      expect(result.current?.strainZone).toBeDefined();
      expect(result.current?.sleepPerformancePct).toBeGreaterThan(0);
    });
  });
});

// ── Whoop Auth Router ──

describe("whoopAuthRouter", () => {
  const createCaller = createTestCallerFactory(whoopAuthRouter);

  it("logs and reports signIn failures", async () => {
    const { WhoopClient } = await import("whoop-whoop/client");
    const error = new Error("bad sms code request");
    vi.mocked(WhoopClient.signIn).mockRejectedValueOnce(error);

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      timezone: "UTC",
    });

    await expect(caller.signIn({ username: "test@example.com", password: "pass" })).rejects.toThrow(
      "bad sms code request",
    );

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "[whoopAuth] signIn start userId=user-1 usernameDomain=example.com",
    );
    expect(mockLoggerError).toHaveBeenCalledWith(
      "[whoopAuth] signIn failed userId=user-1 message=bad sms code request",
    );
    expect(mockCaptureException).toHaveBeenCalledWith(error);
  });

  describe("signIn", () => {
    it("returns verification_required when MFA needed", async () => {
      const { WhoopClient } = await import("whoop-whoop/client");
      vi.mocked(WhoopClient.signIn).mockResolvedValueOnce({
        type: "verification_required",
        session: "cognito-session-123",
        method: "sms",
      });

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.signIn({ username: "test@example.com", password: "pass" });

      expect(result.status).toBe("verification_required");
      expect(result).toHaveProperty("challengeId");
      expect(result).toHaveProperty("method", "sms");
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        "[whoopAuth] signIn start userId=user-1 usernameDomain=example.com",
      );
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        expect.stringMatching(
          /^\[whoopAuth\] signIn verification_required userId=user-1 method=sms challengeId=whoop-/,
        ),
      );
    });

    it("returns success when no MFA required", async () => {
      const { WhoopClient } = await import("whoop-whoop/client");
      vi.mocked(WhoopClient.signIn).mockResolvedValueOnce({
        type: "success",
        token: { accessToken: "at", refreshToken: "rt", userId: 123 },
      });

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });
      const result = await caller.signIn({ username: "test@example.com", password: "pass" });

      expect(result.status).toBe("success");
      expect(result).toHaveProperty("token");
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        "[whoopAuth] signIn success userId=user-1 whoopUserId=123",
      );
    });
  });

  describe("verifyCode", () => {
    it("throws when challenge not found", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });

      await expect(
        caller.verifyCode({ challengeId: "nonexistent", code: "123456" }),
      ).rejects.toThrow("expired or not found");
    });

    it("verifies code successfully after signIn", async () => {
      const { WhoopClient } = await import("whoop-whoop/client");
      vi.mocked(WhoopClient.signIn).mockResolvedValueOnce({
        type: "verification_required",
        session: "session-xyz",
        method: "sms",
      });
      vi.mocked(WhoopClient.verifyCode).mockResolvedValueOnce({
        accessToken: "new-at",
        refreshToken: "new-rt",
        userId: 456,
      });

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });

      // Step 1: sign in to get challengeId
      const signInResult = await caller.signIn({ username: "test@example.com", password: "pass" });
      const challengeId: string = signInResult.challengeId;

      // Step 2: verify code
      const result = await caller.verifyCode({ challengeId, code: "123456" });
      expect(result.status).toBe("success");
      expect(vi.mocked(WhoopClient.verifyCode)).toHaveBeenCalledWith(
        "session-xyz",
        "123456",
        "test@example.com",
        "sms",
      );
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        expect.stringMatching(
          /^\[whoopAuth\] verifyCode lookup userId=user-1 challengeId=whoop-.* found=true$/,
        ),
      );
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        expect.stringMatching(
          /^\[whoopAuth\] verifyCode start userId=user-1 challengeId=whoop-.* method=sms$/,
        ),
      );
      expect(mockLoggerInfo).toHaveBeenCalledWith(
        expect.stringMatching(
          /^\[whoopAuth\] verifyCode success userId=user-1 challengeId=whoop-.* method=sms whoopUserId=456$/,
        ),
      );
    });

    it("logs and reports verifyCode failures", async () => {
      const { WhoopClient } = await import("whoop-whoop/client");
      vi.mocked(WhoopClient.signIn).mockResolvedValueOnce({
        type: "verification_required",
        session: "session-xyz",
        method: "sms",
      });
      const error = new Error("WHOOP Cognito CodeMismatchException: Invalid code");
      vi.mocked(WhoopClient.verifyCode).mockRejectedValueOnce(error);

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });

      const signInResult = await caller.signIn({ username: "test@example.com", password: "pass" });
      await expect(
        caller.verifyCode({ challengeId: signInResult.challengeId, code: "123456" }),
      ).rejects.toThrow("WHOOP Cognito CodeMismatchException: Invalid code");

      expect(mockLoggerError).toHaveBeenCalledWith(
        expect.stringMatching(
          /^\[whoopAuth\] verifyCode failed userId=user-1 challengeId=whoop-.* method=sms message=WHOOP Cognito CodeMismatchException: Invalid code$/,
        ),
      );
      expect(mockCaptureException).toHaveBeenCalledWith(error);
    });
  });

  describe("saveTokens", () => {
    it("saves tokens to database with the session userId", async () => {
      const { ensureProvider, saveTokens } = await import("dofek/db/tokens");
      const { queryCache } = await import("../lib/cache.ts");
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
      });

      const result = await caller.saveTokens({
        accessToken: "at-123",
        refreshToken: "rt-456",
        userId: 789,
      });

      expect(result).toEqual({ success: true });
      expect(ensureProvider).toHaveBeenCalledWith(
        expect.anything(),
        "whoop",
        "WHOOP",
        undefined,
        "user-1",
      );
      expect(saveTokens).toHaveBeenCalled();
      expect(queryCache.invalidateByPrefix).toHaveBeenCalledWith("user-1:sync.providers");
    });
  });
});
