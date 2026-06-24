import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WhoopClient } from "whoop-whoop/client";
import type { SyncDatabase } from "../../db/index.ts";
import {
  buildWhoopTokenSet,
  parseWhoopUserIdFromScopes,
  resolveWhoopTokens,
  saveWhoopAuthTokens,
  WHOOP_ACCESS_TOKEN_TTL_MS,
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
  });

  it("stores userId in scopes with a 24h expiry", () => {
    expect(
      buildWhoopTokenSet({
        accessToken: "access",
        refreshToken: "refresh",
        userId: 42,
      }),
    ).toEqual({
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: new Date(Date.now() + WHOOP_ACCESS_TOKEN_TTL_MS),
      scopes: "userId:42",
    });
  });
});

describe("saveWhoopAuthTokens", () => {
  it("persists tokens for the whoop provider", async () => {
    const db = makeDb();
    await saveWhoopAuthTokens(
      db,
      { accessToken: "access", refreshToken: "refresh", userId: 7 },
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
    vi.mocked(loadTokens).mockReset();
    vi.mocked(saveTokens).mockReset();
    vi.mocked(deleteTokens).mockReset();
  });

  it("reuses a valid access token without calling Cognito refresh", async () => {
    vi.mocked(loadTokens).mockResolvedValue({
      accessToken: "stored-access",
      refreshToken: "stored-refresh",
      expiresAt: new Date("2099-01-01T00:00:00Z"),
      scopes: "userId:12345",
    });

    let cognitoCalls = 0;
    const fetchFn: typeof globalThis.fetch = (input) => {
      if (input.toString().includes("auth-service/v3/whoop")) {
        cognitoCalls += 1;
      }
      return Promise.resolve(new Response("Not found", { status: 404 }));
    };

    await expect(resolveWhoopTokens({ db: makeDb(), fetchFn, userId: "user-1" })).resolves.toEqual({
      accessToken: "stored-access",
      refreshToken: "stored-refresh",
      userId: 12345,
    });

    expect(cognitoCalls).toBe(0);
    expect(saveTokens).not.toHaveBeenCalled();
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
    });

    await expect(resolveWhoopTokens({ db: makeDb(), userId: "user-1" })).resolves.toEqual({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      userId: 12345,
    });

    expect(refreshSpy).toHaveBeenCalledWith("stored-refresh", globalThis.fetch);
    expect(saveTokens).toHaveBeenCalled();
    refreshSpy.mockRestore();
  });

  it("deletes stored tokens when Cognito rejects the refresh token", async () => {
    vi.mocked(loadTokens).mockResolvedValue({
      accessToken: "stored-access",
      refreshToken: "stored-refresh",
      expiresAt: new Date("2020-01-01T00:00:00Z"),
      scopes: "userId:12345",
    });

    const refreshSpy = vi
      .spyOn(WhoopClient, "refreshAccessToken")
      .mockRejectedValue(
        new Error("WHOOP Cognito NotAuthorizedException: Incorrect username or password."),
      );

    const db = makeDb();
    await expect(resolveWhoopTokens({ db, userId: "user-1" })).rejects.toMatchObject({
      authFailureReason: "refresh_token_revoked",
    });

    expect(deleteTokens).toHaveBeenCalledWith(db, "whoop", "user-1");
    refreshSpy.mockRestore();
  });
});
