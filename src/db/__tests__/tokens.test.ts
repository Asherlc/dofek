import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_USER_ID } from "../schema.ts";
import { ensureProvider, loadTokens, saveTokens } from "../tokens.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";

describe("Token storage (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestDatabase();
  }, 60_000);

  afterAll(async () => {
    await ctx?.cleanup();
  });

  it("ensureProvider inserts a provider row if missing", async () => {
    await ensureProvider(ctx.db, "wahoo", "Wahoo");
    const again = await ensureProvider(ctx.db, "wahoo", "Wahoo");
    expect(again).toBe("wahoo");
  });

  it("saveTokens inserts and loadTokens retrieves", async () => {
    await ensureProvider(ctx.db, "wahoo", "Wahoo");

    const tokens = {
      accessToken: "access-123",
      refreshToken: "refresh-456",
      expiresAt: new Date("2026-06-01T00:00:00Z"),
      scopes: "user_read workouts_read",
    };

    await saveTokens(ctx.db, "wahoo", tokens);

    const loaded = await loadTokens(ctx.db, "wahoo");
    expect(loaded).toEqual({
      accessToken: "access-123",
      refreshToken: "refresh-456",
      expiresAt: new Date("2026-06-01T00:00:00Z"),
      scopes: "user_read workouts_read",
    });
  });

  it("saveTokens upserts (overwrites existing tokens)", async () => {
    await ensureProvider(ctx.db, "wahoo", "Wahoo");

    await saveTokens(ctx.db, "wahoo", {
      accessToken: "old-access",
      refreshToken: "old-refresh",
      expiresAt: new Date("2026-01-01T00:00:00Z"),
      scopes: "user_read",
    });

    await saveTokens(ctx.db, "wahoo", {
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresAt: new Date("2026-12-01T00:00:00Z"),
      scopes: "user_read workouts_read",
    });

    const loaded = await loadTokens(ctx.db, "wahoo");
    expect(loaded?.accessToken).toBe("new-access");
    expect(loaded?.refreshToken).toBe("new-refresh");
  });

  it("loadTokens returns null for unknown provider", async () => {
    const loaded = await loadTokens(ctx.db, "nonexistent");
    expect(loaded).toBeNull();
  });

  it("loadTokens returns tokens with null scopes when scopes not set", async () => {
    await ensureProvider(ctx.db, "no-scopes-provider", "No Scopes");
    await saveTokens(ctx.db, "no-scopes-provider", {
      accessToken: "a",
      refreshToken: "r",
      expiresAt: new Date("2026-06-01T00:00:00Z"),
      scopes: null,
    });
    const loaded = await loadTokens(ctx.db, "no-scopes-provider");
    expect(loaded).toEqual({
      accessToken: "a",
      refreshToken: "r",
      expiresAt: new Date("2026-06-01T00:00:00Z"),
      scopes: null,
    });
  });

  it("ensureProvider upserts userId when provided", async () => {
    // Create a second user to test userId override
    const testUserId = "11111111-1111-1111-1111-111111111111";
    await ctx.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name) VALUES (${testUserId}, 'Test User') ON CONFLICT DO NOTHING`,
    );

    await ensureProvider(ctx.db, "user-test-provider", "Test Provider");
    // Re-insert with a userId — should update the existing row
    await ensureProvider(
      ctx.db,
      "user-test-provider",
      "Test Provider Updated",
      undefined,
      testUserId,
    );

    const rows = await ctx.db.execute<{ user_id: string; name: string }>(
      sql`SELECT user_id, name FROM fitness.provider WHERE id = 'user-test-provider'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.user_id).toBe(testUserId);
    expect(rows[0]?.name).toBe("Test Provider Updated");
  });

  it("ensureProvider defaults to DEFAULT_USER_ID when userId not provided", async () => {
    await ensureProvider(ctx.db, "default-user-provider", "Default Provider");

    const rows = await ctx.db.execute<{ user_id: string }>(
      sql`SELECT user_id FROM fitness.provider WHERE id = 'default-user-provider'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.user_id).toBe(DEFAULT_USER_ID);
  });
});
