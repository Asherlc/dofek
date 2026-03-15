import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../db/__tests__/test-helpers.ts";
import { activity, oauthToken } from "../../db/schema.ts";
import { ensureProvider, loadTokens, saveTokens } from "../../db/tokens.ts";
import { KomootProvider } from "../komoot.ts";

// ============================================================
// Fake Komoot API responses
// ============================================================

interface FakeKomootTour {
  id: number;
  name: string;
  sport: string;
  date: string;
  distance: number;
  duration: number;
  elevation_up?: number;
  elevation_down?: number;
  status: string;
  type: string;
}

function fakeTour(overrides: Partial<FakeKomootTour> = {}): FakeKomootTour {
  return {
    id: 7001,
    name: "Morning Hike",
    sport: "HIKING",
    date: "2026-03-01T10:00:00Z",
    distance: 12000,
    duration: 7200,
    elevation_up: 450,
    elevation_down: 420,
    status: "private",
    type: "tour_recorded",
    ...overrides,
  };
}

function createMockFetch(
  pages: FakeKomootTour[][],
  opts?: { apiError?: boolean },
): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const urlStr = input.toString();

    // Token refresh
    if (urlStr.includes("/oauth/token")) {
      return Response.json({
        access_token: "refreshed-token",
        refresh_token: "new-refresh",
        expires_in: 7200,
        scope: "profile",
      });
    }

    // Tours API (page-based pagination, 0-indexed)
    if (urlStr.includes("/users/me/tours")) {
      if (opts?.apiError) {
        return new Response("Internal Server Error", { status: 500 });
      }

      const url = new URL(urlStr);
      const page = Number.parseInt(url.searchParams.get("page") ?? "0", 10);
      const totalPages = pages.length;
      const currentPageTours = pages[page] ?? [];

      // Sum all tours across all pages for totalElements
      const totalElements = pages.reduce((sum, p) => sum + p.length, 0);

      return Response.json({
        _embedded: {
          tours: currentPageTours,
        },
        page: {
          size: 50,
          totalElements,
          totalPages,
          number: page,
        },
      });
    }

    return new Response("Not found", { status: 404 });
  }) as typeof globalThis.fetch;
}

describe("KomootProvider.sync() (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    process.env.KOMOOT_CLIENT_ID = "test-client-id";
    process.env.KOMOOT_CLIENT_SECRET = "test-client-secret";
    ctx = await setupTestDatabase();
    await ensureProvider(ctx.db, "komoot", "Komoot", "https://external-api.komoot.de/v007");
  }, 60_000);

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  it("syncs tours into activity table", async () => {
    await saveTokens(ctx.db, "komoot", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "profile",
    });

    const tours = [
      fakeTour({ id: 7001, sport: "HIKING", name: "Mountain Hike" }),
      fakeTour({ id: 7002, sport: "RUNNING", name: "Park Run" }),
    ];

    const provider = new KomootProvider(createMockFetch([tours]));
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.provider).toBe("komoot");
    expect(result.recordsSynced).toBe(2);
    expect(result.errors).toHaveLength(0);

    const rows = await ctx.db.select().from(activity).where(eq(activity.providerId, "komoot"));

    expect(rows).toHaveLength(2);

    const hike = rows.find((r) => r.externalId === "7001");
    if (!hike) throw new Error("expected tour 7001");
    expect(hike.activityType).toBe("hiking");
    expect(hike.name).toBe("Mountain Hike");

    const run = rows.find((r) => r.externalId === "7002");
    if (!run) throw new Error("expected tour 7002");
    expect(run.activityType).toBe("running");
  });

  it("handles page-based pagination", async () => {
    await saveTokens(ctx.db, "komoot", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "profile",
    });

    const page0 = [fakeTour({ id: 8001, name: "Page 0 Tour", sport: "BIKING" })];
    const page1 = [fakeTour({ id: 8002, name: "Page 1 Tour", sport: "TRAIL_RUNNING" })];

    const provider = new KomootProvider(createMockFetch([page0, page1]));
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.recordsSynced).toBe(2);
    expect(result.errors).toHaveLength(0);

    const rows = await ctx.db.select().from(activity).where(eq(activity.providerId, "komoot"));

    const hasPage0 = rows.some((r) => r.externalId === "8001");
    const hasPage1 = rows.some((r) => r.externalId === "8002");
    expect(hasPage0).toBe(true);
    expect(hasPage1).toBe(true);

    // Verify sport mapping
    const biking = rows.find((r) => r.externalId === "8001");
    expect(biking?.activityType).toBe("cycling");

    const trail = rows.find((r) => r.externalId === "8002");
    expect(trail?.activityType).toBe("trail_running");
  });

  it("upserts on re-sync (no duplicates)", async () => {
    await saveTokens(ctx.db, "komoot", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "profile",
    });

    const tours = [fakeTour({ id: 7001 })];

    const provider = new KomootProvider(createMockFetch([tours]));
    await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    // Sync again
    const provider2 = new KomootProvider(createMockFetch([tours]));
    await provider2.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    const rows = await ctx.db.select().from(activity).where(eq(activity.providerId, "komoot"));

    const countOf7001 = rows.filter((r) => r.externalId === "7001").length;
    expect(countOf7001).toBe(1);
  });

  it("refreshes expired tokens and saves new ones", async () => {
    await saveTokens(ctx.db, "komoot", {
      accessToken: "expired-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2025-01-01T00:00:00Z"), // expired
      scopes: "profile",
    });

    const provider = new KomootProvider(createMockFetch([[]]));
    await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    const tokens = await loadTokens(ctx.db, "komoot");
    expect(tokens?.accessToken).toBe("refreshed-token");
  });

  it("returns error when no tokens exist", async () => {
    await ctx.db.delete(oauthToken).where(eq(oauthToken.providerId, "komoot"));

    const provider = new KomootProvider(createMockFetch([[]]));
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("No OAuth tokens");
    expect(result.recordsSynced).toBe(0);
  });

  it("handles API errors gracefully", async () => {
    await saveTokens(ctx.db, "komoot", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "profile",
    });

    const provider = new KomootProvider(createMockFetch([], { apiError: true }));
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.message).toContain("Komoot API error");
  });
});
