import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestCallerFactory, makeMockSensorStore } from "./test-helpers.ts";

const { mockLoggerInfo, mockLoggerError, mockCaptureException } = vi.hoisted(() => ({
  mockLoggerInfo: vi.fn(),
  mockLoggerError: vi.fn(),
  mockCaptureException: vi.fn(),
}));

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{
      db: unknown;
      userId: string | null;
      timezone: string;
      sensorStore?: import("../repositories/activity-repository.ts").ActivitySensorStore;
    }>()
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

vi.mock("@dofek/whoop/client", () => ({
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

vi.mock("dofek/lib/cache", () => ({
  queryCache: { invalidateByPrefix: vi.fn() },
}));

const mockEnqueue = vi.fn();
vi.mock("dofek/jobs/enqueue-sync-job", () => ({
  enqueueReconnectSyncJob: (...args: unknown[]) => mockEnqueue(...args),
}));
vi.mock("dofek/db/account-erasure", () => ({
  withAccountErasureUserWriteFence: vi.fn(async (db, _userId, operation) => operation(db)),
}));

import { whoopAuthRouter } from "./whoop-auth.ts";

describe("whoopAuthRouter", () => {
  const createCaller = createTestCallerFactory(whoopAuthRouter);
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("logs and reports signIn failures", async () => {
    const { WhoopClient } = await import("@dofek/whoop/client");
    const error = new Error("bad sms code request");
    vi.mocked(WhoopClient.signIn).mockRejectedValueOnce(error);

    const caller = createCaller({
      db: { execute: vi.fn().mockResolvedValue([]) },
      userId: "user-1",
      timezone: "UTC",
      sensorStore: makeMockSensorStore([]),
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
      const { WhoopClient } = await import("@dofek/whoop/client");
      vi.mocked(WhoopClient.signIn).mockResolvedValueOnce({
        type: "verification_required",
        session: "cognito-session-123",
        method: "sms",
      });

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeMockSensorStore([]),
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
      const { WhoopClient } = await import("@dofek/whoop/client");
      vi.mocked(WhoopClient.signIn).mockResolvedValueOnce({
        type: "success",
        token: { accessToken: "at", refreshToken: "rt", userId: 123, expiresInSeconds: 3600 },
      });

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeMockSensorStore([]),
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
        sensorStore: makeMockSensorStore([]),
      });

      await expect(
        caller.verifyCode({ challengeId: "nonexistent", code: "123456" }),
      ).rejects.toThrow("expired or not found");
    });

    it("verifies code successfully after signIn", async () => {
      const { WhoopClient } = await import("@dofek/whoop/client");
      vi.mocked(WhoopClient.signIn).mockResolvedValueOnce({
        type: "verification_required",
        session: "session-xyz",
        method: "sms",
      });
      vi.mocked(WhoopClient.verifyCode).mockResolvedValueOnce({
        accessToken: "new-at",
        refreshToken: "new-rt",
        userId: 456,
        expiresInSeconds: 3600,
      });

      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeMockSensorStore([]),
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
      const { WhoopClient } = await import("@dofek/whoop/client");
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
        sensorStore: makeMockSensorStore([]),
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
      const { queryCache } = await import("dofek/lib/cache");
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeMockSensorStore([]),
      });

      const result = await caller.saveTokens({
        accessToken: "at-123",
        refreshToken: "rt-456",
        userId: 789,
        expiresInSeconds: 3600,
      });

      expect(result).toEqual({ success: true });
      expect(mockEnqueue).toHaveBeenCalledWith("whoop", "user-1");
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

    it("rejects empty access or refresh tokens", async () => {
      const caller = createCaller({
        db: { execute: vi.fn().mockResolvedValue([]) },
        userId: "user-1",
        timezone: "UTC",
        sensorStore: makeMockSensorStore([]),
      });

      await expect(
        caller.saveTokens({
          accessToken: "",
          refreshToken: "rt-456",
          userId: 789,
          expiresInSeconds: 3600,
        }),
      ).rejects.toThrow(/WHOOP access token is required/);

      await expect(
        caller.saveTokens({
          accessToken: "at-123",
          refreshToken: "",
          userId: 789,
          expiresInSeconds: 3600,
        }),
      ).rejects.toThrow(/WHOOP refresh token is required/);
    });
  });
});
