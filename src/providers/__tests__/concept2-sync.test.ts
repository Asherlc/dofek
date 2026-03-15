import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../db/__tests__/test-helpers.ts";
import { activity, oauthToken } from "../../db/schema.ts";
import { ensureProvider, loadTokens, saveTokens } from "../../db/tokens.ts";
import { Concept2Provider } from "../concept2.ts";

// ============================================================
// Fake Concept2 API responses
// ============================================================

interface FakeConcept2Result {
  id: number;
  type: string;
  date: string;
  distance: number;
  time: number;
  time_formatted: string;
  stroke_rate: number;
  stroke_count: number;
  heart_rate?: { average?: number; max?: number; min?: number };
  calories_total?: number;
  drag_factor?: number;
  weight_class: string;
  workout_type: string;
  comments?: string;
  privacy: string;
}

function fakeResult(overrides: Partial<FakeConcept2Result> = {}): FakeConcept2Result {
  return {
    id: 5001,
    type: "rower",
    date: "2026-03-01 10:00:00",
    distance: 5000,
    time: 12000, // tenths of a second = 1200 seconds = 20 min
    time_formatted: "20:00.0",
    stroke_rate: 24,
    stroke_count: 480,
    heart_rate: { average: 160, max: 175, min: 120 },
    calories_total: 300,
    drag_factor: 130,
    weight_class: "H",
    workout_type: "FixedDistanceSplits",
    privacy: "private",
    ...overrides,
  };
}

function createMockFetch(
  results: FakeConcept2Result[],
  opts?: { totalPages?: number; apiError?: boolean },
): typeof globalThis.fetch {
  const totalPages = opts?.totalPages ?? 1;

  return (async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const urlStr = input.toString();

    // Token refresh
    if (urlStr.includes("/oauth/access_token")) {
      return Response.json({
        access_token: "refreshed-token",
        refresh_token: "new-refresh",
        expires_in: 7200,
        scope: "user:read results:read",
      });
    }

    // Results API
    if (urlStr.includes("/api/users/me/results")) {
      if (opts?.apiError) {
        return new Response("Internal Server Error", { status: 500 });
      }

      // Parse page from URL
      const url = new URL(urlStr);
      const page = Number.parseInt(url.searchParams.get("page") ?? "1", 10);

      // For pagination tests: return results only on the requested page
      const pageResults = totalPages > 1 ? (page === 1 ? results : []) : results;

      return Response.json({
        data: pageResults,
        meta: {
          pagination: {
            total: results.length,
            count: pageResults.length,
            per_page: 50,
            current_page: page,
            total_pages: totalPages,
          },
        },
      });
    }

    return new Response("Not found", { status: 404 });
  }) as typeof globalThis.fetch;
}

describe("Concept2Provider.sync() (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    process.env.CONCEPT2_CLIENT_ID = "test-client-id";
    process.env.CONCEPT2_CLIENT_SECRET = "test-client-secret";
    ctx = await setupTestDatabase();
    await ensureProvider(ctx.db, "concept2", "Concept2", "https://log.concept2.com");
  }, 60_000);

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  it("syncs activities into activity table", async () => {
    await saveTokens(ctx.db, "concept2", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user:read results:read",
    });

    const results = [
      fakeResult({ id: 5001, type: "rower", date: "2026-03-01 10:00:00" }),
      fakeResult({ id: 5002, type: "skierg", date: "2026-03-02 09:00:00" }),
    ];

    const provider = new Concept2Provider(createMockFetch(results));
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.provider).toBe("concept2");
    expect(result.recordsSynced).toBe(2);
    expect(result.errors).toHaveLength(0);

    const rows = await ctx.db.select().from(activity).where(eq(activity.providerId, "concept2"));

    expect(rows).toHaveLength(2);

    const rower = rows.find((r) => r.externalId === "5001");
    if (!rower) throw new Error("expected result 5001");
    expect(rower.activityType).toBe("rowing");

    const skierg = rows.find((r) => r.externalId === "5002");
    if (!skierg) throw new Error("expected result 5002");
    expect(skierg.activityType).toBe("skiing");
  });

  it("upserts on re-sync (no duplicates)", async () => {
    await saveTokens(ctx.db, "concept2", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user:read results:read",
    });

    const results = [fakeResult({ id: 5001, date: "2026-03-01 10:00:00" })];

    const provider = new Concept2Provider(createMockFetch(results));
    await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    // Sync again — should upsert, not duplicate
    await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    const rows = await ctx.db.select().from(activity).where(eq(activity.providerId, "concept2"));

    const countOf5001 = rows.filter((r) => r.externalId === "5001").length;
    expect(countOf5001).toBe(1);
  });

  it("handles paginated results", async () => {
    await saveTokens(ctx.db, "concept2", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user:read results:read",
    });

    const results = [fakeResult({ id: 6001, date: "2026-04-01 10:00:00" })];

    // Mock returns 2 total pages but results only on page 1
    const provider = new Concept2Provider(createMockFetch(results, { totalPages: 2 }));
    const result = await provider.sync(ctx.db, new Date("2026-03-01T00:00:00Z"));

    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it("refreshes expired tokens and saves new ones", async () => {
    await saveTokens(ctx.db, "concept2", {
      accessToken: "expired-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2025-01-01T00:00:00Z"), // expired
      scopes: "user:read results:read",
    });

    const provider = new Concept2Provider(createMockFetch([]));
    await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    // Verify token was refreshed in DB
    const tokens = await loadTokens(ctx.db, "concept2");
    expect(tokens?.accessToken).toBe("refreshed-token");
  });

  it("returns error when no tokens exist", async () => {
    // Delete existing tokens
    await ctx.db.delete(oauthToken).where(eq(oauthToken.providerId, "concept2"));

    const provider = new Concept2Provider(createMockFetch([]));
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("No OAuth tokens");
    expect(result.recordsSynced).toBe(0);
  });

  it("handles API errors gracefully", async () => {
    await saveTokens(ctx.db, "concept2", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user:read results:read",
    });

    const provider = new Concept2Provider(createMockFetch([], { apiError: true }));
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.message).toContain("Concept2 API error");
  });
});
