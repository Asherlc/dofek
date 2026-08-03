import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { activity } from "../db/schema/activity.ts";
import { oauthToken } from "../db/schema/reference.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { ensureProvider, saveTokens } from "../db/tokens.ts";
import { failOnUnhandledExternalRequest } from "../test/msw.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";
import { createCapturingMetricStreamPublisher, fakeJwt } from "./test-helpers.ts";
import { WgerProvider } from "./wger.ts";

// ============================================================
// Fake Wger API responses
// ============================================================

interface FakeWgerWorkoutSession {
  id: number;
  date: string;
  comment: string;
  impression: string;
  time_start: string | null;
  time_end: string | null;
}

interface FakeWgerWeightEntry {
  id: number;
  date: string;
  weight: string;
}

function fakeWorkoutSession(
  overrides: Partial<FakeWgerWorkoutSession> = {},
): FakeWgerWorkoutSession {
  return {
    id: 101,
    date: "2026-03-01",
    comment: "Morning strength session",
    impression: "2",
    time_start: "08:00:00",
    time_end: "09:00:00",
    ...overrides,
  };
}

function fakeWeightEntry(overrides: Partial<FakeWgerWeightEntry> = {}): FakeWgerWeightEntry {
  return {
    id: 201,
    date: "2026-03-01",
    weight: "82.5",
    ...overrides,
  };
}

const refreshedAccessToken = fakeJwt(1_893_456_000);

function wgerHandlers(
  sessions: FakeWgerWorkoutSession[],
  weightEntries: FakeWgerWeightEntry[],
  opts?: { refreshError?: boolean },
) {
  return [
    // Token refresh
    http.post("https://wger.de/api/v2/token/refresh", () => {
      if (opts?.refreshError) {
        return new HttpResponse("Unauthorized", { status: 401 });
      }
      return HttpResponse.json({
        access: refreshedAccessToken,
        refresh: "new-refresh",
      });
    }),

    // Workout sessions list
    http.get("https://wger.de/api/v2/workoutsession/*", () => {
      return HttpResponse.json({
        count: sessions.length,
        next: null,
        previous: null,
        results: sessions,
      });
    }),

    // Weight entries list
    http.get("https://wger.de/api/v2/weightentry/*", () => {
      return HttpResponse.json({
        count: weightEntries.length,
        next: null,
        previous: null,
        results: weightEntries,
      });
    }),
  ];
}

const server = setupServer();
const metricStreamCapture = createCapturingMetricStreamPublisher();

describe("WgerProvider.sync() (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    process.env.WGER_CLIENT_ID = "test-client-id";
    process.env.WGER_CLIENT_SECRET = "test-client-secret";
    ctx = await setupTestDatabase();
    server.listen({ onUnhandledRequest: failOnUnhandledExternalRequest });
    await ensureProvider(ctx.db, "wger", "Wger", "https://wger.de/api/v2");
  }, 60_000);

  beforeEach(() => {
    metricStreamCapture.publishedMetricStreamRows.length = 0;
  });

  afterEach(() => {
    server.resetHandlers();
  });

  afterAll(async () => {
    server.close();
    if (ctx) await ctx.cleanup();
  });

  it("syncs workout sessions into activity and weight entries into Redpanda metric stream events", async () => {
    await saveTokens(ctx.db, "wger", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "read",
    });

    const sessions = [
      fakeWorkoutSession({ id: 101, date: "2026-03-01" }),
      fakeWorkoutSession({ id: 102, date: "2026-03-05", comment: "Leg day" }),
    ];
    const weights = [
      fakeWeightEntry({ id: 201, date: "2026-03-01", weight: "82.5" }),
      fakeWeightEntry({ id: 202, date: "2026-03-04", weight: "82.0" }),
    ];

    server.use(...wgerHandlers(sessions, weights));

    const provider = new WgerProvider();
    const since = new Date("2026-02-01T00:00:00Z");
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: since }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    expect(result.provider).toBe("wger");
    expect(result.recordsSynced).toBe(4); // 2 sessions + 2 weights
    expect(result.errors).toHaveLength(0);

    // Verify activity rows
    const activityRows = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.providerId, "wger"));
    expect(activityRows).toHaveLength(2);

    const session1 = activityRows.find((r) => r.externalId === "101");
    if (!session1) throw new Error("expected session 101");
    expect(session1.canonicalType).toBe("strength");
    expect(session1.name).toBe("Morning strength session");

    const session2 = activityRows.find((r) => r.externalId === "102");
    if (!session2) throw new Error("expected session 102");
    expect(session2.name).toBe("Leg day");

    const weightRows = metricStreamCapture.publishedMetricStreamRows;
    expect(weightRows).toHaveLength(2);

    const weight1 = weightRows.find((r) => r.externalId === "201" && r.channel === "body_weight");
    if (!weight1) throw new Error("expected weight 201");
    expect(weight1.scalar).toBeCloseTo(82.5);

    const weight2 = weightRows.find((r) => r.externalId === "202" && r.channel === "body_weight");
    if (!weight2) throw new Error("expected weight 202");
    expect(weight2.scalar).toBeCloseTo(82.0);
  });

  it("re-syncs without duplicates", async () => {
    await saveTokens(ctx.db, "wger", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "read",
    });

    const sessions = [fakeWorkoutSession({ id: 101, date: "2026-03-01" })];
    const weights = [fakeWeightEntry({ id: 203, date: "2026-03-01", weight: "83.0" })];

    server.use(...wgerHandlers(sessions, weights));

    const provider = new WgerProvider();
    await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    // Sync again — Redpanda appends raw events for each sync.
    await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    const activityRows = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.providerId, "wger"));
    const countOf101 = activityRows.filter((r) => r.externalId === "101").length;
    expect(countOf101).toBe(1);

    const weightRows = metricStreamCapture.publishedMetricStreamRows;
    const countOf203 = weightRows.filter(
      (r) => r.externalId === "203" && r.channel === "body_weight",
    ).length;
    expect(countOf203).toBe(2);

    // Verify the weight row was retained across the repeated sync.
    const updatedWeight = weightRows.find(
      (r) => r.externalId === "203" && r.channel === "body_weight",
    );
    if (!updatedWeight) throw new Error("expected weight 203");
    expect(updatedWeight.scalar).toBeCloseTo(83.0);
  });

  it("refreshes expired tokens and saves new ones", async () => {
    await saveTokens(ctx.db, "wger", {
      accessToken: "expired-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2025-01-01T00:00:00Z"), // expired
      scopes: "read",
    });

    server.use(...wgerHandlers([], []));

    const provider = new WgerProvider();
    await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    // Verify token was refreshed in DB
    const { loadTokens } = await import("../db/tokens.ts");
    const tokens = await loadTokens(ctx.db, "wger");
    expect(tokens?.accessToken).toBe(refreshedAccessToken);
    expect(tokens?.refreshToken).toBe("new-refresh");
  });

  it("handles pagination across multiple pages", async () => {
    await saveTokens(ctx.db, "wger", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "read",
    });

    let callCount = 0;

    server.use(
      http.get("https://wger.de/api/v2/workoutsession/*", () => {
        callCount++;
        if (callCount === 1) {
          return HttpResponse.json({
            count: 2,
            next: "https://wger.de/api/v2/workoutsession/?format=json&ordering=-date&offset=50&limit=50",
            previous: null,
            results: [fakeWorkoutSession({ id: 301, date: "2026-03-10" })],
          });
        }
        return HttpResponse.json({
          count: 2,
          next: null,
          previous: null,
          results: [fakeWorkoutSession({ id: 302, date: "2026-03-08" })],
        });
      }),

      http.get("https://wger.de/api/v2/weightentry/*", () => {
        return HttpResponse.json({ count: 0, next: null, previous: null, results: [] });
      }),
    );

    const provider = new WgerProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(2);
    expect(callCount).toBe(2);
  });

  it("sends bearer auth and JSON accept headers to Wger endpoints", async () => {
    await saveTokens(ctx.db, "wger", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "read",
    });

    const seenHeaders: string[] = [];

    server.use(
      http.get("https://wger.de/api/v2/workoutsession/*", ({ request }) => {
        seenHeaders.push(request.headers.get("authorization") ?? "");
        seenHeaders.push(request.headers.get("accept") ?? "");
        return HttpResponse.json({ count: 0, next: null, previous: null, results: [] });
      }),
      http.get("https://wger.de/api/v2/weightentry/*", ({ request }) => {
        seenHeaders.push(request.headers.get("authorization") ?? "");
        seenHeaders.push(request.headers.get("accept") ?? "");
        return HttpResponse.json({ count: 0, next: null, previous: null, results: [] });
      }),
    );

    const provider = new WgerProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    expect(result.errors).toHaveLength(0);
    expect(seenHeaders).toEqual([
      "Bearer valid-token",
      "application/json",
      "Bearer valid-token",
      "application/json",
    ]);
  });

  it("reports workout API errors without syncing activity rows", async () => {
    await saveTokens(ctx.db, "wger", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "read",
    });
    await ctx.db.delete(activity).where(eq(activity.providerId, "wger"));

    server.use(
      http.get("https://wger.de/api/v2/workoutsession/*", () => {
        return HttpResponse.json({ detail: "server error" }, { status: 500 });
      }),
      http.get("https://wger.de/api/v2/weightentry/*", () => {
        return HttpResponse.json({ count: 0, next: null, previous: null, results: [] });
      }),
    );

    const provider = new WgerProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    expect(result.recordsSynced).toBe(0);
    expect(result.errors.map((error) => error.message)).toContainEqual(
      expect.stringContaining("activity: Wger API error (500)"),
    );
    const activityRows = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.providerId, "wger"));
    expect(activityRows).toHaveLength(0);
  });

  it("reports weight API errors without syncing body weight rows", async () => {
    await saveTokens(ctx.db, "wger", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "read",
    });

    server.use(
      http.get("https://wger.de/api/v2/workoutsession/*", () => {
        return HttpResponse.json({ count: 0, next: null, previous: null, results: [] });
      }),
      http.get("https://wger.de/api/v2/weightentry/*", () => {
        return HttpResponse.json({ detail: "server error" }, { status: 500 });
      }),
    );

    const provider = new WgerProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    expect(result.recordsSynced).toBe(0);
    expect(result.errors.map((error) => error.message)).toContainEqual(
      expect.stringContaining("metric_stream: Wger API error (500)"),
    );
    expect(metricStreamCapture.publishedMetricStreamRows).toHaveLength(0);
  });

  it("stops weight pagination when a page includes an entry before the sync window", async () => {
    await saveTokens(ctx.db, "wger", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "read",
    });

    let weightCalls = 0;

    server.use(
      http.get("https://wger.de/api/v2/workoutsession/*", () => {
        return HttpResponse.json({ count: 0, next: null, previous: null, results: [] });
      }),
      http.get("https://wger.de/api/v2/weightentry/*", () => {
        weightCalls += 1;
        if (weightCalls === 1) {
          return HttpResponse.json({
            count: 2,
            next: "https://wger.de/api/v2/weightentry/?format=json&ordering=-date&offset=50&limit=50",
            previous: null,
            results: [
              fakeWeightEntry({ id: 501, date: "2026-03-05", weight: "81.0" }),
              fakeWeightEntry({ id: 502, date: "2026-01-15", weight: "80.0" }),
            ],
          });
        }
        return HttpResponse.json({
          count: 1,
          next: null,
          previous: null,
          results: [fakeWeightEntry({ id: 503, date: "2026-03-04", weight: "79.0" })],
        });
      }),
    );

    const provider = new WgerProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-03-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(1);
    expect(weightCalls).toBe(1);
    expect(metricStreamCapture.publishedMetricStreamRows).toHaveLength(1);
    expect(metricStreamCapture.publishedMetricStreamRows[0]?.externalId).toBe("501");
  });

  it("stops pagination when session date is before since", async () => {
    await saveTokens(ctx.db, "wger", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "read",
    });

    const sessions = [
      fakeWorkoutSession({ id: 401, date: "2026-03-10" }),
      fakeWorkoutSession({ id: 402, date: "2025-12-01" }), // before since
    ];

    server.use(...wgerHandlers(sessions, []));

    const provider = new WgerProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-01-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    // Only the first session should be synced
    expect(result.recordsSynced).toBe(1);
  });

  it("returns error when no tokens exist", async () => {
    await ctx.db.delete(oauthToken).where(eq(oauthToken.providerId, "wger"));

    const provider = new WgerProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toBe(
      "No tokens found for Wger. Connect Wger in Data Sources.",
    );
    expect(result.recordsSynced).toBe(0);
  });
});
