import { beforeEach, describe, expect, it } from "vitest";
import { createMockDatabase } from "../providers/test-helpers.ts";
import {
  encryptCredentialValue,
  isEncryptedCredentialValue,
} from "../security/credential-encryption.ts";
import { TEST_USER_ID } from "./schema/core.ts";
import { oauthToken, providerConnection, webhookSubscription } from "./schema/reference.ts";
import {
  connectProviderWithTokens,
  deleteProviderAuthorization,
  deleteTokens,
  ensureProvider,
  loadTokens,
  saveTokens,
} from "./tokens.ts";

describe("ensureProvider", () => {
  let mock: ReturnType<typeof createMockDatabase>;

  beforeEach(() => {
    mock = createMockDatabase();
  });

  it("atomically ensures the provider catalog row and user connection", async () => {
    const result = await ensureProvider(
      mock.db,
      "wahoo",
      "Wahoo",
      "https://api.wahoo.com",
      TEST_USER_ID,
    );

    expect(result).toBe("wahoo");
    expect(mock.spies.execute).toHaveBeenCalledOnce();
    const query = mock.spies.execute.mock.calls[0]?.[0];
    const serializedQuery = JSON.stringify(query);
    expect(serializedQuery).toContain("INSERT INTO fitness.provider");
    expect(serializedQuery).toContain("INSERT INTO fitness.provider_connection");
    expect(serializedQuery).toContain("ON CONFLICT (user_id, provider_id) DO NOTHING");
    expect(serializedQuery).toContain("https://api.wahoo.com");
    expect(serializedQuery).toContain(TEST_USER_ID);
  });

  it("never writes the connection owner into the legacy provider owner column", async () => {
    await ensureProvider(mock.db, "whoop", "WHOOP", undefined, "user-123");

    const query = mock.spies.execute.mock.calls[0]?.[0];
    const serializedQuery = JSON.stringify(query);
    expect(serializedQuery).toContain("VALUES");
    expect(serializedQuery).toContain("NULL");
    expect(serializedQuery).toContain("user-123");
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

  it("includes provider and user context when the atomic write fails", async () => {
    mock.spies.execute.mockRejectedValueOnce(new Error("database unavailable"));

    await expect(
      ensureProvider(mock.db, "wahoo", "Wahoo", undefined, TEST_USER_ID),
    ).rejects.toThrow(
      `ensureProvider(wahoo) failed for user ${TEST_USER_ID}: database unavailable`,
    );
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
      providerAccountId: "polar-user-123",
      scopes: "read write",
    };

    await saveTokens(mock.db, "polar", tokens, TEST_USER_ID);

    const firstCall = mock.spies.values.mock.calls[0];
    const firstInsert = firstCall?.[0];
    if (!firstInsert) {
      throw new Error("Expected saveTokens to call db.insert(...).values(...)");
    }

    expect(firstInsert.accessToken).not.toBe("access-plain");
    expect(firstInsert.refreshToken).not.toBe("refresh-plain");
    expect(firstInsert.providerAccountId).not.toBe("polar-user-123");
    expect(isEncryptedCredentialValue(firstInsert.accessToken)).toBe(true);
    expect(isEncryptedCredentialValue(firstInsert.refreshToken)).toBe(true);
    expect(isEncryptedCredentialValue(firstInsert.providerAccountId)).toBe(true);
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

describe("connectProviderWithTokens", () => {
  it("runs connection creation and encrypted token persistence in one transaction", async () => {
    const mock = createMockDatabase();
    let transactionCalls = 0;
    async function transaction<T>(
      callback: (transactionDatabase: typeof mock.db) => Promise<T>,
    ): Promise<T> {
      transactionCalls++;
      return callback(mock.db);
    }
    const tokens = {
      accessToken: "atomic-access",
      refreshToken: "atomic-refresh",
      expiresAt: new Date("2026-09-01T00:00:00Z"),
      scopes: "read",
    };

    await connectProviderWithTokens(
      { transaction },
      {
        id: "atomic-provider",
        name: "Atomic Provider",
        apiBaseUrl: "https://example.com/api",
      },
      tokens,
      TEST_USER_ID,
    );

    expect(transactionCalls).toBe(1);
    expect(mock.spies.execute).toHaveBeenCalledOnce();
    expect(mock.spies.values).toHaveBeenCalledOnce();
    expect(mock.spies.values).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: TEST_USER_ID,
        providerId: "atomic-provider",
        expiresAt: tokens.expiresAt,
        scopes: "read",
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

describe("deleteProviderAuthorization", () => {
  let mock: ReturnType<typeof createMockDatabase>;

  beforeEach(() => {
    mock = createMockDatabase();
  });

  it("atomically deletes dependent authorization state before the provider connection", async () => {
    let transactionCalls = 0;
    async function transaction<T>(
      callback: (transactionDatabase: typeof mock.db) => Promise<T>,
    ): Promise<T> {
      transactionCalls++;
      return callback(mock.db);
    }

    await deleteProviderAuthorization({ transaction }, "wahoo", TEST_USER_ID);

    expect(transactionCalls).toBe(1);
    expect(mock.spies.deleteFn.mock.calls).toEqual([
      [webhookSubscription],
      [oauthToken],
      [providerConnection],
    ]);
    expect(mock.spies.deleteWhere).toHaveBeenCalledTimes(3);
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
    const encryptedProviderAccountId = await encryptCredentialValue("provider-account-789", {
      tableName: "fitness.oauth_token",
      columnName: "provider_account_id",
      scopeId: `${TEST_USER_ID}:wahoo`,
    });
    mock.spies.limit.mockResolvedValue([
      {
        accessToken: encryptedAccessToken,
        refreshToken: encryptedRefreshToken,
        expiresAt: new Date("2026-04-01T00:00:00Z"),
        providerAccountId: encryptedProviderAccountId,
        scopes: "read",
      },
    ]);

    const result = await loadTokens(mock.db, "wahoo", TEST_USER_ID);

    expect(result).toEqual({
      accessToken: "access-123",
      refreshToken: "refresh-456",
      expiresAt: new Date("2026-04-01T00:00:00Z"),
      providerAccountId: "provider-account-789",
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
