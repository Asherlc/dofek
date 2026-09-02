import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activity } from "../db/schema/activity.ts";
import { oauthToken } from "../db/schema/reference.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { ensureProvider, loadTokens, saveTokens } from "../db/tokens.ts";
import { failOnUnhandledExternalRequest } from "../test/msw.ts";
import { KomootProvider } from "./komoot.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";

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
  elevation_up?: number | null;
  elevation_down?: number | null;
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

function komootHandlers(
  pages: FakeKomootTour[][],
  opts?: { apiError?: boolean; apiErrorPage?: number; onTourRequest?: (page: number) => void },
) {
  return [
    // Token refresh
    http.post("https://auth.komoot.de/oauth/token", () => {
      return HttpResponse.json({
        access_token: "refreshed-token",
        refresh_token: "new-refresh",
        expires_in: 7200,
        scope: "profile",
      });
    }),

    // Tours API (page-based pagination, 0-indexed)
    http.get("https://external-api.komoot.de/v007/users/me/tours/", ({ request }) => {
      if (opts?.apiError) {
        return new HttpResponse("Internal Server Error", { status: 500 });
      }

      const url = new URL(request.url);
      const page = Number.parseInt(url.searchParams.get("page") ?? "0", 10);
      if (opts?.apiErrorPage === page) {
        return new HttpResponse("Internal Server Error", { status: 500 });
      }
      opts?.onTourRequest?.(page);
      const totalPages = pages.length;
      const currentPageTours = pages[page] ?? [];

      // Sum all tours across all pages for totalElements
      const totalElements = pages.reduce((sum, p) => sum + p.length, 0);

      return HttpResponse.json({
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
    }),
  ];
}

const server = setupServer();

describe("KomootProvider.sync() (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    process.env.KOMOOT_CLIENT_ID = "test-client-id";
    process.env.KOMOOT_CLIENT_SECRET = "test-client-secret";
    ctx = await setupTestDatabase();
    server.listen({ onUnhandledRequest: failOnUnhandledExternalRequest });
    await ensureProvider(ctx.db, "komoot", "Komoot", "https://external-api.komoot.de/v007");
  }, 60_000);

  afterEach(() => {
    server.resetHandlers();
  });

  afterAll(async () => {
    server.close();
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

    server.use(...komootHandlers([tours]));

    const provider = new KomootProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
      }),
    );

    expect(result.provider).toBe("komoot");
    expect(result.recordsSynced).toBe(2);
    expect(result.errors).toHaveLength(0);

    const rows = await ctx.db.select().from(activity).where(eq(activity.providerId, "komoot"));

    expect(rows).toHaveLength(2);

    const hike = rows.find((r) => r.externalId === "7001");
    if (!hike) throw new Error("expected tour 7001");
    expect(hike.canonicalType).toBe("hiking");
    expect(hike.name).toBe("Mountain Hike");

    const run = rows.find((r) => r.externalId === "7002");
    if (!run) throw new Error("expected tour 7002");
    expect(run.canonicalType).toBe("running");
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

    server.use(...komootHandlers([page0, page1]));

    const provider = new KomootProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
      }),
    );

    expect(result.recordsSynced).toBe(2);
    expect(result.errors).toHaveLength(0);

    const rows = await ctx.db.select().from(activity).where(eq(activity.providerId, "komoot"));

    const hasPage0 = rows.some((r) => r.externalId === "8001");
    const hasPage1 = rows.some((r) => r.externalId === "8002");
    expect(hasPage0).toBe(true);
    expect(hasPage1).toBe(true);

    // Verify sport mapping
    const biking = rows.find((r) => r.externalId === "8001");
    expect(biking?.canonicalType).toBe("cycling");

    const trail = rows.find((r) => r.externalId === "8002");
    expect(trail?.canonicalType).toBe("running");
  });

  it("syncs tours when optional elevation fields are null", async () => {
    await saveTokens(ctx.db, "komoot", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "profile",
    });

    server.use(
      ...komootHandlers([
        [
          fakeTour({
            id: 8041,
            name: "Flat Tour",
            elevation_up: null,
            elevation_down: null,
          }),
        ],
      ]),
    );

    const provider = new KomootProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
      }),
    );

    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toHaveLength(0);

    const rows = await ctx.db.select().from(activity).where(eq(activity.providerId, "komoot"));
    const tour = rows.find((row) => row.externalId === "8041");
    expect(tour?.raw).toEqual(
      expect.objectContaining({
        elevationUp: null,
        elevationDown: null,
      }),
    );
  });

  it("persists already fetched tours before a later page request fails", async () => {
    await saveTokens(ctx.db, "komoot", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "profile",
    });

    server.use(
      ...komootHandlers([[fakeTour({ id: 8051, name: "Persisted Before Failure" })], []], {
        apiErrorPage: 1,
      }),
    );

    const provider = new KomootProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
      }),
    );

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.message).toContain("Komoot API error");
    expect(result.recordsSynced).toBe(1);

    const rows = await ctx.db.select().from(activity).where(eq(activity.providerId, "komoot"));
    expect(rows.some((row) => row.externalId === "8051")).toBe(true);
  });

  it("skips tours after the bounded sync window end", async () => {
    await saveTokens(ctx.db, "komoot", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "profile",
    });

    server.use(
      ...komootHandlers([
        [
          fakeTour({ id: 8061, name: "Inside Window", date: "2026-03-01T10:00:00Z" }),
          fakeTour({ id: 8062, name: "After Window", date: "2026-03-02T00:00:00Z" }),
        ],
      ]),
    );

    const provider = new KomootProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromDateRange({ sinceDate: "2026-03-01", untilDate: "2026-03-01" }),
      }),
    );

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(1);

    const rows = await ctx.db.select().from(activity).where(eq(activity.providerId, "komoot"));
    expect(rows.some((row) => row.externalId === "8061")).toBe(true);
    expect(rows.some((row) => row.externalId === "8062")).toBe(false);
  });

  it("reports degraded pagination and skips reconciliation when an empty page still has a next page", async () => {
    await saveTokens(ctx.db, "komoot", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "profile",
    });
    const userId = "00000000-0000-0000-0000-000000000001";
    await ctx.db.insert(activity).values({
      providerId: "komoot",
      userId,
      externalId: "komoot-degraded-missing",
      canonicalType: "hiking",
      providerType: "HIKING",
      modality: null,
      startedAt: new Date("2026-03-01T10:00:00Z"),
      endedAt: new Date("2026-03-01T11:00:00Z"),
    });

    server.use(
      ...komootHandlers([
        [fakeTour({ id: 8101, name: "First Page Tour" })],
        [],
        [fakeTour({ id: 8103, name: "Unreached Tour" })],
      ]),
    );

    const provider = new KomootProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        userId,
      }),
    );

    expect(result.recordsSynced).toBe(1);
    expect(result.degradations?.[0]?.kind).toBe("pagination_empty_page_with_cursor");

    const [missing] = await ctx.db
      .select({ providerAbsentAt: activity.providerAbsentAt })
      .from(activity)
      .where(eq(activity.externalId, "komoot-degraded-missing"));
    expect(missing?.providerAbsentAt).toBeNull();
  });

  it("reports max-page degradation at the exact page guard", async () => {
    await saveTokens(ctx.db, "komoot", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "profile",
    });

    const requestedPages: number[] = [];
    const pages = Array.from({ length: 101 }, (_, index) => [
      fakeTour({ id: 8200 + index, name: `Guard Tour ${index}` }),
    ]);
    server.use(...komootHandlers(pages, { onTourRequest: (page) => requestedPages.push(page) }));

    const provider = new KomootProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
      }),
    );

    expect(result.recordsSynced).toBe(100);
    expect(result.degradations?.[0]?.kind).toBe("pagination_max_pages_exceeded");
    expect(requestedPages).toHaveLength(100);
    expect(requestedPages[0]).toBe(0);
    expect(requestedPages.at(-1)).toBe(99);
  });

  it("upserts on re-sync (no duplicates)", async () => {
    await saveTokens(ctx.db, "komoot", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "profile",
    });

    const tours = [fakeTour({ id: 7001 })];

    server.use(...komootHandlers([tours]));

    const provider = new KomootProvider();
    await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
      }),
    );

    // Sync again
    await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
      }),
    );

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

    server.use(...komootHandlers([[]]));

    const provider = new KomootProvider();
    await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
      }),
    );

    const tokens = await loadTokens(ctx.db, "komoot");
    expect(tokens?.accessToken).toBe("refreshed-token");
  });

  it("returns error when no tokens exist", async () => {
    await ctx.db.delete(oauthToken).where(eq(oauthToken.providerId, "komoot"));

    const provider = new KomootProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
      }),
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("No OAuth tokens");
    expect(result.recordsSynced).toBe(0);
    // duration is the elapsed time (Date.now() - start), not Date.now() + start
    expect(result.duration).toBeGreaterThanOrEqual(0);
    expect(result.duration).toBeLessThan(60_000);
  });

  it("requests each page exactly once and sends auth headers", async () => {
    await saveTokens(ctx.db, "komoot", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "profile",
    });

    const pages = [
      [fakeTour({ id: 9001, name: "Page 0" })],
      [fakeTour({ id: 9002, name: "Page 1" })],
    ];
    const requestedPages: number[] = [];
    const authHeaders: (string | null)[] = [];

    server.use(
      http.get("https://external-api.komoot.de/v007/users/me/tours/", ({ request }) => {
        const url = new URL(request.url);
        const page = Number.parseInt(url.searchParams.get("page") ?? "0", 10);
        requestedPages.push(page);
        authHeaders.push(request.headers.get("Authorization"));
        return HttpResponse.json({
          _embedded: { tours: pages[page] ?? [] },
          page: { size: 50, totalElements: 2, totalPages: pages.length, number: page },
        });
      }),
    );

    const provider = new KomootProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
      }),
    );

    expect(result.errors).toHaveLength(0);
    // pages 0 and 1 only — never the out-of-range page at index === totalPages
    // (kills the `page < totalPages` → `page <= totalPages` boundary mutant)
    expect(requestedPages).toEqual([0, 1]);
    // every request carries the bearer token (kills the headers ObjectLiteral mutants)
    expect(authHeaders).toEqual(["Bearer valid-token", "Bearer valid-token"]);
    // duration is elapsed time, not Date.now() + start
    expect(result.duration).toBeGreaterThanOrEqual(0);
    expect(result.duration).toBeLessThan(60_000);
  });

  it("treats a response with no _embedded section as zero tours", async () => {
    await saveTokens(ctx.db, "komoot", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "profile",
    });

    server.use(
      http.get("https://external-api.komoot.de/v007/users/me/tours/", () => {
        return HttpResponse.json({
          page: { size: 50, totalElements: 0, totalPages: 1, number: 0 },
        });
      }),
    );

    const provider = new KomootProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
      }),
    );

    // `data._embedded?.tours ?? []` must not throw when _embedded is absent
    // (kills the optional-chaining mutant that would dereference undefined)
    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(0);
  });

  it("handles API errors gracefully", async () => {
    await saveTokens(ctx.db, "komoot", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "profile",
    });

    server.use(...komootHandlers([], { apiError: true }));

    const provider = new KomootProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
      }),
    );

    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.message).toContain("Komoot API error");
  });
});
