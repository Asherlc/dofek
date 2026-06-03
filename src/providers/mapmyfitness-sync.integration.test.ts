import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activity, oauthToken } from "../db/schema.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { ensureProvider, saveTokens } from "../db/tokens.ts";
import { failOnUnhandledExternalRequest } from "../test/msw.ts";
import { MapMyFitnessProvider } from "./mapmyfitness.ts";

// ============================================================
// Fake MapMyFitness API responses
// ============================================================

interface FakeWorkoutOverrides {
  id?: string;
  name?: string;
  start_datetime?: string;
  activity_type?: string;
  distance_total?: number;
  active_time_total?: number;
  speed_avg?: number;
  speed_max?: number;
  metabolic_energy_total?: number;
  heart_rate_avg?: number;
  heart_rate_max?: number;
  cadence_avg?: number;
  power_avg?: number;
  power_max?: number;
}

function fakeWorkout(overrides: FakeWorkoutOverrides = {}) {
  const id = overrides.id ?? "mmf-1001";
  return {
    _links: { self: [{ id }] },
    name: overrides.name ?? "Morning Run",
    start_datetime: overrides.start_datetime ?? "2026-03-01T07:00:00+00:00",
    start_locale_timezone: "America/New_York",
    activity_type: overrides.activity_type ?? "Run",
    aggregates: {
      distance_total: overrides.distance_total ?? 8000,
      active_time_total: overrides.active_time_total ?? 2400,
      speed_avg: overrides.speed_avg ?? 3.33,
      speed_max: overrides.speed_max ?? 4.2,
      metabolic_energy_total: overrides.metabolic_energy_total ?? 2092000, // ~500 kcal
      heart_rate_avg: overrides.heart_rate_avg ?? 155,
      heart_rate_max: overrides.heart_rate_max ?? 178,
      cadence_avg: overrides.cadence_avg ?? 170,
      power_avg: overrides.power_avg,
      power_max: overrides.power_max,
    },
  };
}

interface MockFetchOptions {
  pages?: Array<{
    workouts: Array<ReturnType<typeof fakeWorkout>>;
    hasNext: boolean;
  }>;
}

function mapmyfitHandlers(opts: MockFetchOptions) {
  const pages = opts.pages ?? [];
  let pageIndex = 0;

  return [
    // Token refresh
    http.post("https://api.mapmyfitness.com/v7.1/oauth2/access_token/", () => {
      return HttpResponse.json({
        access_token: "refreshed-token",
        refresh_token: "new-refresh",
        expires_in: 7200,
      });
    }),

    // Workouts list (paginated via offset)
    http.get("https://api.mapmyfitness.com/v7.1/workout/", () => {
      const page = pages[pageIndex];
      pageIndex++;
      if (!page) {
        return HttpResponse.json({
          _embedded: { workouts: [] },
          _links: {},
          total_count: 0,
        });
      }
      return HttpResponse.json({
        _embedded: { workouts: page.workouts },
        _links: {
          next: page.hasNext ? [{ href: "/v7.1/workout/?offset=40" }] : undefined,
        },
        total_count: page.workouts.length,
      });
    }),
  ];
}

const server = setupServer();

describe("MapMyFitnessProvider.sync() (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    process.env.MAPMYFITNESS_CLIENT_ID = "test-client-id";
    process.env.MAPMYFITNESS_CLIENT_SECRET = "test-client-secret";
    ctx = await setupTestDatabase();
    server.listen({ onUnhandledRequest: failOnUnhandledExternalRequest });
    await ensureProvider(ctx.db, "mapmyfitness", "MapMyFitness", "https://api.mapmyfitness.com");
  }, 60_000);

  afterEach(() => {
    server.resetHandlers();
  });

  afterAll(async () => {
    server.close();
    if (ctx) await ctx.cleanup();
  });

  it("syncs workouts into activity table", async () => {
    await saveTokens(ctx.db, "mapmyfitness", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user_id:12345",
    });

    const workouts = [
      fakeWorkout({ id: "mmf-1001", name: "Morning Run", activity_type: "Run" }),
      fakeWorkout({
        id: "mmf-1002",
        name: "Bike to Work",
        activity_type: "Bike Ride",
        start_datetime: "2026-03-05T08:30:00+00:00",
      }),
    ];

    server.use(...mapmyfitHandlers({ pages: [{ workouts, hasNext: false }] }));

    const provider = new MapMyFitnessProvider();
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.provider).toBe("mapmyfitness");
    expect(result.recordsSynced).toBe(2);
    expect(result.errors).toHaveLength(0);

    const rows = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.providerId, "mapmyfitness"));

    expect(rows).toHaveLength(2);

    const run = rows.find((r) => r.externalId === "mmf-1001");
    if (!run) throw new Error("expected workout mmf-1001");
    expect(run.activityType).toBe("running");
    expect(run.name).toBe("Morning Run");

    const bike = rows.find((r) => r.externalId === "mmf-1002");
    if (!bike) throw new Error("expected workout mmf-1002");
    expect(bike.activityType).toBe("cycling");
  });

  it("upserts on re-sync (no duplicates)", async () => {
    await saveTokens(ctx.db, "mapmyfitness", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user_id:12345",
    });

    const workouts = [fakeWorkout({ id: "mmf-1001" })];

    server.use(...mapmyfitHandlers({ pages: [{ workouts, hasNext: false }] }));

    const provider = new MapMyFitnessProvider();
    await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    // Sync again
    server.resetHandlers();
    server.use(...mapmyfitHandlers({ pages: [{ workouts, hasNext: false }] }));

    const provider2 = new MapMyFitnessProvider();
    await provider2.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    const rows = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.providerId, "mapmyfitness"));

    const countOf1001 = rows.filter((r) => r.externalId === "mmf-1001").length;
    expect(countOf1001).toBe(1);
  });

  it("handles pagination with next links", async () => {
    await saveTokens(ctx.db, "mapmyfitness", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user_id:12345",
    });

    const page1Workouts = [
      fakeWorkout({ id: "mmf-p1", start_datetime: "2026-04-01T08:00:00+00:00" }),
      fakeWorkout({ id: "mmf-p2", start_datetime: "2026-04-02T08:00:00+00:00" }),
    ];
    const page2Workouts = [
      fakeWorkout({ id: "mmf-p3", start_datetime: "2026-04-03T08:00:00+00:00" }),
    ];

    server.use(
      ...mapmyfitHandlers({
        pages: [
          { workouts: page1Workouts, hasNext: true },
          { workouts: page2Workouts, hasNext: false },
        ],
      }),
    );

    const provider = new MapMyFitnessProvider();
    const result = await provider.sync(ctx.db, new Date("2026-03-15T00:00:00Z"));

    expect(result.recordsSynced).toBe(3);
    expect(result.errors).toHaveLength(0);
  });

  it("maps activity types correctly", async () => {
    await saveTokens(ctx.db, "mapmyfitness", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user_id:12345",
    });

    const workouts = [
      fakeWorkout({
        id: "mmf-walk",
        activity_type: "Walk",
        start_datetime: "2026-05-01T08:00:00+00:00",
      }),
      fakeWorkout({
        id: "mmf-swim",
        activity_type: "Swim",
        start_datetime: "2026-05-02T08:00:00+00:00",
      }),
      fakeWorkout({
        id: "mmf-hike",
        activity_type: "Hike",
        start_datetime: "2026-05-03T08:00:00+00:00",
      }),
      fakeWorkout({
        id: "mmf-yoga",
        activity_type: "Yoga",
        start_datetime: "2026-05-04T08:00:00+00:00",
      }),
    ];

    server.use(...mapmyfitHandlers({ pages: [{ workouts, hasNext: false }] }));

    const provider = new MapMyFitnessProvider();
    const result = await provider.sync(ctx.db, new Date("2026-04-01T00:00:00Z"));
    expect(result.recordsSynced).toBe(4);

    const rows = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.providerId, "mapmyfitness"));

    const walk = rows.find((r) => r.externalId === "mmf-walk");
    expect(walk?.activityType).toBe("walking");

    const swim = rows.find((r) => r.externalId === "mmf-swim");
    expect(swim?.activityType).toBe("swimming");

    const hike = rows.find((r) => r.externalId === "mmf-hike");
    expect(hike?.activityType).toBe("hiking");

    const yoga = rows.find((r) => r.externalId === "mmf-yoga");
    expect(yoga?.activityType).toBe("yoga");
  });

  it("refreshes expired tokens and saves new ones", async () => {
    await saveTokens(ctx.db, "mapmyfitness", {
      accessToken: "expired-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2025-01-01T00:00:00Z"), // expired
      scopes: "user_id:12345",
    });

    server.use(...mapmyfitHandlers({ pages: [{ workouts: [], hasNext: false }] }));

    const provider = new MapMyFitnessProvider();
    await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    const { loadTokens } = await import("../db/tokens.ts");
    const tokens = await loadTokens(ctx.db, "mapmyfitness");
    expect(tokens?.accessToken).toBe("refreshed-token");
  });

  it("returns error when no tokens exist", async () => {
    await ctx.db.delete(oauthToken).where(eq(oauthToken.providerId, "mapmyfitness"));

    const provider = new MapMyFitnessProvider();
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("No OAuth tokens");
    expect(result.recordsSynced).toBe(0);
    // Early-return duration must be a small elapsed time (Date.now() - start),
    // not Date.now() + start which would be ~2 epochs.
    expect(result.duration).toBeGreaterThanOrEqual(0);
    expect(result.duration).toBeLessThan(60_000);
  });

  it("builds the workout request from since, user id, and offset", async () => {
    await saveTokens(ctx.db, "mapmyfitness", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user_id:99887",
    });

    const requestedUrls: string[] = [];
    const apiKeyHeaders: Array<string | null> = [];

    server.use(
      http.get("https://api.mapmyfitness.com/v7.1/workout/", ({ request }) => {
        requestedUrls.push(request.url);
        apiKeyHeaders.push(request.headers.get("Api-Key"));
        // Page 1 has workouts and a next link; page 2 is empty (terminates loop).
        if (requestedUrls.length === 1) {
          return HttpResponse.json({
            _embedded: {
              workouts: [
                fakeWorkout({ id: "mmf-req", start_datetime: "2026-06-02T08:00:00+00:00" }),
              ],
            },
            _links: { next: [{ href: "/v7.1/workout/?offset=40" }] },
            total_count: 1,
          });
        }
        return HttpResponse.json({
          _embedded: { workouts: [] },
          _links: {},
          total_count: 0,
        });
      }),
    );

    const provider = new MapMyFitnessProvider();
    const since = new Date("2026-05-01T00:00:00Z");
    await provider.sync(ctx.db, since);

    // formatDate(since) must produce the ISO string used as started_after.
    const firstUrl = new URL(requestedUrls[0] ?? "");
    expect(firstUrl.searchParams.get("started_after")).toBe(since.toISOString());
    // user id parsed out of scopes "user_id:99887" via the regex.
    expect(firstUrl.searchParams.get("user")).toBe("99887");
    // offset starts at 0 and increments by 40 (not decrements) between pages.
    expect(firstUrl.searchParams.get("offset")).toBe("0");
    const secondUrl = new URL(requestedUrls[1] ?? "");
    expect(secondUrl.searchParams.get("offset")).toBe("40");
    // Api-Key header carries the client id from MAPMYFITNESS_CLIENT_ID.
    expect(apiKeyHeaders[0]).toBe("test-client-id");
  });

  it("defaults the user query param to '-' when scopes lack a user_id", async () => {
    await saveTokens(ctx.db, "mapmyfitness", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "read write",
    });

    const requestedUrls: string[] = [];
    server.use(
      http.get("https://api.mapmyfitness.com/v7.1/workout/", ({ request }) => {
        requestedUrls.push(request.url);
        return HttpResponse.json({
          _embedded: { workouts: [] },
          _links: {},
          total_count: 0,
        });
      }),
    );

    const provider = new MapMyFitnessProvider();
    await provider.sync(ctx.db, new Date("2026-05-01T00:00:00Z"));

    const url = new URL(requestedUrls[0] ?? "");
    expect(url.searchParams.get("user")).toBe("-");
  });

  it("stops paginating after an empty workout page and skips empty external ids", async () => {
    await saveTokens(ctx.db, "mapmyfitness", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user_id:12345",
    });

    let requestCount = 0;
    server.use(
      http.get("https://api.mapmyfitness.com/v7.1/workout/", () => {
        requestCount++;
        if (requestCount === 1) {
          // One valid workout plus one with no external id (must be skipped).
          const valid = fakeWorkout({
            id: "mmf-valid",
            start_datetime: "2026-06-10T08:00:00+00:00",
          });
          // _links present but no `self` array: `_links?.self?.[0]?.id` must yield ""
          // (removing the `?.` after `self` would throw on `self[0]`).
          const noSelf = {
            _links: {},
            name: "No Self Workout",
            start_datetime: "2026-06-11T08:00:00+00:00",
            start_locale_timezone: "UTC",
            activity_type: "Run",
            aggregates: { active_time_total: 1200 },
          };
          // _links absent entirely: removing the `?.` after `_links` would throw
          // on `_links.self`.
          const noLinks = {
            name: "No Links Workout",
            start_datetime: "2026-06-12T08:00:00+00:00",
            start_locale_timezone: "UTC",
            activity_type: "Run",
            aggregates: { active_time_total: 1200 },
          };
          return HttpResponse.json({
            _embedded: { workouts: [valid, noSelf, noLinks] },
            _links: { next: [{ href: "/v7.1/workout/?offset=40" }] },
            total_count: 3,
          });
        }
        if (requestCount === 2) {
          // Empty page that STILL advertises a next link: the length-0 break must
          // stop the loop here regardless of the next link.
          return HttpResponse.json({
            _embedded: { workouts: [] },
            _links: { next: [{ href: "/v7.1/workout/?offset=80" }] },
            total_count: 0,
          });
        }
        return HttpResponse.json({ _embedded: { workouts: [] }, _links: {}, total_count: 0 });
      }),
    );

    const provider = new MapMyFitnessProvider();
    const result = await provider.sync(ctx.db, new Date("2026-06-01T00:00:00Z"));

    // Loop fetched page 1 and the empty page, then broke (no 3rd request).
    expect(requestCount).toBe(2);
    // Only the workout with an external id was inserted.
    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toHaveLength(0);

    const rows = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.providerId, "mapmyfitness"));
    expect(rows.some((row) => row.externalId === "mmf-valid")).toBe(true);
    expect(rows.some((row) => row.externalId === "")).toBe(false);
  });

  it("treats a response without _embedded as an empty page", async () => {
    await saveTokens(ctx.db, "mapmyfitness", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user_id:12345",
    });

    server.use(
      http.get("https://api.mapmyfitness.com/v7.1/workout/", () => {
        // No _embedded present: `response._embedded?.workouts ?? []` must
        // resolve to [] rather than throwing.
        return HttpResponse.json({ _links: {}, total_count: 0 });
      }),
    );

    const provider = new MapMyFitnessProvider();
    const result = await provider.sync(ctx.db, new Date("2026-06-01T00:00:00Z"));

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(0);
    expect(result.duration).toBeGreaterThanOrEqual(0);
    expect(result.duration).toBeLessThan(60_000);
  });

  it("tolerates a page that has workouts but no _links object", async () => {
    await saveTokens(ctx.db, "mapmyfitness", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user_id:12345",
    });

    let requestCount = 0;
    server.use(
      http.get("https://api.mapmyfitness.com/v7.1/workout/", () => {
        requestCount++;
        // Workouts present so the loop reaches `hasMore = !!response._links?.next?.length`,
        // but _links is entirely absent: without the `?.` on _links this throws.
        return HttpResponse.json({
          _embedded: {
            workouts: [
              fakeWorkout({ id: "mmf-nolinks", start_datetime: "2026-06-20T08:00:00+00:00" }),
            ],
          },
          total_count: 1,
        });
      }),
    );

    const provider = new MapMyFitnessProvider();
    const result = await provider.sync(ctx.db, new Date("2026-06-01T00:00:00Z"));

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(1);
    // Missing _links.next means hasMore is false, so the loop runs exactly once.
    expect(requestCount).toBe(1);
  });

  it("surfaces a ProviderRateLimitError tagged with providerId on 429", async () => {
    await saveTokens(ctx.db, "mapmyfitness", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user_id:12345",
    });

    server.use(
      http.get("https://api.mapmyfitness.com/v7.1/workout/", () => {
        return HttpResponse.text("rate limited", { status: 429 });
      }),
    );

    const provider = new MapMyFitnessProvider();
    const result = await provider.sync(ctx.db, new Date("2026-06-01T00:00:00Z"));

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(1);
    const cause = result.errors[0]?.cause;
    if (!(cause instanceof ProviderRateLimitError)) {
      throw new Error(`expected ProviderRateLimitError cause, got ${String(cause)}`);
    }
    expect(cause.providerId).toBe("mapmyfitness");
  });
});
