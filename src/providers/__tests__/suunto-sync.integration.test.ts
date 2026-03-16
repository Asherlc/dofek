import { eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../db/__tests__/test-helpers.ts";
import { activity, oauthToken } from "../../db/schema.ts";
import { ensureProvider, saveTokens } from "../../db/tokens.ts";
import { SuuntoProvider } from "../suunto.ts";

// ============================================================
// Fake Suunto API responses
// ============================================================

interface FakeWorkoutOverrides {
  workoutKey?: string;
  activityId?: number;
  workoutName?: string;
  startTime?: number;
  stopTime?: number;
  totalTime?: number;
  totalDistance?: number;
  totalAscent?: number;
  totalDescent?: number;
  avgSpeed?: number;
  maxSpeed?: number;
  energyConsumption?: number;
  stepCount?: number;
  hrdata?: { workoutAvgHR: number; workoutMaxHR: number };
}

function fakeWorkout(overrides: FakeWorkoutOverrides = {}) {
  return {
    workoutKey: "abc-123-def",
    activityId: 3, // cycling
    workoutName: "Evening Ride",
    startTime: 1709280000000, // 2024-03-01T08:00:00Z
    stopTime: 1709283600000, // 2024-03-01T09:00:00Z
    totalTime: 3600,
    totalDistance: 35000,
    totalAscent: 300,
    totalDescent: 290,
    avgSpeed: 9.72,
    maxSpeed: 14.5,
    energyConsumption: 750,
    stepCount: 0,
    hrdata: { workoutAvgHR: 145, workoutMaxHR: 172 },
    ...overrides,
  };
}

function suuntoHandlers(workouts: Array<ReturnType<typeof fakeWorkout>>) {
  return [
    // Token refresh
    http.post("https://cloudapi-oauth.suunto.com/oauth/token", () => {
      return HttpResponse.json({
        access_token: "refreshed-token",
        refresh_token: "new-refresh",
        expires_in: 7200,
      });
    }),

    // Workouts list
    http.get("https://cloudapi.suunto.com/v2/workouts", () => {
      return HttpResponse.json({ payload: workouts });
    }),
  ];
}

const server = setupServer();

describe("SuuntoProvider.sync() (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    server.listen({ onUnhandledRequest: "error" });
    process.env.SUUNTO_CLIENT_ID = "test-client-id";
    process.env.SUUNTO_CLIENT_SECRET = "test-client-secret";
    process.env.SUUNTO_SUBSCRIPTION_KEY = "test-subscription-key";
    ctx = await setupTestDatabase();
    await ensureProvider(ctx.db, "suunto", "Suunto", "https://cloudapi.suunto.com");
  }, 60_000);

  afterEach(() => {
    server.resetHandlers();
  });

  afterAll(async () => {
    server.close();
    if (ctx) await ctx.cleanup();
  });

  it("syncs workouts into activity table", async () => {
    await saveTokens(ctx.db, "suunto", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "workout",
    });

    const workouts = [
      fakeWorkout({
        workoutKey: "suunto-w1",
        activityId: 3,
        workoutName: "Morning Cycle",
        startTime: 1709280000000,
        stopTime: 1709283600000,
      }),
      fakeWorkout({
        workoutKey: "suunto-w2",
        activityId: 2,
        workoutName: "Afternoon Run",
        startTime: 1709294400000,
        stopTime: 1709298000000,
      }),
    ];

    server.use(...suuntoHandlers(workouts));

    const provider = new SuuntoProvider();
    const result = await provider.sync(ctx.db, new Date("2024-02-01T00:00:00Z"));

    expect(result.provider).toBe("suunto");
    expect(result.recordsSynced).toBe(2);
    expect(result.errors).toHaveLength(0);

    const rows = await ctx.db.select().from(activity).where(eq(activity.providerId, "suunto"));

    expect(rows).toHaveLength(2);

    const cycling = rows.find((r) => r.externalId === "suunto-w1");
    if (!cycling) throw new Error("expected workout suunto-w1");
    expect(cycling.activityType).toBe("cycling");
    expect(cycling.name).toBe("Morning Cycle");

    const running = rows.find((r) => r.externalId === "suunto-w2");
    if (!running) throw new Error("expected workout suunto-w2");
    expect(running.activityType).toBe("running");
  });

  it("upserts on re-sync (no duplicates)", async () => {
    await saveTokens(ctx.db, "suunto", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "workout",
    });

    const workouts = [fakeWorkout({ workoutKey: "suunto-w1" })];

    server.use(...suuntoHandlers(workouts));

    const provider = new SuuntoProvider();
    await provider.sync(ctx.db, new Date("2024-02-01T00:00:00Z"));

    // Sync again
    await provider.sync(ctx.db, new Date("2024-02-01T00:00:00Z"));

    const rows = await ctx.db.select().from(activity).where(eq(activity.providerId, "suunto"));

    const countOfW1 = rows.filter((r) => r.externalId === "suunto-w1").length;
    expect(countOfW1).toBe(1);
  });

  it("maps activity types correctly", async () => {
    await saveTokens(ctx.db, "suunto", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "workout",
    });

    const workouts = [
      fakeWorkout({ workoutKey: "suunto-walk", activityId: 11, workoutName: "Walk" }),
      fakeWorkout({ workoutKey: "suunto-hike", activityId: 12, workoutName: "Hike" }),
      fakeWorkout({ workoutKey: "suunto-swim", activityId: 27, workoutName: "Swim" }),
      fakeWorkout({ workoutKey: "suunto-unknown", activityId: 999 }),
    ];

    server.use(...suuntoHandlers(workouts));

    const provider = new SuuntoProvider();
    const result = await provider.sync(ctx.db, new Date("2024-02-01T00:00:00Z"));
    expect(result.recordsSynced).toBe(4);

    const rows = await ctx.db.select().from(activity).where(eq(activity.providerId, "suunto"));

    const walk = rows.find((r) => r.externalId === "suunto-walk");
    expect(walk?.activityType).toBe("walking");

    const hike = rows.find((r) => r.externalId === "suunto-hike");
    expect(hike?.activityType).toBe("hiking");

    const swim = rows.find((r) => r.externalId === "suunto-swim");
    expect(swim?.activityType).toBe("swimming");

    const unknown = rows.find((r) => r.externalId === "suunto-unknown");
    expect(unknown?.activityType).toBe("other");
  });

  it("refreshes expired tokens and saves new ones", async () => {
    await saveTokens(ctx.db, "suunto", {
      accessToken: "expired-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2025-01-01T00:00:00Z"), // expired
      scopes: "workout",
    });

    server.use(...suuntoHandlers([]));

    const provider = new SuuntoProvider();
    await provider.sync(ctx.db, new Date("2024-02-01T00:00:00Z"));

    const { loadTokens } = await import("../../db/tokens.ts");
    const tokens = await loadTokens(ctx.db, "suunto");
    expect(tokens?.accessToken).toBe("refreshed-token");
  });

  it("returns error when no tokens exist", async () => {
    await ctx.db.delete(oauthToken).where(eq(oauthToken.providerId, "suunto"));

    const provider = new SuuntoProvider();
    const result = await provider.sync(ctx.db, new Date("2024-02-01T00:00:00Z"));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("No OAuth tokens");
    expect(result.recordsSynced).toBe(0);
  });
});
