import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { foodEntry, oauthToken } from "../db/schema.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { ensureProvider, saveTokens } from "../db/tokens.ts";
import { type FatSecretFoodEntriesResponse, FatSecretProvider } from "./fatsecret.ts";

// ============================================================
// Fake FatSecret API responses
// ============================================================

function fakeFoodEntriesResponse(
  dateInt: string,
  entries: Array<{
    id?: string;
    name?: string;
    meal?: string;
    calories?: string;
    protein?: string;
    carbohydrate?: string;
    fat?: string;
  }> = [],
): FatSecretFoodEntriesResponse {
  return {
    food_entries: {
      food_entry: entries.map((e, i) => ({
        food_entry_id: e.id ?? `entry-${dateInt}-${i}`,
        food_entry_name: e.name ?? "Chicken Breast",
        food_entry_description: "4 oz grilled",
        food_id: "1234",
        serving_id: "5678",
        number_of_units: "1.000",
        meal: e.meal ?? "Lunch",
        date_int: dateInt,
        calories: e.calories ?? "165",
        carbohydrate: e.carbohydrate ?? "0",
        protein: e.protein ?? "31",
        fat: e.fat ?? "3.6",
        saturated_fat: "1.0",
        sodium: "74",
        fiber: "0",
        sugar: "0",
      })),
    },
  };
}

function fatsecretHandlers(responsesByDateInt: Map<string, FatSecretFoodEntriesResponse>) {
  return [
    // FatSecret API (OAuth 1.0 signed GET request)
    http.get("https://platform.fatsecret.com/rest/server.api", ({ request }) => {
      const url = new URL(request.url);
      const dateParam = url.searchParams.get("date");
      if (dateParam && responsesByDateInt.has(dateParam)) {
        return HttpResponse.json(responsesByDateInt.get(dateParam));
      }
      // No entries for this date — FatSecret returns an error
      return HttpResponse.json(
        { error: { code: 7, message: "No entries found" } },
        { status: 400 },
      );
    }),
  ];
}

const server = setupServer();

// ============================================================
// Tests
// ============================================================

describe("FatSecretProvider.sync() (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    process.env.FATSECRET_CONSUMER_KEY = "test-consumer-key";
    process.env.FATSECRET_CONSUMER_SECRET = "test-consumer-secret";
    ctx = await setupTestDatabase();
    server.listen({ onUnhandledRequest: "error" });
    await ensureProvider(ctx.db, "fatsecret", "FatSecret");
  }, 60_000);

  afterEach(() => {
    server.resetHandlers();
  });

  afterAll(async () => {
    server.close();
    if (ctx) await ctx.cleanup();
  });

  it("syncs food entries for a single day", async () => {
    // OAuth 1.0: token stored as accessToken, tokenSecret stored as refreshToken
    await saveTokens(ctx.db, "fatsecret", {
      accessToken: "oauth1-token",
      refreshToken: "oauth1-token-secret",
      expiresAt: new Date("2099-01-01T00:00:00Z"), // OAuth 1.0 tokens don't expire
      scopes: null,
    });

    // date_int for 2026-03-01: days since epoch
    const dateInt = String(Math.floor(new Date("2026-03-01T00:00:00Z").getTime() / 86400000));

    const responses = new Map<string, FatSecretFoodEntriesResponse>();
    responses.set(
      dateInt,
      fakeFoodEntriesResponse(dateInt, [
        {
          id: "entry-100",
          name: "Chicken Breast",
          meal: "Lunch",
          calories: "165",
          protein: "31",
          carbohydrate: "0",
          fat: "3.6",
        },
        {
          id: "entry-101",
          name: "Brown Rice",
          meal: "Lunch",
          calories: "216",
          protein: "5",
          carbohydrate: "45",
          fat: "1.8",
        },
      ]),
    );

    server.use(...fatsecretHandlers(responses));

    const provider = new FatSecretProvider();
    // Sync just this one day
    const since = new Date("2026-03-01T00:00:00Z");
    const result = await provider.sync(ctx.db, since);

    expect(result.provider).toBe("fatsecret");
    expect(result.recordsSynced).toBe(2);
    expect(result.errors).toHaveLength(0);

    // Verify food_entry rows
    const rows = await ctx.db.select().from(foodEntry).where(eq(foodEntry.providerId, "fatsecret"));

    expect(rows).toHaveLength(2);

    const chicken = rows.find((r) => r.externalId === "entry-100");
    if (!chicken) throw new Error("expected entry-100");
    expect(chicken.foodName).toBe("Chicken Breast");
    expect(chicken.meal).toBe("lunch");
    expect(chicken.calories).toBe(165);
    expect(chicken.proteinG).toBeCloseTo(31);
    expect(chicken.fatG).toBeCloseTo(3.6);

    const rice = rows.find((r) => r.externalId === "entry-101");
    if (!rice) throw new Error("expected entry-101");
    expect(rice.foodName).toBe("Brown Rice");
    expect(rice.carbsG).toBeCloseTo(45);
  });

  it("does not duplicate entries on re-sync", async () => {
    await saveTokens(ctx.db, "fatsecret", {
      accessToken: "oauth1-token",
      refreshToken: "oauth1-token-secret",
      expiresAt: new Date("2099-01-01T00:00:00Z"),
      scopes: null,
    });

    const dateInt = String(Math.floor(new Date("2026-03-01T00:00:00Z").getTime() / 86400000));
    const responses = new Map<string, FatSecretFoodEntriesResponse>();
    responses.set(
      dateInt,
      fakeFoodEntriesResponse(dateInt, [
        { id: "entry-100", name: "Chicken Breast", meal: "Lunch" },
      ]),
    );

    server.use(...fatsecretHandlers(responses));

    const provider = new FatSecretProvider();
    const since = new Date("2026-03-01T00:00:00Z");

    await provider.sync(ctx.db, since);
    await provider.sync(ctx.db, since);

    const rows = await ctx.db.select().from(foodEntry).where(eq(foodEntry.providerId, "fatsecret"));

    const countOf100 = rows.filter((r) => r.externalId === "entry-100").length;
    expect(countOf100).toBe(1);
  });

  it("infers supplement category from food name", async () => {
    await saveTokens(ctx.db, "fatsecret", {
      accessToken: "oauth1-token",
      refreshToken: "oauth1-token-secret",
      expiresAt: new Date("2099-01-01T00:00:00Z"),
      scopes: null,
    });

    const dateInt = String(Math.floor(new Date("2026-03-02T00:00:00Z").getTime() / 86400000));
    const responses = new Map<string, FatSecretFoodEntriesResponse>();
    responses.set(
      dateInt,
      fakeFoodEntriesResponse(dateInt, [
        { id: "entry-200", name: "Fish Oil 1000mg Softgel", meal: "Breakfast", calories: "10" },
      ]),
    );

    server.use(...fatsecretHandlers(responses));

    const provider = new FatSecretProvider();
    const since = new Date("2026-03-02T00:00:00Z");
    await provider.sync(ctx.db, since);

    const rows = await ctx.db.select().from(foodEntry).where(eq(foodEntry.externalId, "entry-200"));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.category).toBe("supplement");
  });

  it("returns error when no tokens exist", async () => {
    await ctx.db.delete(oauthToken).where(eq(oauthToken.providerId, "fatsecret"));

    const provider = new FatSecretProvider();
    const result = await provider.sync(ctx.db, new Date("2026-03-01T00:00:00Z"));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("No OAuth tokens found");
    expect(result.recordsSynced).toBe(0);
  });

  it("handles null food_entries response for days with no data", async () => {
    await saveTokens(ctx.db, "fatsecret", {
      accessToken: "oauth1-token",
      refreshToken: "oauth1-token-secret",
      expiresAt: new Date("2099-01-01T00:00:00Z"),
      scopes: null,
    });

    // FatSecret sometimes returns { food_entries: null } instead of an error
    server.use(
      http.get("https://platform.fatsecret.com/rest/server.api", () => {
        return HttpResponse.json({ food_entries: null });
      }),
    );

    const provider = new FatSecretProvider();
    const since = new Date("2026-03-19T00:00:00Z");
    const result = await provider.sync(ctx.db, since);

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(0);
  });

  it("handles API errors for specific dates without stopping sync", async () => {
    await saveTokens(ctx.db, "fatsecret", {
      accessToken: "oauth1-token",
      refreshToken: "oauth1-token-secret",
      expiresAt: new Date("2099-01-01T00:00:00Z"),
      scopes: null,
    });

    // Override to return 500 for all requests
    server.use(
      http.get("https://platform.fatsecret.com/rest/server.api", () => {
        return new HttpResponse("Internal Server Error", { status: 500 });
      }),
    );

    const provider = new FatSecretProvider();
    const since = new Date("2026-03-10T00:00:00Z");
    const result = await provider.sync(ctx.db, since);

    // Should have errors but not crash
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("caps lookback to 2 years when since is epoch (new Date(0))", async () => {
    await saveTokens(ctx.db, "fatsecret", {
      accessToken: "oauth1-token",
      refreshToken: "oauth1-token-secret",
      expiresAt: new Date("2099-01-01T00:00:00Z"),
      scopes: null,
    });

    const requestedDateInts: string[] = [];

    server.use(
      http.get("https://platform.fatsecret.com/rest/server.api", ({ request }) => {
        const url = new URL(request.url);
        const dateParam = url.searchParams.get("date");
        if (dateParam) requestedDateInts.push(dateParam);
        return HttpResponse.json(
          { error: { code: 7, message: "No entries found" } },
          { status: 400 },
        );
      }),
    );

    const provider = new FatSecretProvider();
    // Pass epoch — would generate ~20,000 API calls without the 2-year cap
    const result = await provider.sync(ctx.db, new Date(0));

    expect(result.errors).toHaveLength(0);

    // All requested date_ints must be within the 2-year window
    const twoYearsAgoMs = Date.now() - 2 * 365 * 24 * 60 * 60 * 1000;
    const twoYearsAgoDayInt = Math.floor(twoYearsAgoMs / 86400000);
    for (const dateInt of requestedDateInts) {
      expect(Number(dateInt)).toBeGreaterThanOrEqual(twoYearsAgoDayInt - 1); // -1 for rounding
    }

    // Must have made fewer than 800 requests (2 years = ~730 days), not 20,000+
    expect(requestedDateInts.length).toBeLessThan(800);
  });

  it("silently skips Zod validation errors about missing food_entries", async () => {
    await saveTokens(ctx.db, "fatsecret", {
      accessToken: "oauth1-token",
      refreshToken: "oauth1-token-secret",
      expiresAt: new Date("2099-01-01T00:00:00Z"),
      scopes: null,
    });

    // Return a shape that fails Zod validation on the food_entries path.
    // This simulates the API returning an unexpected response for an empty day.
    // food_entry is a string instead of an array — Zod throws a ZodError with
    // path[0] === "food_entries", which the catch block silently discards.
    server.use(
      http.get("https://platform.fatsecret.com/rest/server.api", () => {
        return HttpResponse.json({ food_entries: { food_entry: "not-an-array" } });
      }),
    );

    const provider = new FatSecretProvider();
    const since = new Date("2026-03-20T00:00:00Z");
    const result = await provider.sync(ctx.db, since);

    // The Zod error for food_entries path must not appear in errors
    expect(result.errors).toHaveLength(0);
  });
});
