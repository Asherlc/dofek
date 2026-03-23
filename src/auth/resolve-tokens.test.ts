import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthConfig, TokenSet } from "./oauth.ts";
import { resolveOAuthTokens } from "./resolve-tokens.ts";

vi.mock("../db/tokens.ts", () => ({
  loadTokens: vi.fn(),
  saveTokens: vi.fn(),
}));

vi.mock("./oauth.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./oauth.ts")>();
  return {
    ...original,
    refreshAccessToken: vi.fn(),
  };
});

const { loadTokens, saveTokens } = await import("../db/tokens.ts");
const { refreshAccessToken } = await import("./oauth.ts");

const mockLoadTokens = vi.mocked(loadTokens);
const mockSaveTokens = vi.mocked(saveTokens);
const mockRefreshAccessToken = vi.mocked(refreshAccessToken);

import type { SyncDatabase } from "../db/index.ts";

const fakeDb: SyncDatabase = {
  select: vi.fn(),
  insert: vi.fn(),
  delete: vi.fn(),
  execute: vi.fn(),
};

const fakeConfig: OAuthConfig = {
  clientId: "id",
  clientSecret: "secret",
  authorizeUrl: "https://example.com/authorize",
  tokenUrl: "https://example.com/token",
  redirectUri: "https://example.com/callback",
  scopes: ["read"],
};

function futureDate(ms = 3600_000): Date {
  return new Date(Date.now() + ms);
}

function pastDate(ms = 3600_000): Date {
  return new Date(Date.now() - ms);
}

describe("resolveOAuthTokens", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("throws when no tokens are stored", async () => {
    mockLoadTokens.mockResolvedValue(null);

    await expect(
      resolveOAuthTokens({
        db: fakeDb,
        providerId: "strava",
        providerName: "Strava",
        getOAuthConfig: () => fakeConfig,
      }),
    ).rejects.toThrow("No OAuth tokens found for Strava");
  });

  it("returns valid tokens without refreshing", async () => {
    const validTokens: TokenSet = {
      accessToken: "valid-token",
      refreshToken: "refresh-token",
      expiresAt: futureDate(),
      scopes: null,
    };
    mockLoadTokens.mockResolvedValue(validTokens);

    const result = await resolveOAuthTokens({
      db: fakeDb,
      providerId: "strava",
      providerName: "Strava",
      getOAuthConfig: () => fakeConfig,
    });

    expect(result).toBe(validTokens);
    expect(mockRefreshAccessToken).not.toHaveBeenCalled();
    expect(mockSaveTokens).not.toHaveBeenCalled();
  });

  it("refreshes expired tokens and saves them", async () => {
    const expiredTokens: TokenSet = {
      accessToken: "old-token",
      refreshToken: "refresh-token",
      expiresAt: pastDate(),
      scopes: null,
    };
    const refreshedTokens: TokenSet = {
      accessToken: "new-token",
      refreshToken: "new-refresh",
      expiresAt: futureDate(),
      scopes: null,
    };
    mockLoadTokens.mockResolvedValue(expiredTokens);
    mockRefreshAccessToken.mockResolvedValue(refreshedTokens);
    mockSaveTokens.mockResolvedValue(undefined);

    const result = await resolveOAuthTokens({
      db: fakeDb,
      providerId: "fitbit",
      providerName: "Fitbit",
      getOAuthConfig: () => fakeConfig,
    });

    expect(result).toBe(refreshedTokens);
    expect(mockRefreshAccessToken).toHaveBeenCalledWith(
      fakeConfig,
      "refresh-token",
      globalThis.fetch,
    );
    expect(mockSaveTokens).toHaveBeenCalledWith(fakeDb, "fitbit", refreshedTokens);
  });

  it("throws when oauth config is unavailable", async () => {
    mockLoadTokens.mockResolvedValue({
      accessToken: "old",
      refreshToken: "refresh",
      expiresAt: pastDate(),
      scopes: null,
    });

    await expect(
      resolveOAuthTokens({
        db: fakeDb,
        providerId: "wahoo",
        providerName: "Wahoo",
        getOAuthConfig: () => undefined,
      }),
    ).rejects.toThrow("OAuth config required to refresh Wahoo tokens");
  });

  it("throws when no refresh token is available", async () => {
    mockLoadTokens.mockResolvedValue({
      accessToken: "old",
      refreshToken: null,
      expiresAt: pastDate(),
      scopes: null,
    });

    await expect(
      resolveOAuthTokens({
        db: fakeDb,
        providerId: "polar",
        providerName: "Polar",
        getOAuthConfig: () => fakeConfig,
      }),
    ).rejects.toThrow("No refresh token for Polar");
  });

  it("passes custom fetchFn to refreshAccessToken", async () => {
    const customFetch: typeof globalThis.fetch = vi.fn();
    mockLoadTokens.mockResolvedValue({
      accessToken: "old",
      refreshToken: "refresh",
      expiresAt: pastDate(),
      scopes: null,
    });
    mockRefreshAccessToken.mockResolvedValue({
      accessToken: "new",
      refreshToken: "new-refresh",
      expiresAt: futureDate(),
      scopes: null,
    });
    mockSaveTokens.mockResolvedValue(undefined);

    await resolveOAuthTokens({
      db: fakeDb,
      providerId: "komoot",
      providerName: "Komoot",
      getOAuthConfig: () => fakeConfig,
      fetchFn: customFetch,
    });

    expect(mockRefreshAccessToken).toHaveBeenCalledWith(fakeConfig, "refresh", customFetch);
  });
});
