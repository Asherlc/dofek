import { describe, it, expect, vi, beforeEach } from "vitest";
import { ensureProvider, saveTokens, loadTokens } from "../tokens.ts";

// Mock drizzle's eq function
vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ column: col, value: val })),
}));

function createMockDb() {
  const onConflictDoUpdateFn = vi.fn().mockResolvedValue(undefined);
  const valuesFn = vi.fn(() => ({ onConflictDoUpdate: onConflictDoUpdateFn }));
  const insertFn = vi.fn(() => ({ values: valuesFn }));

  const limitFn = vi.fn().mockResolvedValue([]);
  const whereFn = vi.fn(() => ({ limit: limitFn }));
  const fromFn = vi.fn(() => ({ where: whereFn }));
  const selectFn = vi.fn(() => ({ from: fromFn }));

  return {
    insert: insertFn,
    select: selectFn,
    _valuesFn: valuesFn,
    _onConflictDoUpdateFn: onConflictDoUpdateFn,
    _limitFn: limitFn,
    _whereFn: whereFn,
    _fromFn: fromFn,
  };
}

type MockDb = ReturnType<typeof createMockDb>;

describe("ensureProvider", () => {
  let mockDb: MockDb;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it("inserts a provider with id, name, and apiBaseUrl", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: mock DB
    const result = await ensureProvider(mockDb as any, "wahoo", "Wahoo", "https://api.wahoo.com");

    expect(result).toBe("wahoo");
    expect(mockDb.insert).toHaveBeenCalled();
    expect(mockDb._valuesFn).toHaveBeenCalledWith({
      id: "wahoo",
      name: "Wahoo",
      apiBaseUrl: "https://api.wahoo.com",
    });
    expect(mockDb._onConflictDoUpdateFn).toHaveBeenCalled();
  });

  it("includes userId when provided", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: mock DB
    await ensureProvider(mockDb as any, "whoop", "WHOOP", undefined, "user-123");

    expect(mockDb._valuesFn).toHaveBeenCalledWith({
      id: "whoop",
      name: "WHOOP",
      apiBaseUrl: undefined,
      userId: "user-123",
    });
  });

  it("omits userId when not provided", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: mock DB
    await ensureProvider(mockDb as any, "wahoo", "Wahoo");

    const valuesArg = mockDb._valuesFn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(valuesArg).not.toHaveProperty("userId");
  });

  it("returns the provider id", async () => {
    // biome-ignore lint/suspicious/noExplicitAny: mock DB
    const result = await ensureProvider(mockDb as any, "test-id", "Test");
    expect(result).toBe("test-id");
  });
});

describe("saveTokens", () => {
  let mockDb: MockDb;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it("upserts OAuth tokens for a provider", async () => {
    const tokens = {
      accessToken: "access-123",
      refreshToken: "refresh-456",
      expiresAt: new Date("2026-04-01T00:00:00Z"),
      scopes: "read write",
    };

    // biome-ignore lint/suspicious/noExplicitAny: mock DB
    await saveTokens(mockDb as any, "wahoo", tokens);

    expect(mockDb.insert).toHaveBeenCalled();
    expect(mockDb._valuesFn).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "wahoo",
        accessToken: "access-123",
        refreshToken: "refresh-456",
        expiresAt: new Date("2026-04-01T00:00:00Z"),
        scopes: "read write",
      }),
    );
    expect(mockDb._onConflictDoUpdateFn).toHaveBeenCalled();
  });

  it("handles null refreshToken and scopes", async () => {
    const tokens = {
      accessToken: "access-only",
      refreshToken: null,
      expiresAt: new Date("2026-05-01T00:00:00Z"),
      scopes: null,
    };

    // biome-ignore lint/suspicious/noExplicitAny: mock DB
    await saveTokens(mockDb as any, "strava", tokens);

    expect(mockDb._valuesFn).toHaveBeenCalledWith(
      expect.objectContaining({
        refreshToken: null,
        scopes: null,
      }),
    );
  });
});

describe("loadTokens", () => {
  let mockDb: MockDb;

  beforeEach(() => {
    mockDb = createMockDb();
  });

  it("returns token set when found", async () => {
    mockDb._limitFn.mockResolvedValue([
      {
        accessToken: "access-123",
        refreshToken: "refresh-456",
        expiresAt: new Date("2026-04-01T00:00:00Z"),
        scopes: "read",
      },
    ]);

    // biome-ignore lint/suspicious/noExplicitAny: mock DB
    const result = await loadTokens(mockDb as any, "wahoo");

    expect(result).toEqual({
      accessToken: "access-123",
      refreshToken: "refresh-456",
      expiresAt: new Date("2026-04-01T00:00:00Z"),
      scopes: "read",
    });
  });

  it("returns null when no tokens exist", async () => {
    mockDb._limitFn.mockResolvedValue([]);

    // biome-ignore lint/suspicious/noExplicitAny: mock DB
    const result = await loadTokens(mockDb as any, "nonexistent");

    expect(result).toBeNull();
  });

  it("returns null when row is undefined", async () => {
    mockDb._limitFn.mockResolvedValue([undefined]);

    // biome-ignore lint/suspicious/noExplicitAny: mock DB
    const result = await loadTokens(mockDb as any, "wahoo");

    expect(result).toBeNull();
  });

  it("returns null for scopes when row.scopes is null", async () => {
    mockDb._limitFn.mockResolvedValue([
      {
        accessToken: "access-123",
        refreshToken: null,
        expiresAt: new Date("2026-04-01T00:00:00Z"),
        scopes: null,
      },
    ]);

    // biome-ignore lint/suspicious/noExplicitAny: mock DB
    const result = await loadTokens(mockDb as any, "wahoo");

    expect(result).toEqual({
      accessToken: "access-123",
      refreshToken: null,
      expiresAt: new Date("2026-04-01T00:00:00Z"),
      scopes: null,
    });
  });
});
