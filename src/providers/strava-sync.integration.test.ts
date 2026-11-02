import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { upsertProviderActivity } from "../db/provider-activity-sync.ts";
import { activity } from "../db/schema/activity.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { ensureProvider, saveTokens } from "../db/tokens.ts";
import { createIntegrationMswFixture } from "../test/early-msw-lifecycle.ts";
import { failOnUnhandledExternalRequest } from "../test/msw.ts";
import type { StravaActivity, StravaDetailedActivity, StravaStreamSet } from "./strava/provider.ts";
import { parseStravaActivity, StravaProvider } from "./strava/provider.ts";
import { createMemoryCheckpointStore } from "./strava/test-helpers.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";
import { createCapturingMetricStreamPublisher } from "./test-helpers.ts";

function fakeActivity(overrides: Partial<StravaActivity> = {}): StravaActivity {
  return {
    id: 1001,
    name: "Morning Ride",
    type: "Ride",
    sport_type: "Ride",
    start_date: "2026-03-01T10:00:00Z",
    elapsed_time: 3700,
    moving_time: 3600,
    distance: 42000,
    total_elevation_gain: 350,
    average_speed: 11.67,
    max_speed: 15.5,
    average_heartrate: 155,
    max_heartrate: 178,
    average_watts: 220,
    average_cadence: 88,
    trainer: false,
    commute: false,
    manual: false,
    ...overrides,
  };
}

function fakeStreams(): StravaStreamSet {
  return {
    time: { data: [0, 1, 2], series_type: "time", resolution: "high", original_size: 3 },
    heartrate: { data: [130, 135, 140], series_type: "time", resolution: "high", original_size: 3 },
    watts: { data: [200, 210, 205], series_type: "time", resolution: "high", original_size: 3 },
    cadence: { data: [85, 88, 86], series_type: "time", resolution: "high", original_size: 3 },
    velocity_smooth: {
      data: [8.5, 8.7, 8.6],
      series_type: "time",
      resolution: "high",
      original_size: 3,
    },
    latlng: {
      data: [
        [40.7128, -74.006],
        [40.7129, -74.0059],
        [40.713, -74.0058],
      ],
      series_type: "time",
      resolution: "high",
      original_size: 3,
    },
    altitude: {
      data: [15.2, 15.5, 15.8],
      series_type: "time",
      resolution: "high",
      original_size: 3,
    },
  };
}

function stravaHandlers(
  activities: StravaActivity[],
  opts?: { streamsError?: boolean; rateLimited?: boolean },
) {
  const streams = fakeStreams();
  const streamArray = Object.entries(streams).map(([type, stream]) => ({
    type,
    ...stream,
  }));

  return [
    // Token refresh
    http.post("https://www.strava.com/oauth/token", () => {
      return HttpResponse.json({
        access_token: "refreshed-token",
        refresh_token: "new-refresh",
        expires_in: 21600,
        token_type: "Bearer",
      });
    }),

    // Detailed activity endpoint (for device_name/source tracking)
    http.get("https://www.strava.com/api/v3/activities/:activityId", ({ params }) => {
      if (opts?.rateLimited) {
        return new HttpResponse("Rate Limit Exceeded", {
          status: 429,
          headers: { "X-RateLimit-Limit": "100,1000", "X-RateLimit-Usage": "100,950" },
        });
      }
      const activityId = Number(params.activityId);
      const act = activities.find((a) => a.id === activityId);
      if (!act) {
        return new HttpResponse("Not Found", { status: 404 });
      }
      const detail: StravaDetailedActivity = { ...act, device_name: "Garmin Edge 530" };
      return HttpResponse.json(detail);
    }),

    // Streams endpoint
    http.get("https://www.strava.com/api/v3/activities/:activityId/streams", () => {
      if (opts?.rateLimited) {
        return new HttpResponse("Rate Limit Exceeded", {
          status: 429,
          headers: { "X-RateLimit-Limit": "100,1000", "X-RateLimit-Usage": "100,950" },
        });
      }
      if (opts?.streamsError) {
        return new HttpResponse("Internal Server Error", { status: 500 });
      }
      return HttpResponse.json(streamArray);
    }),

    // Activities list
    http.get("https://www.strava.com/api/v3/athlete/activities", () => {
      if (opts?.rateLimited) {
        return new HttpResponse("Rate Limit Exceeded", {
          status: 429,
          headers: { "X-RateLimit-Limit": "100,1000", "X-RateLimit-Usage": "100,950" },
        });
      }
      return HttpResponse.json(activities);
    }),
  ];
}

const server = createIntegrationMswFixture();
const metricStreamCapture = createCapturingMetricStreamPublisher();

describe("StravaProvider.sync() (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    process.env.STRAVA_CLIENT_ID = "test-client-id";
    process.env.STRAVA_CLIENT_SECRET = "test-client-secret";
    ctx = await setupTestDatabase();
    server.activate({ onUnhandledFrame: failOnUnhandledExternalRequest });
    await ensureProvider(ctx.db, "strava", "Strava", "https://www.strava.com/api/v3");
  }, 60_000);

  beforeEach(() => {
    metricStreamCapture.publishedMetricStreamRows.length = 0;
  });

  afterEach(() => {
    server.resetHandlers();
  });

  afterAll(async () => {
    server.deactivate();
    if (ctx) await ctx.cleanup();
  });

  it.each(["unchanged", "deleted", "inserted", "renamed"])(
    "reconciles fresh inventory after an interrupted sync: %s",
    async (mutation) => {
      const isolated = await setupTestDatabase();
      try {
        await ensureProvider(isolated.db, "strava", "Strava", "https://www.strava.com/api/v3");
        await saveTokens(isolated.db, "strava", {
          accessToken: "valid-token",
          refreshToken: "valid-refresh",
          expiresAt: new Date("2027-01-01T00:00:00Z"),
          scopes: "read,activity:read_all",
        });
        const activities = Array.from({ length: 31 }, (_, index) =>
          fakeActivity({
            id: 7000 + index,
            start_date: "2026-05-01T10:00:00Z",
          }),
        );
        const lastActivity = activities.at(-1);
        if (!lastActivity) throw new Error("Missing last fixture activity");
        await upsertProviderActivity(
          isolated.db,
          { ...parseStravaActivity(lastActivity), providerId: "strava", raw: lastActivity },
          { name: lastActivity.name },
        );
        let inventory = activities;
        const pages: number[] = [];
        let interrupted = false;
        server.use(
          ...stravaHandlers([
            ...activities,
            fakeActivity({ id: 6999, start_date: "2026-05-01T09:59:00Z" }),
          ]),
        );
        server.use(
          http.get("https://www.strava.com/api/v3/athlete/activities", ({ request }) => {
            const page = Number(new URL(request.url).searchParams.get("page"));
            pages.push(page);
            if (page === 2 && !interrupted) {
              interrupted = true;
              return new HttpResponse("Rate Limit Exceeded", { status: 429 });
            }
            return HttpResponse.json(inventory.slice((page - 1) * 30, page * 30));
          }),
        );
        const checkpoint = createMemoryCheckpointStore();
        const window = SyncWindow.fromIsoRange({
          sinceIso: "2026-05-01T00:00:00.000Z",
          untilIso: "2026-05-02T00:00:00.000Z",
        });
        const first = await new StravaProvider(globalThis.fetch).sync(
          new SyncRun({
            db: isolated.db,
            window,
            checkpoint,
            metricStreamPublisher: metricStreamCapture.publisher,
          }),
        );
        expect(first.errors).toHaveLength(1);
        const publishedBeforeResume = metricStreamCapture.publishedMetricStreamRows.length;
        if (mutation === "deleted") inventory = activities.slice(1);
        if (mutation === "renamed") {
          inventory = activities.map((entry, index) =>
            index === 0
              ? { ...entry, name: "Renamed mountain ride", sport_type: "MountainBikeRide" }
              : entry,
          );
        }
        if (mutation === "inserted") {
          const inserted = fakeActivity({ id: 6999, start_date: "2026-05-01T09:59:00Z" });
          inventory = [inserted, ...activities];
          await upsertProviderActivity(
            isolated.db,
            { ...parseStravaActivity(inserted), providerId: "strava", raw: inserted },
            { name: inserted.name },
          );
        }
        const resumed = await new StravaProvider(globalThis.fetch).sync(
          new SyncRun({
            db: isolated.db,
            window,
            checkpoint,
            metricStreamPublisher: metricStreamCapture.publisher,
          }),
        );
        expect(resumed.errors).toHaveLength(0);
        expect(resumed.recordsSynced).toBe(mutation === "inserted" ? 2 : 1);
        const ids = new Set([...activities, ...inventory].map((entry) => String(entry.id)));
        const rows = (
          await isolated.db.select().from(activity).where(eq(activity.providerId, "strava"))
        ).filter((row) => ids.has(row.externalId));
        expect(rows).toHaveLength(mutation === "inserted" ? 32 : 31);
        const present = new Set(inventory.map((entry) => String(entry.id)));
        for (const row of rows)
          expect(row.providerAbsentAt === null).toBe(present.has(row.externalId));
        if (mutation === "renamed") {
          const renamed = rows.find((row) => row.externalId === "7000");
          expect(renamed).toMatchObject({
            name: "Renamed mountain ride",
            canonicalType: "cycling",
            modality: "mountain",
            sourceName: "Garmin Edge 530",
            raw: { name: "Renamed mountain ride", device_name: "Garmin Edge 530" },
          });
        }
        const last = rows.find((row) => row.externalId === "7030");
        if (!last) throw new Error("Missing resumed Strava activity");
        const newSamples =
          metricStreamCapture.publishedMetricStreamRows.slice(publishedBeforeResume);
        expect(newSamples.length).toBeGreaterThan(0);
        const remaining = rows.filter(
          (row) => row.externalId === "7030" || row.externalId === "6999",
        );
        expect(new Set(newSamples.map((sample) => sample.activityId))).toEqual(
          new Set(remaining.map((row) => row.id)),
        );
        expect(pages).toEqual([1, 2, 1, 2]);
        expect(await checkpoint.load()).toBeNull();
      } finally {
        await isolated.cleanup();
      }
    },
  );

  it("syncs activities with streams into activity and Redpanda metric stream events", async () => {
    await saveTokens(ctx.db, "strava", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "read,activity:read_all",
    });

    const activities = [
      fakeActivity({ id: 1001, start_date: "2026-03-01T10:00:00Z" }),
      fakeActivity({
        id: 1002,
        start_date: "2026-03-05T14:00:00Z",
        type: "Run",
        sport_type: "Run",
      }),
    ];

    server.use(...stravaHandlers(activities));

    const provider = new StravaProvider(globalThis.fetch);
    const since = new Date("2026-02-01T00:00:00Z");
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: since }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    expect(result.provider).toBe("strava");
    expect(result.recordsSynced).toBe(2);
    expect(result.errors).toHaveLength(0);

    // Verify activity rows
    const rows = await ctx.db.select().from(activity).where(eq(activity.providerId, "strava"));
    expect(rows).toHaveLength(2);

    const ride = rows.find((r) => r.externalId === "1001");
    if (!ride) throw new Error("expected activity 1001");
    expect(ride.canonicalType).toBe("cycling");
    expect(ride.name).toBe("Morning Ride");

    const run = rows.find((r) => r.externalId === "1002");
    if (!run) throw new Error("expected activity 1002");
    expect(run.canonicalType).toBe("running");

    // Verify metric stream events
    const metrics = metricStreamCapture.publishedMetricStreamRows.filter(
      (row) => row.activityId === ride.id,
    );
    const heartRateSamples = metrics.filter((sample) => sample.channel === "heart_rate");
    const powerSamples = metrics.filter((sample) => sample.channel === "power");
    expect(heartRateSamples).toHaveLength(3);
    expect(powerSamples).toHaveLength(3);
    expect(heartRateSamples[0]?.scalar).toBe(130);
    expect(powerSamples[0]?.scalar).toBe(200);
  });

  it("upserts on re-sync (no duplicates)", async () => {
    await saveTokens(ctx.db, "strava", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "read,activity:read_all",
    });

    const activities = [fakeActivity({ id: 1001, start_date: "2026-03-01T10:00:00Z" })];

    server.use(...stravaHandlers(activities));

    const provider = new StravaProvider(globalThis.fetch);
    await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );
    await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    const rows = await ctx.db.select().from(activity).where(eq(activity.providerId, "strava"));
    const countOf1001 = rows.filter((r) => r.externalId === "1001").length;
    expect(countOf1001).toBe(1);
  });

  it("refreshes expired tokens and saves new ones", async () => {
    await saveTokens(ctx.db, "strava", {
      accessToken: "expired-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2025-01-01T00:00:00Z"),
      scopes: "read,activity:read_all",
    });

    server.use(...stravaHandlers([]));

    const provider = new StravaProvider(globalThis.fetch);
    await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    const { loadTokens } = await import("../db/tokens.ts");
    const tokens = await loadTokens(ctx.db, "strava");
    expect(tokens?.accessToken).toBe("refreshed-token");
  });

  it("continues syncing if streams fetch fails", async () => {
    await saveTokens(ctx.db, "strava", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "read,activity:read_all",
    });

    const activities = [fakeActivity({ id: 3001, start_date: "2026-05-01T10:00:00Z" })];
    const removed = fakeActivity({ id: 3002, start_date: "2026-05-01T11:00:00Z" });
    await upsertProviderActivity(
      ctx.db,
      { ...parseStravaActivity(removed), providerId: "strava", raw: removed },
      { name: removed.name },
    );
    const window = SyncWindow.fromIsoRange({
      sinceIso: "2026-05-01T00:00:00.000Z",
      untilIso: "2026-05-02T00:00:00.000Z",
    });
    const checkpoint = createMemoryCheckpointStore({
      version: 1,
      sinceIso: window.sinceIso,
      untilIso: window.untilIso,
      completedActivityExternalIds: [],
    });

    server.use(...stravaHandlers(activities, { streamsError: true }));

    const provider = new StravaProvider(globalThis.fetch);
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window,
        checkpoint,
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    // Activity should still be inserted
    expect(result.recordsSynced).toBe(1);
    // But there should be a streams error
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("Streams");

    const activities2 = await ctx.db.select().from(activity).where(eq(activity.externalId, "3001"));
    expect(activities2).toHaveLength(1);
    const removedRows = await ctx.db.select().from(activity).where(eq(activity.externalId, "3002"));
    expect(removedRows[0]?.providerAbsentAt).toBeInstanceOf(Date);
    expect(await checkpoint.load()).not.toBeNull();
  });

  it("stops fetching streams on rate limit (429) but keeps synced activities", async () => {
    await saveTokens(ctx.db, "strava", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "read,activity:read_all",
    });

    const activities = [
      fakeActivity({ id: 4001, start_date: "2026-06-01T10:00:00Z" }),
      fakeActivity({ id: 4002, start_date: "2026-06-02T10:00:00Z" }),
    ];

    server.use(...stravaHandlers(activities, { rateLimited: true }));

    const provider = new StravaProvider(globalThis.fetch);
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-05-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    // Should report rate limit error
    expect(
      result.errors.some((e) => e.message.includes("rate limit") || e.message.includes("429")),
    ).toBe(true);
  });

  it("returns error when no tokens exist", async () => {
    const { oauthToken } = await import("../db/schema/reference.ts");
    await ctx.db.delete(oauthToken).where(eq(oauthToken.providerId, "strava"));

    const provider = new StravaProvider(globalThis.fetch);
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("No OAuth tokens found");
    expect(result.recordsSynced).toBe(0);
  });
});
