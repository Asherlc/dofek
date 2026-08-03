import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activity } from "../db/schema/activity.ts";
import { oauthToken } from "../db/schema/reference.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { ensureProvider, saveTokens } from "../db/tokens.ts";
import { failOnUnhandledExternalRequest } from "../test/msw.ts";
import { MapMyFitnessProvider } from "./mapmyfitness.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";

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
    omitLinks?: boolean;
  }>;
  onWorkoutRequest?: (offset: number) => void;
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
    http.get("https://api.mapmyfitness.com/v7.1/workout/", ({ request }) => {
      const offset = Number(new URL(request.url).searchParams.get("offset") ?? "0");
      opts.onWorkoutRequest?.(offset);
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
        ...(page.omitLinks
          ? {}
          : {
              _links: {
                next: page.hasNext ? [{ href: "/v7.1/workout/?offset=40" }] : undefined,
              },
            }),
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
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
      }),
    );

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
    expect(run.canonicalType).toBe("running");
    expect(run.name).toBe("Morning Run");

    const bike = rows.find((r) => r.externalId === "mmf-1002");
    if (!bike) throw new Error("expected workout mmf-1002");
    expect(bike.canonicalType).toBe("cycling");
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
    await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
      }),
    );

    // Sync again
    server.resetHandlers();
    server.use(...mapmyfitHandlers({ pages: [{ workouts, hasNext: false }] }));

    const provider2 = new MapMyFitnessProvider();
    await provider2.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
      }),
    );

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
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-03-15T00:00:00Z") }),
      }),
    );

    expect(result.recordsSynced).toBe(3);
    expect(result.errors).toHaveLength(0);
  });

  it("treats a missing pagination links object as a complete list", async () => {
    await saveTokens(ctx.db, "mapmyfitness", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user_id:12345",
    });

    const offsets: number[] = [];
    const workouts = [
      fakeWorkout({ id: "mmf-no-links", start_datetime: "2026-04-04T08:00:00+00:00" }),
    ];
    server.use(
      ...mapmyfitHandlers({
        pages: [{ workouts, hasNext: false, omitLinks: true }],
        onWorkoutRequest: (offset) => offsets.push(offset),
      }),
    );

    const provider = new MapMyFitnessProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-03-15T00:00:00Z") }),
      }),
    );

    expect(result.recordsSynced).toBe(1);
    expect(result.degradations).toBeUndefined();
    expect(offsets).toEqual([0]);
  });

  it("does not degrade when an empty page has no next link", async () => {
    await saveTokens(ctx.db, "mapmyfitness", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user_id:12345",
    });

    server.use(...mapmyfitHandlers({ pages: [{ workouts: [], hasNext: false }] }));

    const provider = new MapMyFitnessProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-03-15T00:00:00Z") }),
      }),
    );

    expect(result.recordsSynced).toBe(0);
    expect(result.degradations).toBeUndefined();
  });

  it("reconciles missing activities after a complete list", async () => {
    const userId = "00000000-0000-0000-0000-000000000001";
    await saveTokens(ctx.db, "mapmyfitness", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user_id:12345",
    });
    await ctx.db.insert(activity).values({
      providerId: "mapmyfitness",
      userId,
      externalId: "mmf-reconcile-missing",
      canonicalType: "running",
      providerType: "Run",
      modality: null,
      startedAt: new Date("2026-04-01T08:00:00Z"),
      endedAt: new Date("2026-04-01T09:00:00Z"),
    });

    server.use(
      ...mapmyfitHandlers({
        pages: [
          {
            workouts: [
              fakeWorkout({
                id: "mmf-reconcile-present",
                start_datetime: "2026-04-02T08:00:00+00:00",
              }),
            ],
            hasNext: false,
          },
        ],
      }),
    );

    const provider = new MapMyFitnessProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-03-15T00:00:00Z") }),
        userId,
      }),
    );

    expect(result.degradations).toBeUndefined();
    const [missing] = await ctx.db
      .select({ providerAbsentAt: activity.providerAbsentAt })
      .from(activity)
      .where(eq(activity.externalId, "mmf-reconcile-missing"));
    expect(missing?.providerAbsentAt).toBeInstanceOf(Date);
  });

  it("reports degraded pagination and skips reconciliation when an empty page still has a next link", async () => {
    await saveTokens(ctx.db, "mapmyfitness", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user_id:12345",
    });
    const userId = "00000000-0000-0000-0000-000000000001";
    await ctx.db.insert(activity).values({
      providerId: "mapmyfitness",
      userId,
      externalId: "mmf-degraded-missing",
      canonicalType: "running",
      providerType: "Run",
      modality: null,
      startedAt: new Date("2026-04-01T08:00:00Z"),
      endedAt: new Date("2026-04-01T09:00:00Z"),
    });

    const page1Workouts = [
      fakeWorkout({ id: "mmf-degraded-p1", start_datetime: "2026-04-01T08:00:00+00:00" }),
    ];

    server.use(
      ...mapmyfitHandlers({
        pages: [
          { workouts: page1Workouts, hasNext: true },
          { workouts: [], hasNext: true },
        ],
      }),
    );

    const provider = new MapMyFitnessProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-03-15T00:00:00Z") }),
        userId,
      }),
    );

    expect(result.recordsSynced).toBe(1);
    expect(result.degradations).toEqual([
      expect.objectContaining({
        kind: "pagination_empty_page_with_cursor",
        providerId: "mapmyfitness",
        stepName: "activity_list",
        message: "Provider returned an empty page with a continuation cursor",
        context: {
          cursorFingerprint: expect.any(String),
          pagesFetched: 2,
        },
      }),
    ]);
    const [missing] = await ctx.db
      .select({ providerAbsentAt: activity.providerAbsentAt })
      .from(activity)
      .where(eq(activity.externalId, "mmf-degraded-missing"));
    expect(missing?.providerAbsentAt).toBeNull();
  });

  it("reports max-page degradation at the exact page guard and preserves offset progression", async () => {
    await saveTokens(ctx.db, "mapmyfitness", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user_id:12345",
    });

    const offsets: number[] = [];
    const pages = Array.from({ length: 100 }, (_, index) => ({
      workouts: [
        fakeWorkout({
          id: `mmf-max-page-${index + 1}`,
          start_datetime: "2026-04-01T08:00:00+00:00",
        }),
      ],
      hasNext: true,
    }));

    server.use(
      ...mapmyfitHandlers({
        pages,
        onWorkoutRequest: (offset) => offsets.push(offset),
      }),
    );

    const provider = new MapMyFitnessProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-03-15T00:00:00Z") }),
      }),
    );

    expect(result.recordsSynced).toBe(100);
    expect(result.degradations).toEqual([
      expect.objectContaining({
        kind: "pagination_max_pages_exceeded",
        providerId: "mapmyfitness",
        stepName: "activity_list",
        message: "Provider pagination exceeded the maximum page count",
        context: {
          cursorFingerprint: expect.any(String),
          pagesFetched: 100,
        },
      }),
    ]);
    expect(offsets).toHaveLength(100);
    expect(offsets[0]).toBe(0);
    expect(offsets.at(-1)).toBe(3960);
  });

  it("syncs workouts at the window end and skips workouts after it", async () => {
    await saveTokens(ctx.db, "mapmyfitness", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user_id:12345",
    });

    const workouts = [
      fakeWorkout({
        id: "mmf-at-window-end",
        start_datetime: "2026-04-02T08:00:00.000+00:00",
      }),
      fakeWorkout({
        id: "mmf-after-window-end",
        start_datetime: "2026-04-02T08:00:00.001+00:00",
      }),
    ];

    server.use(...mapmyfitHandlers({ pages: [{ workouts, hasNext: false }] }));

    const provider = new MapMyFitnessProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: new SyncWindow({
          since: new Date("2026-04-01T00:00:00.000Z"),
          until: new Date("2026-04-02T08:00:00.000Z"),
        }),
      }),
    );

    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toHaveLength(0);

    const rows = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.providerId, "mapmyfitness"));

    expect(rows.some((row) => row.externalId === "mmf-at-window-end")).toBe(true);
    expect(rows.some((row) => row.externalId === "mmf-after-window-end")).toBe(false);
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
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-04-01T00:00:00Z") }),
      }),
    );
    expect(result.recordsSynced).toBe(4);

    const rows = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.providerId, "mapmyfitness"));

    const walk = rows.find((r) => r.externalId === "mmf-walk");
    expect(walk?.canonicalType).toBe("walking");

    const swim = rows.find((r) => r.externalId === "mmf-swim");
    expect(swim?.canonicalType).toBe("swimming");

    const hike = rows.find((r) => r.externalId === "mmf-hike");
    expect(hike?.canonicalType).toBe("hiking");

    const yoga = rows.find((r) => r.externalId === "mmf-yoga");
    expect(yoga?.canonicalType).toBe("yoga");
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
    await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
      }),
    );

    const { loadTokens } = await import("../db/tokens.ts");
    const tokens = await loadTokens(ctx.db, "mapmyfitness");
    expect(tokens?.accessToken).toBe("refreshed-token");
  });

  it("returns error when no tokens exist", async () => {
    await ctx.db.delete(oauthToken).where(eq(oauthToken.providerId, "mapmyfitness"));

    const provider = new MapMyFitnessProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
      }),
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("No OAuth tokens");
    expect(result.recordsSynced).toBe(0);
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
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-06-01T00:00:00Z") }),
      }),
    );

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toHaveLength(1);
    const cause = result.errors[0]?.cause;
    if (!(cause instanceof ProviderRateLimitError)) {
      throw new Error(`expected ProviderRateLimitError cause, got ${String(cause)}`);
    }
    expect(cause.providerId).toBe("mapmyfitness");
  });
});
