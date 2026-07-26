import {
  ProviderRateLimitError,
  ProviderServiceUnavailableError,
} from "@dofek/provider-http/rate-limit";
import type { TRPCError } from "@trpc/server";
import { ProviderAuthenticationFailedError } from "dofek/providers/auth-errors";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockConnectProviderWithTokens,
  mockInvalidateByPrefix,
  mockGetAllProviders,
  mockEnsureProvidersRegistered,
} = vi.hoisted(() => ({
  mockConnectProviderWithTokens: vi.fn(),
  mockInvalidateByPrefix: vi.fn(),
  mockGetAllProviders: vi.fn(),
  mockEnsureProvidersRegistered: vi.fn(),
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
      }),
    });
    const db = { execute: vi.fn() };
    const persistenceError = new Error("token persistence failed");
    mockGetAllProviders.mockReturnValue([provider]);
    mockEnsureProvidersRegistered.mockResolvedValue(undefined);
    mockConnectProviderWithTokens.mockRejectedValueOnce(persistenceError);

    const caller = createCaller({ db, userId: "user-123", timezone: "UTC" });

    await expect(caller.connect({ providerId: "wger", token: "refresh-input" })).rejects.toThrow(
      "token persistence failed",
    );
    expect(mockConnectProviderWithTokens).toHaveBeenCalledWith(
      db,
      {
        id: "wger",
        name: "Wger",
        apiBaseUrl: undefined,
      },
      tokens,
      "user-123",
    );
    expect(mockInvalidateByPrefix).not.toHaveBeenCalled();
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
});
