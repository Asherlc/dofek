import {
  ProviderRateLimitError,
  ProviderServiceUnavailableError,
} from "@dofek/provider-http/rate-limit";
import type { TRPCError } from "@trpc/server";
import { ProviderAuthenticationFailedError } from "dofek/providers/auth-errors";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockConnectProviderWithTokens,
  mockCaptureException,
  mockInvalidateByPrefix,
  mockGetAllProviders,
  mockLoggerWarn,
  mockEnsureProvidersRegistered,
} = vi.hoisted(() => ({
  mockConnectProviderWithTokens: vi.fn(),
  mockCaptureException: vi.fn(),
  mockInvalidateByPrefix: vi.fn(),
  mockGetAllProviders: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockEnsureProvidersRegistered: vi.fn(),
}));

vi.mock("@sentry/node", () => ({
  captureException: mockCaptureException,
}));

vi.mock("../logger.ts", () => ({
  logger: { warn: mockLoggerWarn },
}));

vi.mock("dofek/db/tokens", () => ({
  connectProviderWithTokens: mockConnectProviderWithTokens,
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
import { createTestCallerFactory } from "./test-helpers.ts";
import { tokenAuthRouter } from "./token-auth.ts";

function stubProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: "test-provider",
    name: "Test Provider",
    validate: () => null,
    sync: async () => ({ provider: "test-provider", recordsSynced: 0, errors: [], duration: 0 }),
    ...overrides,
  };
}

describe("tokenAuthRouter", () => {
  const createCaller = createTestCallerFactory(tokenAuthRouter);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("exchanges and saves a personal token for the authenticated user", async () => {
    const tokens = {
      accessToken: "access-123",
      refreshToken: "refresh-456",
      expiresAt: new Date("2026-08-01T00:00:00Z"),
      scopes: "read",
    };
    const exchangeToken = vi.fn().mockResolvedValue(tokens);
    const provider = stubProvider({
      id: "wger",
      name: "Wger",
      authSetup: () => ({
        manualToken: {
          label: "Refresh token",
          instructionsUrl: "https://wger.de/en/software/api",
          exchangeToken,
        },
        apiBaseUrl: "https://wger.de/api/v2",
      }),
    });
    mockGetAllProviders.mockReturnValue([provider]);
    mockEnsureProvidersRegistered.mockResolvedValue(undefined);
    mockConnectProviderWithTokens.mockResolvedValue(undefined);
    mockInvalidateByPrefix.mockResolvedValue(undefined);
    const db = { execute: vi.fn() };
    const caller = createCaller({ db, userId: "user-123", timezone: "UTC" });

    const result = await caller.connect({ providerId: "wger", token: "  refresh-input  " });

    expect(result).toEqual({ success: true });
    expect(exchangeToken).toHaveBeenCalledWith("refresh-input");
    expect(mockConnectProviderWithTokens).toHaveBeenCalledWith(
      db,
      {
        id: "wger",
        name: "Wger",
        apiBaseUrl: "https://wger.de/api/v2",
      },
      tokens,
      "user-123",
    );
    expect(mockInvalidateByPrefix).toHaveBeenCalledWith("user-123:sync.providers");
  });

  it("selects the requested provider when multiple providers support personal tokens", async () => {
    const firstExchange = vi.fn().mockResolvedValue({
      accessToken: "wrong-access",
      refreshToken: null,
      expiresAt: new Date("2026-08-01T00:00:00Z"),
      scopes: "wrong",
    });
    const requestedTokens = {
      accessToken: "requested-access",
      refreshToken: "requested-refresh",
      expiresAt: new Date("2026-09-01T00:00:00Z"),
      scopes: "requested",
    };
    const requestedExchange = vi.fn().mockResolvedValue(requestedTokens);
    mockGetAllProviders.mockReturnValue([
      stubProvider({
        id: "first-provider",
        name: "First Provider",
        authSetup: () => ({
          manualToken: {
            label: "First token",
            instructionsUrl: "https://first.example.com/token",
            exchangeToken: firstExchange,
          },
          apiBaseUrl: "https://first.example.com/api",
        }),
      }),
      stubProvider({
        id: "requested-provider",
        name: "Requested Provider",
        authSetup: () => ({
          manualToken: {
            label: "Requested token",
            instructionsUrl: "https://requested.example.com/token",
            exchangeToken: requestedExchange,
          },
          apiBaseUrl: "https://requested.example.com/api",
        }),
      }),
    ]);
    mockEnsureProvidersRegistered.mockResolvedValue(undefined);
    mockConnectProviderWithTokens.mockResolvedValue(undefined);
    mockInvalidateByPrefix.mockResolvedValue(undefined);
    const db = { execute: vi.fn() };
    const caller = createCaller({ db, userId: "user-123", timezone: "UTC" });

    await caller.connect({
      providerId: "requested-provider",
      token: "requested-token-input",
    });

    expect(firstExchange).not.toHaveBeenCalled();
    expect(requestedExchange).toHaveBeenCalledWith("requested-token-input");
    expect(mockConnectProviderWithTokens).toHaveBeenCalledWith(
      db,
      {
        id: "requested-provider",
        name: "Requested Provider",
        apiBaseUrl: "https://requested.example.com/api",
      },
      requestedTokens,
      "user-123",
    );
  });

  it("does not invalidate the authorized state when atomic token persistence fails", async () => {
    const tokens = {
      accessToken: "access-123",
      refreshToken: "refresh-456",
      expiresAt: new Date("2026-08-01T00:00:00Z"),
      scopes: "read",
    };
    const provider = stubProvider({
      id: "wger",
      name: "Wger",
      authSetup: () => ({
        manualToken: {
          label: "Refresh token",
          instructionsUrl: "https://wger.de/en/software/api",
          exchangeToken: vi.fn().mockResolvedValue(tokens),
        },
        apiBaseUrl: "https://wger.de/api/v2",
      }),
    });
    const db = { execute: vi.fn() };
    const persistenceError = new Error("token persistence failed");
    mockGetAllProviders.mockReturnValue([provider]);
    mockEnsureProvidersRegistered.mockResolvedValue(undefined);
    mockConnectProviderWithTokens.mockRejectedValueOnce(persistenceError);

    const caller = createCaller({ db, userId: "user-123", timezone: "UTC" });

    await expect(
      caller.connect({ providerId: "wger", token: "refresh-input" }),
    ).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "Could not save the Wger connection. Try again later.",
    } satisfies Partial<TRPCError>);
    expect(mockConnectProviderWithTokens).toHaveBeenCalledWith(
      db,
      {
        id: "wger",
        name: "Wger",
        apiBaseUrl: "https://wger.de/api/v2",
      },
      tokens,
      "user-123",
    );
    expect(mockInvalidateByPrefix).not.toHaveBeenCalled();
  });

  it("reports cache invalidation failure after persisting a successful connection", async () => {
    const cacheError = new Error("cache unavailable");
    const tokens = {
      accessToken: "access-123",
      refreshToken: "refresh-456",
      expiresAt: new Date("2026-08-01T00:00:00Z"),
      scopes: "read",
    };
    const provider = stubProvider({
      id: "wger",
      name: "Wger",
      authSetup: () => ({
        manualToken: {
          label: "Refresh token",
          instructionsUrl: "https://wger.de/en/software/api",
          exchangeToken: vi.fn().mockResolvedValue(tokens),
        },
        apiBaseUrl: "https://wger.de/api/v2",
      }),
    });
    mockGetAllProviders.mockReturnValue([provider]);
    mockEnsureProvidersRegistered.mockResolvedValue(undefined);
    mockConnectProviderWithTokens.mockResolvedValue(undefined);
    mockInvalidateByPrefix.mockRejectedValue(cacheError);
    const caller = createCaller({
      db: { execute: vi.fn() },
      userId: "user-123",
      timezone: "UTC",
    });

    await expect(caller.connect({ providerId: "wger", token: "refresh-input" })).resolves.toEqual({
      success: true,
    });
    expect(mockCaptureException).toHaveBeenCalledWith(cacheError, {
      tags: { procedure: "tokenAuth.connect" },
      extra: { providerId: "wger", userId: "user-123" },
    });
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      "[tokenAuth.connect] Connection persisted but provider cache invalidation failed for wger (user user-123)",
    );
  });

  it("rejects unknown providers", async () => {
    mockGetAllProviders.mockReturnValue([]);
    mockEnsureProvidersRegistered.mockResolvedValue(undefined);
    const caller = createCaller({
      db: { execute: vi.fn() },
      userId: "user-123",
      timezone: "UTC",
    });

    await expect(caller.connect({ providerId: "missing", token: "token" })).rejects.toMatchObject({
      code: "NOT_FOUND",
      message: "Unknown provider: missing",
    } satisfies Partial<TRPCError>);
  });

  it("rejects providers without manual token authentication", async () => {
    mockGetAllProviders.mockReturnValue([stubProvider({ id: "strava", name: "Strava" })]);
    mockEnsureProvidersRegistered.mockResolvedValue(undefined);
    const caller = createCaller({
      db: { execute: vi.fn() },
      userId: "user-123",
      timezone: "UTC",
    });

    await expect(caller.connect({ providerId: "strava", token: "token" })).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Provider strava does not support personal token authentication",
    } satisfies Partial<TRPCError>);
  });

  it("surfaces rejected tokens as an actionable bad request", async () => {
    const provider = stubProvider({
      id: "ultrahuman",
      name: "Ultrahuman",
      authSetup: () => ({
        manualToken: {
          label: "Personal API token",
          instructionsUrl: "https://vision.ultrahuman.com/developer-docs",
          exchangeToken: vi
            .fn()
            .mockRejectedValue(new ProviderAuthenticationFailedError("Ultrahuman")),
        },
        apiBaseUrl: "https://partner.ultrahuman.com/api/v1",
      }),
    });
    mockGetAllProviders.mockReturnValue([provider]);
    mockEnsureProvidersRegistered.mockResolvedValue(undefined);
    const caller = createCaller({
      db: { execute: vi.fn() },
      userId: "user-123",
      timezone: "UTC",
    });

    await expect(
      caller.connect({ providerId: "ultrahuman", token: "invalid" }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Ultrahuman authentication failed.",
    } satisfies Partial<TRPCError>);
  });

  it("preserves provider rate-limit errors", async () => {
    const rateLimitError = new ProviderRateLimitError({
      message: "Wger API rate limit exceeded",
      providerId: "wger",
      statusCode: 429,
      responseBody: "slow down",
    });
    const provider = stubProvider({
      id: "wger",
      authSetup: () => ({
        manualToken: {
          label: "Refresh token",
          instructionsUrl: "https://wger.de/en/software/api",
          exchangeToken: vi.fn().mockRejectedValue(rateLimitError),
        },
        apiBaseUrl: "https://wger.de/api/v2",
      }),
    });
    mockGetAllProviders.mockReturnValue([provider]);
    mockEnsureProvidersRegistered.mockResolvedValue(undefined);
    const caller = createCaller({
      db: { execute: vi.fn() },
      userId: "user-123",
      timezone: "UTC",
    });

    await expect(caller.connect({ providerId: "wger", token: "token" })).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
      message: "Wger API rate limit exceeded",
    } satisfies Partial<TRPCError>);
  });

  it("surfaces provider outages without exposing the provider response body", async () => {
    const outage = new ProviderServiceUnavailableError({
      message: "ultrahuman API service unavailable (503): upstream-secret-response",
      providerId: "ultrahuman",
      statusCode: 503,
      responseBody: "upstream-secret-response",
    });
    const provider = stubProvider({
      id: "ultrahuman",
      name: "Ultrahuman",
      authSetup: () => ({
        manualToken: {
          label: "Personal API token",
          instructionsUrl: "https://vision.ultrahuman.com/developer-docs",
          exchangeToken: vi.fn().mockRejectedValue(outage),
        },
        apiBaseUrl: "https://partner.ultrahuman.com/api/v1",
      }),
    });
    mockGetAllProviders.mockReturnValue([provider]);
    mockEnsureProvidersRegistered.mockResolvedValue(undefined);
    const caller = createCaller({
      db: { execute: vi.fn() },
      userId: "user-123",
      timezone: "UTC",
    });

    await expect(
      caller.connect({ providerId: "ultrahuman", token: "personal-secret-token" }),
    ).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: "Ultrahuman is temporarily unavailable. Try again shortly.",
    } satisfies Partial<TRPCError>);
  });

  it("returns a safe semantic error for an unexpected provider response", async () => {
    const provider = stubProvider({
      id: "ultrahuman",
      name: "Ultrahuman",
      authSetup: () => ({
        manualToken: {
          label: "Personal API token",
          instructionsUrl: "https://vision.ultrahuman.com/developer-docs",
          exchangeToken: vi.fn().mockRejectedValue(new Error("raw upstream response secret")),
        },
        apiBaseUrl: "https://partner.ultrahuman.com/api/v1",
      }),
    });
    mockGetAllProviders.mockReturnValue([provider]);
    mockEnsureProvidersRegistered.mockResolvedValue(undefined);
    const caller = createCaller({
      db: { execute: vi.fn() },
      userId: "user-123",
      timezone: "UTC",
    });

    await expect(
      caller.connect({ providerId: "ultrahuman", token: "personal-secret-token" }),
    ).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "Ultrahuman returned an unexpected response. Try again later.",
    } satisfies Partial<TRPCError>);
  });

  it("fails before exchanging a token when provider API metadata is missing", async () => {
    const exchangeToken = vi.fn();
    const provider = stubProvider({
      id: "misconfigured",
      name: "Misconfigured Provider",
      authSetup: () => ({
        manualToken: {
          label: "Personal API token",
          instructionsUrl: "https://example.com/token",
          exchangeToken,
        },
      }),
    });
    mockGetAllProviders.mockReturnValue([provider]);
    mockEnsureProvidersRegistered.mockResolvedValue(undefined);
    const caller = createCaller({
      db: { execute: vi.fn() },
      userId: "user-123",
      timezone: "UTC",
    });

    await expect(
      caller.connect({ providerId: "misconfigured", token: "personal-secret-token" }),
    ).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: "Misconfigured Provider personal-token authentication is misconfigured.",
    } satisfies Partial<TRPCError>);
    expect(exchangeToken).not.toHaveBeenCalled();
  });
});
