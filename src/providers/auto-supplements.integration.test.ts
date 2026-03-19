import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_USER_ID, foodEntry, supplement, userProfile } from "../db/schema.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { AutoSupplementsProvider } from "./auto-supplements.ts";

// ============================================================
// Integration tests for sync() with real DB
// ============================================================

describe("AutoSupplementsProvider — sync() with DB (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestDatabase();
    // Ensure the default user exists
    await ctx.db
      .insert(userProfile)
      .values({ id: DEFAULT_USER_ID, name: "Test User" })
      .onConflictDoNothing();
  }, 60_000);

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  it("inserts supplement entries into the database", async () => {
    // Insert supplement definitions for the default user
    await ctx.db.insert(supplement).values([
      {
        userId: DEFAULT_USER_ID,
        name: "Vitamin D3",
        sortOrder: 0,
        vitaminDMcg: 50,
      },
      {
        userId: DEFAULT_USER_ID,
        name: "Fish Oil",
        sortOrder: 1,
        calories: 10,
        omega3Mg: 1000,
        meal: "breakfast",
      },
    ]);

    const provider = new AutoSupplementsProvider();

    // Use a since date that is today so we get exactly 1 day
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const result = await provider.sync(ctx.db, today);

    expect(result.provider).toBe("auto-supplements");
    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(2);

    // Verify entries in DB
    const rows = await ctx.db
      .select()
      .from(foodEntry)
      .where(eq(foodEntry.providerId, "auto-supplements"));
    expect(rows.length).toBeGreaterThanOrEqual(2);

    const vitD = rows.find((r) => r.foodName === "Vitamin D3");
    expect(vitD).toBeDefined();
    expect(vitD?.category).toBe("supplement");
    expect(vitD?.userId).toBe(DEFAULT_USER_ID);

    const fishOil = rows.find((r) => r.foodName === "Fish Oil");
    expect(fishOil).toBeDefined();
    expect(fishOil?.meal).toBe("breakfast");
  });

  it("upserts on re-sync (updates existing entries)", async () => {
    // Insert a supplement
    await ctx.db
      .insert(supplement)
      .values({
        userId: DEFAULT_USER_ID,
        name: "Magnesium",
        sortOrder: 0,
        magnesiumMg: 400,
      })
      .onConflictDoNothing();

    const provider = new AutoSupplementsProvider();
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);

    // Sync twice
    await provider.sync(ctx.db, today);
    const result = await provider.sync(ctx.db, today);

    expect(result.errors).toHaveLength(0);

    // Verify no duplicates for Magnesium on today's date
    const rows = await ctx.db
      .select()
      .from(foodEntry)
      .where(eq(foodEntry.providerId, "auto-supplements"));
    const todayStr = today.toISOString().slice(0, 10);
    const magCount = rows.filter((r) => r.foodName === "Magnesium" && r.date === todayStr).length;
    expect(magCount).toBe(1);
  });

  it("returns empty result when since is in the future (no dates)", async () => {
    const provider = new AutoSupplementsProvider();
    const future = new Date("2099-01-01T00:00:00Z");
    const result = await provider.sync(ctx.db, future);

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("handles multiple days in range", async () => {
    // Insert a unique supplement for this test
    await ctx.db
      .insert(supplement)
      .values({
        userId: DEFAULT_USER_ID,
        name: "TestMultiDay",
        sortOrder: 0,
        calories: 5,
      })
      .onConflictDoNothing();

    const provider = new AutoSupplementsProvider();

    // 3 days ago to today = 4 days
    const threeDaysAgo = new Date();
    threeDaysAgo.setUTCDate(threeDaysAgo.getUTCDate() - 3);
    threeDaysAgo.setUTCHours(0, 0, 0, 0);

    const result = await provider.sync(ctx.db, threeDaysAgo);

    expect(result.errors).toHaveLength(0);
    // Should have entries for multiple supplements across multiple days
    expect(result.recordsSynced).toBeGreaterThanOrEqual(4);
  });

  it("syncs supplements for multiple users independently", async () => {
    const secondUserId = "22222222-2222-2222-2222-222222222222";

    // Create second user
    await ctx.db
      .insert(userProfile)
      .values({ id: secondUserId, name: "Second User" })
      .onConflictDoNothing();

    // Insert supplements for second user
    await ctx.db.insert(supplement).values({
      userId: secondUserId,
      name: "User2 Zinc",
      sortOrder: 0,
      zincMg: 15,
    });

    const provider = new AutoSupplementsProvider();
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const result = await provider.sync(ctx.db, today);

    expect(result.errors).toHaveLength(0);

    // Verify user2's supplement entry exists with correct userId
    const rows = await ctx.db
      .select()
      .from(foodEntry)
      .where(eq(foodEntry.providerId, "auto-supplements"));
    const user2Entry = rows.find((r) => r.foodName === "User2 Zinc" && r.userId === secondUserId);
    expect(user2Entry).toBeDefined();
    expect(user2Entry?.zincMg).toBe(15);
  });

  it("returns empty result when no supplements exist in DB", async () => {
    // Clean up all supplements
    await ctx.db.delete(supplement);

    const provider = new AutoSupplementsProvider();
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const result = await provider.sync(ctx.db, today);

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(0);
  });
});
