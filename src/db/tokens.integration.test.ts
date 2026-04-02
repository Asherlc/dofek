import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_USER_ID } from "./schema.ts";
import { setupTestDatabase, type TestContext } from "./test-helpers.ts";
import { ensureProvider, loadTokens, saveTokens } from "./tokens.ts";

describe("Token storage (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestDatabase();
  }, 60_000);

  afterAll(async () => {
    await ctx?.cleanup();
  });

  it("ensureProvider inserts a provider row if missing", async () => {
    await ensureProvider(ctx.db, "wahoo", "Wahoo", undefined, TEST_USER_ID);
    const again = await ensureProvider(ctx.db, "wahoo", "Wahoo", undefined, TEST_USER_ID);
    expect(again).toBe("wahoo");
  });

  it("saveTokens inserts and loadTokens retrieves", async () => {
    await ensureProvider(ctx.db, "wahoo", "Wahoo", undefined, TEST_USER_ID);

    const tokens = {
      accessToken: "access-123",
      refreshToken: "refresh-456",
      expiresAt: new Date("2026-06-01T00:00:00Z"),
      scopes: "user_read workouts_read",
    };

    await saveTokens(ctx.db, "wahoo", tokens, TEST_USER_ID);

    const loaded = await loadTokens(ctx.db, "wahoo", TEST_USER_ID);
    expect(loaded).toEqual({
      accessToken: "access-123",
      refreshToken: "refresh-456",
      expiresAt: new Date("2026-06-01T00:00:00Z"),
      scopes: "user_read workouts_read",
    });
  });

  it("saveTokens upserts (overwrites existing tokens)", async () => {
    await ensureProvider(ctx.db, "wahoo", "Wahoo", undefined, TEST_USER_ID);

    await saveTokens(
      ctx.db,
      "wahoo",
      {
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: new Date("2026-01-01T00:00:00Z"),
        scopes: "user_read",
      },
      TEST_USER_ID,
    );

    await saveTokens(
      ctx.db,
      "wahoo",
      {
        accessToken: "new-access",
        refreshToken: "new-refresh",
        expiresAt: new Date("2026-12-01T00:00:00Z"),
        scopes: "user_read workouts_read",
      },
      TEST_USER_ID,
    );

    const loaded = await loadTokens(ctx.db, "wahoo", TEST_USER_ID);
    expect(loaded?.accessToken).toBe("new-access");
    expect(loaded?.refreshToken).toBe("new-refresh");
  });

  it("isolates provider tokens per user", async () => {
    const firstUserId = "11111111-1111-1111-1111-111111111111";
    const secondUserId = "22222222-2222-2222-2222-222222222222";

    await ctx.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name) VALUES (${firstUserId}, 'User One') ON CONFLICT DO NOTHING`,
    );
    await ctx.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name) VALUES (${secondUserId}, 'User Two') ON CONFLICT DO NOTHING`,
    );
    await ensureProvider(ctx.db, "wahoo", "Wahoo", undefined, TEST_USER_ID);

    await saveTokens(
      ctx.db,
      "wahoo",
      {
        accessToken: "user-1-access",
        refreshToken: "user-1-refresh",
        expiresAt: new Date("2026-01-01T00:00:00Z"),
        scopes: "user_read",
      },
      firstUserId,
    );
    await saveTokens(
      ctx.db,
      "wahoo",
      {
        accessToken: "user-2-access",
        refreshToken: "user-2-refresh",
        expiresAt: new Date("2026-12-01T00:00:00Z"),
        scopes: "user_read workouts_read",
      },
      secondUserId,
    );

    const firstLoaded = await loadTokens(ctx.db, "wahoo", firstUserId);
    const secondLoaded = await loadTokens(ctx.db, "wahoo", secondUserId);

    expect(firstLoaded?.accessToken).toBe("user-1-access");
    expect(secondLoaded?.accessToken).toBe("user-2-access");
  });

  it("loadTokens returns null for unknown provider", async () => {
    const loaded = await loadTokens(ctx.db, "nonexistent", TEST_USER_ID);
    expect(loaded).toBeNull();
  });

  it("loadTokens returns tokens with null scopes when scopes not set", async () => {
    await ensureProvider(ctx.db, "no-scopes-provider", "No Scopes", undefined, TEST_USER_ID);
    await saveTokens(
      ctx.db,
      "no-scopes-provider",
      {
        accessToken: "a",
        refreshToken: "r",
        expiresAt: new Date("2026-06-01T00:00:00Z"),
        scopes: null,
      },
      TEST_USER_ID,
    );
    const loaded = await loadTokens(ctx.db, "no-scopes-provider", TEST_USER_ID);
    expect(loaded).toEqual({
      accessToken: "a",
      refreshToken: "r",
      expiresAt: new Date("2026-06-01T00:00:00Z"),
      scopes: null,
    });
  });

  it("ensureProvider keeps existing owner when upserting from another user", async () => {
    const testUserId = "33333333-3333-3333-3333-333333333333";
    await ctx.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name) VALUES (${testUserId}, 'Test User') ON CONFLICT DO NOTHING`,
    );

    await ensureProvider(ctx.db, "user-test-provider", "Test Provider", undefined, TEST_USER_ID);
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
    expect(rows[0]?.user_id).toBe(TEST_USER_ID);
    expect(rows[0]?.name).toBe("Test Provider Updated");
  });

  it("ensureProvider stores explicit user owner", async () => {
    await ensureProvider(ctx.db, "scoped-provider", "Scoped Provider", undefined, TEST_USER_ID);

    const rows = await ctx.db.execute<{ user_id: string }>(
      sql`SELECT user_id FROM fitness.provider WHERE id = 'scoped-provider'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.user_id).toBe(TEST_USER_ID);
  });
});
