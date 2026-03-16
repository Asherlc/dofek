import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activity, oauthToken } from "../db/schema.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { ensureProvider, loadTokens, saveTokens } from "../db/tokens.ts";
import { DecathlonProvider } from "./decathlon.ts";

// ============================================================
// Fake Decathlon API responses
// ============================================================

interface FakeDecathlonActivity {
  id: string;
  name: string;
  sport: string;
  startdate: string;
  duration: number;
  dataSummaries: Array<{ id: number; value: number }>;
}

function fakeActivity(overrides: Partial<FakeDecathlonActivity> = {}): FakeDecathlonActivity {
  return {
    id: "dec-act-1001",
    name: "Morning Run",
    sport: "/v2/sports/381", // running
    startdate: "2026-03-01T10:00:00Z",
    duration: 3600,
    dataSummaries: [
      { id: 5, value: 10.5 }, // distance km
      { id: 9, value: 650 }, // calories
      { id: 1, value: 155 }, // avg HR
      { id: 2, value: 178 }, // max HR
    ],
    ...overrides,
  };
}

function decathlonHandlers(pages: FakeDecathlonActivity[][], opts?: { apiError?: boolean }) {
  let pageIndex = 0;

  return [
    // Token refresh
    http.post("https://api.decathlon.net/connect/oauth/token", () => {
      return HttpResponse.json({
        access_token: "refreshed-token",
        refresh_token: "new-refresh",
        expires_in: 7200,
        scope: "openid profile",
      });
    }),

    // Activities API (cursor-based pagination via links.next)
    http.get("https://api.decathlon.net/sportstrackingdata/v2/activities", () => {
      if (opts?.apiError) {
        return new HttpResponse("Internal Server Error", { status: 500 });
      }

      const currentPage = pages[pageIndex] ?? [];
      const hasNextPage = pageIndex < pages.length - 1;
      pageIndex++;

      return HttpResponse.json({
        data: currentPage,
        links: hasNextPage
          ? {
              next: `https://api.decathlon.net/sportstrackingdata/v2/activities?cursor=next-page-${pageIndex}`,
            }
          : {},
      });
    }),
  ];
}

const server = setupServer();

describe("DecathlonProvider.sync() (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    process.env.DECATHLON_CLIENT_ID = "test-client-id";
    process.env.DECATHLON_CLIENT_SECRET = "test-client-secret";
    ctx = await setupTestDatabase();
    server.listen({ onUnhandledRequest: "error" });
    await ensureProvider(
      ctx.db,
      "decathlon",
      "Decathlon",
      "https://api.decathlon.net/sportstrackingdata/v2",
    );
  }, 60_000);

  afterEach(() => {
    server.resetHandlers();
  });

  afterAll(async () => {
    server.close();
    if (ctx) await ctx.cleanup();
  });

  it("syncs activities into activity table", async () => {
    await saveTokens(ctx.db, "decathlon", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "openid profile",
    });

    const activities = [
      fakeActivity({ id: "dec-act-1001", sport: "/v2/sports/381", name: "Morning Run" }),
      fakeActivity({ id: "dec-act-1002", sport: "/v2/sports/121", name: "Afternoon Ride" }),
    ];

    server.use(...decathlonHandlers([activities]));

    const provider = new DecathlonProvider();
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.provider).toBe("decathlon");
    expect(result.recordsSynced).toBe(2);
    expect(result.errors).toHaveLength(0);

    const rows = await ctx.db.select().from(activity).where(eq(activity.providerId, "decathlon"));

    expect(rows).toHaveLength(2);

    const run = rows.find((r) => r.externalId === "dec-act-1001");
    if (!run) throw new Error("expected activity dec-act-1001");
    expect(run.activityType).toBe("running");
    expect(run.name).toBe("Morning Run");

    const ride = rows.find((r) => r.externalId === "dec-act-1002");
    if (!ride) throw new Error("expected activity dec-act-1002");
    expect(ride.activityType).toBe("cycling");
  });

  it("handles cursor-based pagination", async () => {
    await saveTokens(ctx.db, "decathlon", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "openid profile",
    });

    const page1 = [fakeActivity({ id: "dec-page-1", name: "Page 1 Run" })];
    const page2 = [
      fakeActivity({ id: "dec-page-2", name: "Page 2 Ride", sport: "/v2/sports/121" }),
    ];

    server.use(...decathlonHandlers([page1, page2]));

    const provider = new DecathlonProvider();
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.recordsSynced).toBe(2);
    expect(result.errors).toHaveLength(0);

    const rows = await ctx.db.select().from(activity).where(eq(activity.providerId, "decathlon"));

    const hasPage1 = rows.some((r) => r.externalId === "dec-page-1");
    const hasPage2 = rows.some((r) => r.externalId === "dec-page-2");
    expect(hasPage1).toBe(true);
    expect(hasPage2).toBe(true);
  });

  it("upserts on re-sync (no duplicates)", async () => {
    await saveTokens(ctx.db, "decathlon", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "openid profile",
    });

    const activities = [fakeActivity({ id: "dec-act-1001" })];

    server.use(...decathlonHandlers([activities]));

    const provider = new DecathlonProvider();
    await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    // Sync again
    server.resetHandlers();
    server.use(...decathlonHandlers([activities]));

    const provider2 = new DecathlonProvider();
    await provider2.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    const rows = await ctx.db.select().from(activity).where(eq(activity.providerId, "decathlon"));

    const countOf1001 = rows.filter((r) => r.externalId === "dec-act-1001").length;
    expect(countOf1001).toBe(1);
  });

  it("refreshes expired tokens and saves new ones", async () => {
    await saveTokens(ctx.db, "decathlon", {
      accessToken: "expired-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2025-01-01T00:00:00Z"), // expired
      scopes: "openid profile",
    });

    server.use(...decathlonHandlers([[]]));

    const provider = new DecathlonProvider();
    await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    const tokens = await loadTokens(ctx.db, "decathlon");
    expect(tokens?.accessToken).toBe("refreshed-token");
  });

  it("returns error when no tokens exist", async () => {
    await ctx.db.delete(oauthToken).where(eq(oauthToken.providerId, "decathlon"));

    const provider = new DecathlonProvider();
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("No OAuth tokens");
    expect(result.recordsSynced).toBe(0);
  });

  it("handles API errors gracefully", async () => {
    await saveTokens(ctx.db, "decathlon", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "openid profile",
    });

    server.use(...decathlonHandlers([], { apiError: true }));

    const provider = new DecathlonProvider();
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.message).toContain("Decathlon API error");
  });
});
