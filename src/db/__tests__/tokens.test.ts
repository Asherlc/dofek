import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
    expect(loaded).not.toBeNull();
    expect(loaded?.accessToken).toBe("access-123");
    expect(loaded?.refreshToken).toBe("refresh-456");
    expect(loaded?.scopes).toBe("user_read workouts_read");
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
});
