import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import type { TRPCError } from "@trpc/server";
import { ProviderAuthenticationFailedError } from "dofek/providers/auth-errors";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockEnsureProvider,
  mockSaveTokens,
  mockInvalidateByPrefix,
  mockGetAllProviders,
  mockEnsureProvidersRegistered,
  mockEnqueueSyncJob,
  mockCaptureException,
  mockReportProviderAuthDiagnostic,
} = vi.hoisted(() => ({
  mockEnsureProvider: vi.fn(),
  mockSaveTokens: vi.fn(),
  mockInvalidateByPrefix: vi.fn(),
  mockGetAllProviders: vi.fn(),
  mockEnsureProvidersRegistered: vi.fn(),
  mockEnqueueSyncJob: vi.fn(),
  mockCaptureException: vi.fn(),
  mockReportProviderAuthDiagnostic: vi.fn(),
}));

vi.mock("dofek/lib/provider-diagnostics", () => ({
  reportProviderAuthDiagnostic: mockReportProviderAuthDiagnostic,
}));

vi.mock("dofek/db/account-erasure", () => ({
  withAccountErasureUserWriteFence: vi.fn(async (db, _userId, operation) => operation(db)),
}));

vi.mock("dofek/jobs/enqueue-sync-job", () => ({ enqueueReconnectSyncJob: mockEnqueueSyncJob }));
vi.mock("dofek/lib/error-reporting", () => ({ captureException: mockCaptureException }));

vi.mock("dofek/db/tokens", () => ({
  ensureProvider: mockEnsureProvider,
  saveTokens: mockSaveTokens,
}));

vi.mock("dofek/providers/registry", () => ({
  getAllProviders: mockGetAllProviders,
}));

vi.mock("../routers/sync-helpers.ts", () => ({
  ensureProvidersRegistered: mockEnsureProvidersRegistered,
}));

vi.mock("dofek/lib/cache", () => ({
  queryCache: { invalidateByPrefix: mockInvalidateByPrefix },
}));

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC.context<{ db: unknown; userId: string; timezone: string }>().create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
  };
});

import type { Provider } from "dofek/providers/types";
import { credentialAuthRouter } from "./credential-auth.ts";
import { createTestCallerFactory } from "./test-helpers.ts";

function stubProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: "test-provider",
    name: "Test Provider",
    validate: () => null,
    sync: async () => ({ provider: "test-provider", recordsSynced: 0, errors: [], duration: 0 }),
    ...overrides,
  };
}

describe("credentialAuthRouter", () => {
  const createCaller = createTestCallerFactory(credentialAuthRouter);

  beforeEach(() => {
    vi.clearAllMocks();
    mockEnqueueSyncJob.mockResolvedValue({ id: "sync-123", alreadyQueued: false });
    mockSaveTokens.mockResolvedValue(undefined);
    mockInvalidateByPrefix.mockResolvedValue(undefined);
  });

  describe("signIn", () => {
    it("reports cache failure without skipping the newly authorized sync", async () => {
      mockGetAllProviders.mockReturnValue([
        stubProvider({
          id: "peloton",
          name: "Peloton",
          authSetup: () => ({
            automatedLogin: vi.fn().mockResolvedValue({ accessToken: "new-token" }),
          }),
        }),
      ]);
      mockInvalidateByPrefix.mockRejectedValueOnce(new Error("Cache unavailable"));
      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-abc",
        timezone: "UTC",
      });
      await expect(
        caller.signIn({ providerId: "peloton", username: "a", password: "b" }),
      ).rejects.toThrow(
        "Peloton connected and sync started, but its status could not be refreshed. Refresh this page.",
      );
      expect(mockEnqueueSyncJob).toHaveBeenCalled();
    });
    it("calls automatedLogin and saves tokens for a valid provider", async () => {
      const fakeTokens = {
        accessToken: "access-123",
        refreshToken: "refresh-456",
        expiresAt: new Date("2026-04-01"),
        scopes: "userId:42",
      };
      const mockAutomatedLogin = vi.fn().mockResolvedValue(fakeTokens);

      const provider = stubProvider({
        id: "eight-sleep",
        name: "Eight Sleep",
        authSetup: () => ({
          automatedLogin: mockAutomatedLogin,
          apiBaseUrl: "https://api.8slp.net",
        }),
      });

      mockGetAllProviders.mockReturnValue([provider]);
      mockEnsureProvidersRegistered.mockResolvedValue(undefined);
      mockEnsureProvider.mockResolvedValue(undefined);
      mockSaveTokens.mockResolvedValue(undefined);
      mockInvalidateByPrefix.mockResolvedValue(undefined);

      const mockDb = { execute: vi.fn() };
      const caller = createCaller({ db: mockDb, userId: "user-abc", timezone: "UTC" });

      const result = await caller.signIn({
        providerId: "eight-sleep",
        username: "user@example.com",
        password: "secret123",
      });

      expect(result.success).toBe(true);
      expect(mockAutomatedLogin).toHaveBeenCalledWith("user@example.com", "secret123");
      expect(mockEnsureProvider).toHaveBeenCalledWith(
        mockDb,
        "eight-sleep",
        "Eight Sleep",
        "https://api.8slp.net",
        "user-abc",
      );
      expect(mockSaveTokens).toHaveBeenCalledWith(mockDb, "eight-sleep", fakeTokens, "user-abc");
      expect(mockReportProviderAuthDiagnostic).toHaveBeenCalledWith(
        "eight-sleep",
        "sign_in_started",
        "user-abc",
      );
      expect(mockReportProviderAuthDiagnostic).toHaveBeenCalledWith(
        "eight-sleep",
        "sign_in_succeeded",
        "user-abc",
      );
      expect(mockInvalidateByPrefix).toHaveBeenCalledWith("user-abc:sync.providers");
      expect(mockEnqueueSyncJob).toHaveBeenCalledWith("eight-sleep", "user-abc");
    });

    it("waits for the saved credentials before starting sync", async () => {
      const pending = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      mockGetAllProviders.mockReturnValue([
        stubProvider({
          id: "peloton",
          name: "Peloton",
          authSetup: () => ({
            automatedLogin: vi.fn().mockResolvedValue({ accessToken: "new-token" }),
          }),
        }),
      ]);
      mockSaveTokens.mockImplementationOnce(() => {
        started.resolve();
        return pending.promise;
      });
      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-abc",
        timezone: "UTC",
      });
      const completion = caller.signIn({ providerId: "peloton", username: "a", password: "b" });
      await started.promise;
      expect(mockEnqueueSyncJob).not.toHaveBeenCalled();
      pending.resolve();
      await completion;
      expect(mockEnqueueSyncJob).toHaveBeenCalledWith("peloton", "user-abc");
    });

    it("does not queue a sync when credential persistence fails", async () => {
      mockGetAllProviders.mockReturnValue([
        stubProvider({
          id: "peloton",
          name: "Peloton",
          authSetup: () => ({
            automatedLogin: vi.fn().mockResolvedValue({ accessToken: "new-token" }),
          }),
        }),
      ]);
      mockSaveTokens.mockRejectedValueOnce(new Error("Token write failed"));
      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-abc",
        timezone: "UTC",
      });
      await expect(
        caller.signIn({ providerId: "peloton", username: "a", password: "b" }),
      ).rejects.toThrow("Token write failed");
      expect(mockEnqueueSyncJob).not.toHaveBeenCalled();
    });

    it("reports a sync queue failure after saving the new credentials", async () => {
      mockGetAllProviders.mockReturnValue([
        stubProvider({
          id: "peloton",
          name: "Peloton",
          authSetup: () => ({
            automatedLogin: vi.fn().mockResolvedValue({ accessToken: "new-token" }),
          }),
        }),
      ]);
      const error = new Error("Redis unavailable");
      mockEnqueueSyncJob.mockRejectedValueOnce(error);
      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-abc",
        timezone: "UTC",
      });
      await expect(
        caller.signIn({ providerId: "peloton", username: "a", password: "b" }),
      ).rejects.toMatchObject({
        code: "INTERNAL_SERVER_ERROR",
        message: "Peloton connected, but its sync could not be started. Try Sync again.",
      });
      expect(mockSaveTokens).toHaveBeenCalled();
      expect(mockCaptureException).toHaveBeenCalledWith(error);
    });

    it("throws for unknown provider", async () => {
      mockGetAllProviders.mockReturnValue([]);
      mockEnsureProvidersRegistered.mockResolvedValue(undefined);

      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-abc",
        timezone: "UTC",
      });

      await expect(
        caller.signIn({ providerId: "nonexistent", username: "a", password: "b" }),
      ).rejects.toThrow("Unknown provider: nonexistent");
    });

    it("throws when provider does not support credential auth", async () => {
      const provider = stubProvider({
        id: "strava",
        name: "Strava",
        authSetup: () => ({
          oauthConfig: {
            clientId: "id",
            authorizeUrl: "https://strava.com/auth",
            tokenUrl: "https://strava.com/token",
            redirectUri: "https://example.com/callback",
            scopes: ["read"],
          },
          exchangeCode: async () => ({
            accessToken: "t",
            refreshToken: null,
            expiresAt: new Date(),
            scopes: null,
          }),
          // No automatedLogin
        }),
      });
      mockGetAllProviders.mockReturnValue([provider]);
      mockEnsureProvidersRegistered.mockResolvedValue(undefined);

      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-abc",
        timezone: "UTC",
      });

      await expect(
        caller.signIn({ providerId: "strava", username: "a", password: "b" }),
      ).rejects.toThrow("does not support credential authentication");
    });

    it("returns a bad request for expected provider auth failures", async () => {
      const provider = stubProvider({
        id: "eight-sleep",
        name: "Eight Sleep",
        authSetup: () => ({
          automatedLogin: vi
            .fn()
            .mockRejectedValue(new ProviderAuthenticationFailedError("Eight Sleep")),
        }),
      });
      mockGetAllProviders.mockReturnValue([provider]);
      mockEnsureProvidersRegistered.mockResolvedValue(undefined);

      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-abc",
        timezone: "UTC",
      });

      await expect(
        caller.signIn({ providerId: "eight-sleep", username: "bad", password: "wrong" }),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "Eight Sleep authentication failed.",
      } satisfies Partial<TRPCError>);
      expect(mockReportProviderAuthDiagnostic).toHaveBeenCalledWith(
        "eight-sleep",
        "sign_in_failed",
        "user-abc",
      );
      expect(mockEnqueueSyncJob).not.toHaveBeenCalled();
    });

    it("returns too many requests for provider login rate limits", async () => {
      const provider = stubProvider({
        id: "amazfit-zepp",
        name: "Amazfit/Zepp",
        authSetup: () => ({
          automatedLogin: vi.fn().mockRejectedValue(
            new ProviderRateLimitError({
              message: "amazfit-zepp API rate limit exceeded (429): too many requests",
              providerId: "amazfit-zepp",
              statusCode: 429,
              responseBody: "too many requests",
            }),
          ),
        }),
      });
      mockGetAllProviders.mockReturnValue([provider]);
      mockEnsureProvidersRegistered.mockResolvedValue(undefined);

      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-abc",
        timezone: "UTC",
      });

      await expect(
        caller.signIn({ providerId: "amazfit-zepp", username: "bad", password: "wrong" }),
      ).rejects.toMatchObject({
        code: "TOO_MANY_REQUESTS",
        message: "amazfit-zepp API rate limit exceeded (429): too many requests",
      } satisfies Partial<TRPCError>);
    });

    it("still propagates unexpected automatedLogin errors", async () => {
      const provider = stubProvider({
        id: "eight-sleep",
        name: "Eight Sleep",
        authSetup: () => ({
          automatedLogin: vi.fn().mockRejectedValue(new Error("provider response was malformed")),
        }),
      });
      mockGetAllProviders.mockReturnValue([provider]);
      mockEnsureProvidersRegistered.mockResolvedValue(undefined);

      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-abc",
        timezone: "UTC",
      });

      await expect(
        caller.signIn({ providerId: "eight-sleep", username: "bad", password: "wrong" }),
      ).rejects.toThrow("provider response was malformed");
    });

    it("throws when provider has no authSetup", async () => {
      const provider = stubProvider({ id: "no-auth", name: "No Auth" });
      mockGetAllProviders.mockReturnValue([provider]);
      mockEnsureProvidersRegistered.mockResolvedValue(undefined);

      const caller = createCaller({
        db: { execute: vi.fn() },
        userId: "user-abc",
        timezone: "UTC",
      });

      await expect(
        caller.signIn({ providerId: "no-auth", username: "a", password: "b" }),
      ).rejects.toThrow("does not support credential authentication");
    });
  });
});
