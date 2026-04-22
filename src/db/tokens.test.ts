import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockDatabase } from "../providers/test-helpers.ts";
import {
  encryptCredentialValue,
  isEncryptedCredentialValue,
} from "../security/credential-encryption.ts";
import { TEST_USER_ID } from "./schema.ts";
import { deleteTokens, ensureProvider, loadTokens, saveTokens } from "./tokens.ts";

// Mock drizzle's query builder helpers
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ column: col, value: val })),
  and: vi.fn((...conditions) => ({ conditions })),
}));

describe("ensureProvider", () => {
  let mock: ReturnType<typeof createMockDatabase>;

  beforeEach(() => {
    mock = createMockDatabase();
  });

  it("inserts a provider with id, name, and apiBaseUrl", async () => {
    const result = await ensureProvider(
      mock.db,
      "wahoo",
      "Wahoo",
      "https://api.wahoo.com",
      TEST_USER_ID,
    );

    expect(result).toBe("wahoo");
    expect(mock.spies.insert).toHaveBeenCalled();
    expect(mock.spies.values).toHaveBeenCalledWith({
      id: "wahoo",
      name: "Wahoo",
      apiBaseUrl: "https://api.wahoo.com",
      userId: TEST_USER_ID,
    });
    expect(mock.spies.onConflictDoUpdate).toHaveBeenCalled();
  });

  it("includes userId when provided", async () => {
    await ensureProvider(mock.db, "whoop", "WHOOP", undefined, "user-123");

    expect(mock.spies.values).toHaveBeenCalledWith({
      id: "whoop",
      name: "WHOOP",
      apiBaseUrl: undefined,
      userId: "user-123",
    });
  });

  it("throws when userId is not provided and context is absent", async () => {
    const priorTokenUserId = process.env.TEST_TOKEN_USER_ID;
    delete process.env.TEST_TOKEN_USER_ID;
    try {
      await expect(ensureProvider(mock.db, "wahoo", "Wahoo")).rejects.toThrow(
        "Token operation requires userId",
      );
    } finally {
      if (priorTokenUserId) {
        process.env.TEST_TOKEN_USER_ID = priorTokenUserId;
      } else {
        delete process.env.TEST_TOKEN_USER_ID;
      }
    }
  });

  it("returns the provider id", async () => {
    const result = await ensureProvider(mock.db, "test-id", "Test", undefined, TEST_USER_ID);
    expect(result).toBe("test-id");
  });
});

describe("saveTokens", () => {
  let mock: ReturnType<typeof createMockDatabase>;

  beforeEach(() => {
    mock = createMockDatabase();
  });

  it("upserts OAuth tokens for a provider", async () => {
    const tokens = {
      accessToken: "access-123",
      refreshToken: "refresh-456",
      expiresAt: new Date("2026-04-01T00:00:00Z"),
      scopes: "read write",
    };

    await saveTokens(mock.db, "wahoo", tokens, TEST_USER_ID);

    expect(mock.spies.insert).toHaveBeenCalled();
    expect(mock.spies.values).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: TEST_USER_ID,
        providerId: "wahoo",
        expiresAt: new Date("2026-04-01T00:00:00Z"),
        scopes: "read write",
      }),
    );
    expect(mock.spies.onConflictDoUpdate).toHaveBeenCalled();
  });

  it("encrypts access and refresh tokens before persisting", async () => {
    const tokens = {
      accessToken: "access-plain",
      refreshToken: "refresh-plain",
      expiresAt: new Date("2026-04-01T00:00:00Z"),
      scopes: "read write",
    };

    await saveTokens(mock.db, "wahoo", tokens, TEST_USER_ID);

    const firstCall = mock.spies.values.mock.calls[0];
    const firstInsert = firstCall?.[0];
    if (!firstInsert) {
      throw new Error("Expected saveTokens to call db.insert(...).values(...)");
    }

    expect(firstInsert.accessToken).not.toBe("access-plain");
    expect(firstInsert.refreshToken).not.toBe("refresh-plain");
    expect(isEncryptedCredentialValue(firstInsert.accessToken)).toBe(true);
    expect(isEncryptedCredentialValue(firstInsert.refreshToken)).toBe(true);
  });

  it("handles null refreshToken and scopes", async () => {
    const tokens = {
      accessToken: "access-only",
      refreshToken: null,
      expiresAt: new Date("2026-05-01T00:00:00Z"),
      scopes: null,
    };

    await saveTokens(mock.db, "strava", tokens, TEST_USER_ID);

    expect(mock.spies.values).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: TEST_USER_ID,
        refreshToken: null,
        scopes: null,
      }),
    );
  });
});

describe("deleteTokens", () => {
  let mock: ReturnType<typeof createMockDatabase>;

  beforeEach(() => {
    mock = createMockDatabase();
  });

  it("deletes tokens for the given provider", async () => {
    await deleteTokens(mock.db, "polar", TEST_USER_ID);

    expect(mock.spies.deleteFn).toHaveBeenCalled();
    expect(mock.spies.deleteWhere).toHaveBeenCalled();
  });
});

describe("loadTokens", () => {
  let mock: ReturnType<typeof createMockDatabase>;

  beforeEach(() => {
    mock = createMockDatabase();
  });

  it("returns token set when found", async () => {
    mock.spies.limit.mockResolvedValue([
      {
        accessToken: "access-123",
        refreshToken: "refresh-456",
        expiresAt: new Date("2026-04-01T00:00:00Z"),
        scopes: "read",
      },
    ]);

    const result = await loadTokens(mock.db, "wahoo", TEST_USER_ID);

    expect(result).toEqual({
      accessToken: "access-123",
      refreshToken: "refresh-456",
      expiresAt: new Date("2026-04-01T00:00:00Z"),
      scopes: "read",
    });
  });

  it("decrypts encrypted token fields when rows are encrypted", async () => {
    const encryptedAccessToken = await encryptCredentialValue("access-123", {
      tableName: "fitness.oauth_token",
      columnName: "access_token",
      scopeId: `${TEST_USER_ID}:wahoo`,
    });
    const encryptedRefreshToken = await encryptCredentialValue("refresh-456", {
      tableName: "fitness.oauth_token",
      columnName: "refresh_token",
      scopeId: `${TEST_USER_ID}:wahoo`,
    });
    mock.spies.limit.mockResolvedValue([
      {
        accessToken: encryptedAccessToken,
        refreshToken: encryptedRefreshToken,
        expiresAt: new Date("2026-04-01T00:00:00Z"),
        scopes: "read",
      },
    ]);

    const result = await loadTokens(mock.db, "wahoo", TEST_USER_ID);

    expect(result).toEqual({
      accessToken: "access-123",
      refreshToken: "refresh-456",
      expiresAt: new Date("2026-04-01T00:00:00Z"),
      scopes: "read",
    });
  });

  it("returns null when no tokens exist", async () => {
    mock.spies.limit.mockResolvedValue([]);

    const result = await loadTokens(mock.db, "nonexistent", TEST_USER_ID);

    expect(result).toBeNull();
  });

  it("returns null when row is undefined", async () => {
    mock.spies.limit.mockResolvedValue([undefined]);

    const result = await loadTokens(mock.db, "wahoo", TEST_USER_ID);

    expect(result).toBeNull();
  });

  it("returns null for scopes when row.scopes is null", async () => {
    mock.spies.limit.mockResolvedValue([
      {
        accessToken: "access-123",
        refreshToken: null,
        expiresAt: new Date("2026-04-01T00:00:00Z"),
        scopes: null,
      },
    ]);

    const result = await loadTokens(mock.db, "wahoo", TEST_USER_ID);

    expect(result).toEqual({
      accessToken: "access-123",
      refreshToken: null,
      expiresAt: new Date("2026-04-01T00:00:00Z"),
      scopes: null,
    });
  });
});
