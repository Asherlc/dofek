import { WhoopClient } from "@dofek/whoop/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SyncDatabase } from "../../db/index.ts";
import {
  buildWhoopTokenSet,
  parseWhoopUserIdFromScopes,
  resolveWhoopTokens,
  saveWhoopAuthTokens,
} from "./resolve-tokens.ts";

vi.mock("../../db/tokens.ts", () => ({
  loadTokens: vi.fn(),
  saveTokens: vi.fn(),
  deleteTokens: vi.fn(),
}));

const { deleteTokens, loadTokens, saveTokens } = await import("../../db/tokens.ts");

function makeDb(): SyncDatabase {
  return {
    select: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
    execute: vi.fn(),
  };
}

describe("parseWhoopUserIdFromScopes", () => {
  it("extracts userId from scopes", () => {
    expect(parseWhoopUserIdFromScopes("userId:10129")).toBe(10129);
  });

  it("returns null when scopes are missing", () => {
    expect(parseWhoopUserIdFromScopes(null)).toBeNull();
  });
});

describe("buildWhoopTokenSet", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-23T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("stores userId in scopes with the Cognito-provided expiry", () => {
    expect(
      buildWhoopTokenSet({
        accessToken: "access",
        refreshToken: "refresh",
        userId: 42,
        expiresInSeconds: 3600,
      }),
    ).toEqual({
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: new Date(Date.now() + 3600 * 1000),
      scopes: "userId:42",
    });
  });
});

describe("saveWhoopAuthTokens", () => {
  it("persists tokens for the whoop provider", async () => {
    const db = makeDb();
    await saveWhoopAuthTokens(
      db,
      { accessToken: "access", refreshToken: "refresh", userId: 7, expiresInSeconds: 3600 },
      "user-1",
    );

    expect(saveTokens).toHaveBeenCalledWith(
      db,
      "whoop",
      expect.objectContaining({
        accessToken: "access",
        refreshToken: "refresh",
        scopes: "userId:7",
      }),
      "user-1",
    );
  });
});

describe("resolveWhoopTokens", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-23T12:00:00Z"));
    vi.mocked(loadTokens).mockReset();
    vi.mocked(saveTokens).mockReset();
    vi.mocked(deleteTokens).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("reuses a valid access token without calling Cognito refresh", async () => {
    const expiresAt = new Date("2099-01-01T00:00:00Z");
    vi.mocked(loadTokens).mockResolvedValue({
      accessToken: "stored-access",
      refreshToken: "stored-refresh",
      expiresAt,
      scopes: "userId:12345",
    });

    let cognitoCalls = 0;
    const fetchFn: typeof globalThis.fetch = (input) => {
      if (input.toString().includes("auth-service/v3/whoop")) {
        cognitoCalls += 1;
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    };

    const result = await resolveWhoopTokens({ db: makeDb(), fetchFn, userId: "user-1" });

    expect(result).toMatchObject({
      accessToken: "stored-access",
      refreshToken: "stored-refresh",
      userId: 12345,
    });
    expect(result.expiresInSeconds).toBe(Math.floor((expiresAt.getTime() - Date.now()) / 1000));

    expect(cognitoCalls).toBe(0);
    expect(saveTokens).not.toHaveBeenCalled();
  });

  it("refreshes when the access token has exactly one hour remaining", async () => {
    vi.mocked(loadTokens).mockResolvedValue({
      accessToken: "stored-access",
      refreshToken: "stored-refresh",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      scopes: "userId:12345",
    });
    const refreshSpy = vi.spyOn(WhoopClient, "refreshAccessToken").mockResolvedValue({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      userId: null,
      expiresInSeconds: 3600,
    });

    await expect(resolveWhoopTokens({ db: makeDb(), userId: "user-1" })).resolves.toEqual({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      userId: 12345,
      expiresInSeconds: 3600,
    });

    expect(refreshSpy).toHaveBeenCalledWith("stored-refresh", globalThis.fetch);
    expect(saveTokens).toHaveBeenCalled();
    refreshSpy.mockRestore();
  });

  it("propagates refresh failures inside the safety window", async () => {
    vi.mocked(loadTokens).mockResolvedValue({
      accessToken: "stored-access",
      refreshToken: "stored-refresh",
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
      scopes: "userId:12345",
    });
    const refreshError = new Error("WHOOP token refresh unavailable");
    vi.spyOn(WhoopClient, "refreshAccessToken").mockRejectedValue(refreshError);

    await expect(resolveWhoopTokens({ db: makeDb(), userId: "user-1" })).rejects.toBe(refreshError);

    expect(saveTokens).not.toHaveBeenCalled();
  });

  it("reuses the access token when it has more than one hour remaining", async () => {
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000 + 1);
    vi.mocked(loadTokens).mockResolvedValue({
      accessToken: "stored-access",
      refreshToken: "stored-refresh",
      expiresAt,
      scopes: "userId:12345",
    });
    const refreshSpy = vi
      .spyOn(WhoopClient, "refreshAccessToken")
      .mockRejectedValue(new Error("refresh should not run"));

    await expect(resolveWhoopTokens({ db: makeDb(), userId: "user-1" })).resolves.toEqual({
      accessToken: "stored-access",
      refreshToken: "stored-refresh",
      userId: 12345,
      expiresInSeconds: 3600,
    });

    expect(refreshSpy).not.toHaveBeenCalled();
    expect(saveTokens).not.toHaveBeenCalled();
    refreshSpy.mockRestore();
  });

  it("refreshes and persists tokens when the access token is expired", async () => {
    vi.mocked(loadTokens).mockResolvedValue({
      accessToken: "stored-access",
      refreshToken: "stored-refresh",
      expiresAt: new Date("2020-01-01T00:00:00Z"),
      scopes: "userId:12345",
    });

    const refreshSpy = vi.spyOn(WhoopClient, "refreshAccessToken").mockResolvedValue({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      userId: null,
      expiresInSeconds: 3600,
    });

    await expect(resolveWhoopTokens({ db: makeDb(), userId: "user-1" })).resolves.toEqual({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      userId: 12345,
      expiresInSeconds: 3600,
    });

    expect(refreshSpy).toHaveBeenCalledWith("stored-refresh", globalThis.fetch);
    expect(saveTokens).toHaveBeenCalled();
    refreshSpy.mockRestore();
  });

  it("refreshes a valid access token when its stored user ID is missing", async () => {
    vi.mocked(loadTokens).mockResolvedValue({
      accessToken: "stored-access",
      refreshToken: "stored-refresh",
      expiresAt: new Date("2099-01-01T00:00:00Z"),
      scopes: null,
    });
    const refreshSpy = vi.spyOn(WhoopClient, "refreshAccessToken").mockResolvedValue({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      userId: 67890,
      expiresInSeconds: 3600,
    });

    await expect(resolveWhoopTokens({ db: makeDb(), userId: "user-1" })).resolves.toEqual({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      userId: 67890,
      expiresInSeconds: 3600,
    });

    expect(refreshSpy).toHaveBeenCalledWith("stored-refresh", globalThis.fetch);
    expect(saveTokens).toHaveBeenCalledWith(
      expect.anything(),
      "whoop",
      expect.objectContaining({ scopes: "userId:67890" }),
      "user-1",
    );
  });

  it("deletes stored tokens when Cognito rejects the refresh token", async () => {
    vi.mocked(loadTokens).mockResolvedValue({
      accessToken: "stored-access",
      refreshToken: "stored-refresh",
      expiresAt: new Date("2020-01-01T00:00:00Z"),
      scopes: "userId:12345",
    });

    const refreshError = new Error(
      "WHOOP Cognito NotAuthorizedException: Incorrect username or password.",
    );
    const refreshSpy = vi.spyOn(WhoopClient, "refreshAccessToken").mockRejectedValue(refreshError);

    const db = makeDb();
    await expect(resolveWhoopTokens({ db, userId: "user-1" })).rejects.toMatchObject({
      authFailureReason: "refresh_token_revoked",
      cause: refreshError,
    });

    expect(deleteTokens).toHaveBeenCalledWith(db, "whoop", "user-1");
    refreshSpy.mockRestore();
  });

  it.each([
    {
      accessToken: "",
      label: "empty access token",
      refreshToken: "new-refresh",
    },
    {
      accessToken: "new-access",
      label: "empty refresh token",
      refreshToken: "",
    },
  ])("rejects a refresh payload with an $label", async ({ accessToken, refreshToken }) => {
    vi.mocked(loadTokens).mockResolvedValue({
      accessToken: "stored-access",
      refreshToken: "stored-refresh",
      expiresAt: new Date("2020-01-01T00:00:00Z"),
      scopes: "userId:12345",
    });

    const refreshSpy = vi.spyOn(WhoopClient, "refreshAccessToken").mockResolvedValue({
      accessToken,
      refreshToken,
      userId: 12345,
      expiresInSeconds: 3600,
    });

    await expect(resolveWhoopTokens({ db: makeDb(), userId: "user-1" })).rejects.toThrow();
    expect(saveTokens).not.toHaveBeenCalled();
    refreshSpy.mockRestore();
  });

  it("accepts multi-character access and refresh tokens", async () => {
    vi.mocked(loadTokens).mockResolvedValue({
      accessToken: "stored-access",
      refreshToken: "stored-refresh",
      expiresAt: new Date("2020-01-01T00:00:00Z"),
      scopes: "userId:12345",
    });
    const refreshedAccessToken = "access-token-with-more-than-one-character";
    const refreshedRefreshToken = "refresh-token-with-more-than-one-character";
    vi.spyOn(WhoopClient, "refreshAccessToken").mockResolvedValue({
      accessToken: refreshedAccessToken,
      refreshToken: refreshedRefreshToken,
      userId: 12345,
      expiresInSeconds: 3600,
    });

    await expect(resolveWhoopTokens({ db: makeDb(), userId: "user-1" })).resolves.toMatchObject({
      accessToken: refreshedAccessToken,
      refreshToken: refreshedRefreshToken,
    });
    expect(saveTokens).toHaveBeenCalledWith(
      expect.anything(),
      "whoop",
      expect.objectContaining({
        accessToken: refreshedAccessToken,
        refreshToken: refreshedRefreshToken,
      }),
      "user-1",
    );
  });

  it("enforces refresh token field boundaries after module initialization", async () => {
    vi.resetModules();
    const tokenStore = await import("../../db/tokens.ts");
    const { WhoopClient: FreshWhoopClient } = await import("@dofek/whoop/client");
    const { resolveWhoopTokens: resolveWithFreshSchema } = await import("./resolve-tokens.ts");
    vi.mocked(tokenStore.loadTokens).mockResolvedValue({
      accessToken: "stored-access",
      refreshToken: "stored-refresh",
      expiresAt: new Date("2020-01-01T00:00:00Z"),
      scopes: "userId:12345",
    });
    vi.spyOn(FreshWhoopClient, "refreshAccessToken")
      .mockResolvedValueOnce({
        accessToken: "valid-access-token",
        refreshToken: "valid-refresh-token",
        userId: 12345,
        expiresInSeconds: 3600,
      })
      .mockResolvedValueOnce({
        accessToken: "",
        refreshToken: "",
        userId: 12345,
        expiresInSeconds: 3600,
      });

    await expect(resolveWithFreshSchema({ db: makeDb(), userId: "user-1" })).resolves.toMatchObject(
      {
        accessToken: "valid-access-token",
        refreshToken: "valid-refresh-token",
      },
    );
    await expect(resolveWithFreshSchema({ db: makeDb(), userId: "user-1" })).rejects.toThrow();
  });
});
