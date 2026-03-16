import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockDatabase } from "../providers/test-helpers.ts";
import { ensureProvider, loadTokens, saveTokens } from "./tokens.ts";

// Mock drizzle's eq function
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ column: col, value: val })),
}));

describe("ensureProvider", () => {
  let mock: ReturnType<typeof createMockDatabase>;

  beforeEach(() => {
    mock = createMockDatabase();
  });

  it("inserts a provider with id, name, and apiBaseUrl", async () => {
    const result = await ensureProvider(mock.db, "wahoo", "Wahoo", "https://api.wahoo.com");

    expect(result).toBe("wahoo");
    expect(mock.spies.insert).toHaveBeenCalled();
    expect(mock.spies.values).toHaveBeenCalledWith({
      id: "wahoo",
      name: "Wahoo",
      apiBaseUrl: "https://api.wahoo.com",
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

  it("omits userId when not provided", async () => {
    await ensureProvider(mock.db, "wahoo", "Wahoo");

    // Access mock call args via the values spy
    const calls: unknown[][] = mock.spies.values.mock.calls;
    const valuesArg: unknown = calls[0]?.[0];
    expect(valuesArg).not.toHaveProperty("userId");
  });

  it("returns the provider id", async () => {
    const result = await ensureProvider(mock.db, "test-id", "Test");
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

    await saveTokens(mock.db, "wahoo", tokens);

    expect(mock.spies.insert).toHaveBeenCalled();
    expect(mock.spies.values).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "wahoo",
        accessToken: "access-123",
        refreshToken: "refresh-456",
        expiresAt: new Date("2026-04-01T00:00:00Z"),
        scopes: "read write",
      }),
    );
    expect(mock.spies.onConflictDoUpdate).toHaveBeenCalled();
  });

  it("handles null refreshToken and scopes", async () => {
    const tokens = {
      accessToken: "access-only",
      refreshToken: null,
      expiresAt: new Date("2026-05-01T00:00:00Z"),
      scopes: null,
    };

    await saveTokens(mock.db, "strava", tokens);

    expect(mock.spies.values).toHaveBeenCalledWith(
      expect.objectContaining({
        refreshToken: null,
        scopes: null,
      }),
    );
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

    const result = await loadTokens(mock.db, "wahoo");

    expect(result).toEqual({
      accessToken: "access-123",
      refreshToken: "refresh-456",
      expiresAt: new Date("2026-04-01T00:00:00Z"),
      scopes: "read",
    });
  });

  it("returns null when no tokens exist", async () => {
    mock.spies.limit.mockResolvedValue([]);

    const result = await loadTokens(mock.db, "nonexistent");

    expect(result).toBeNull();
  });

  it("returns null when row is undefined", async () => {
    mock.spies.limit.mockResolvedValue([undefined]);

    const result = await loadTokens(mock.db, "wahoo");

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

    const result = await loadTokens(mock.db, "wahoo");

    expect(result).toEqual({
      accessToken: "access-123",
      refreshToken: null,
      expiresAt: new Date("2026-04-01T00:00:00Z"),
      scopes: null,
    });
  });
});
