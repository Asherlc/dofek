import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activity, oauthToken } from "../db/schema.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { ensureProvider, saveTokens } from "../db/tokens.ts";
import { failOnUnhandledExternalRequest } from "../test/msw.ts";
import { TrainerRoadProvider } from "./trainerroad.ts";

// ============================================================
// Fake TrainerRoad API responses
// ============================================================

interface FakeTrainerRoadActivity {
  Id: number;
  WorkoutName: string;
  CompletedDate: string;
  Duration: number;
  Tss: number;
  DistanceInMeters: number;
  IsOutside: boolean;
  ActivityType: string;
  IfFactor: number;
  NormalizedPower: number;
  AveragePower: number;
  MaxPower: number;
  AverageHeartRate: number;
  MaxHeartRate: number;
  AverageCadence: number;
  MaxCadence: number;
  Calories: number;
  ElevationGainInMeters: number;
  AverageSpeed: number;
  MaxSpeed: number;
}

function fakeActivity(overrides: Partial<FakeTrainerRoadActivity> = {}): FakeTrainerRoadActivity {
  return {
    Id: 5001,
    WorkoutName: "Baxter",
    CompletedDate: "2026-03-01T11:00:00Z",
    Duration: 3600,
    Tss: 45,
    DistanceInMeters: 30000,
    IsOutside: false,
    ActivityType: "Ride",
    IfFactor: 0.75,
    NormalizedPower: 180,
    AveragePower: 170,
    MaxPower: 250,
    AverageHeartRate: 140,
    MaxHeartRate: 165,
    AverageCadence: 85,
    MaxCadence: 110,
    Calories: 650,
    ElevationGainInMeters: 0,
    AverageSpeed: 8.33,
    MaxSpeed: 12.0,
    ...overrides,
  };
}

function trainerroadHandlers(activities: FakeTrainerRoadActivity[]) {
  return [
    // Activities API
    http.get("https://www.trainerroad.com/app/api/calendar/activities/:username", () => {
      return HttpResponse.json(activities);
    }),
  ];
}

const server = setupServer();

describe("TrainerRoadProvider.sync() (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestDatabase();
    server.listen({ onUnhandledRequest: failOnUnhandledExternalRequest });
    await ensureProvider(ctx.db, "trainerroad", "TrainerRoad", "https://www.trainerroad.com");
  }, 60_000);

  afterEach(() => {
    server.resetHandlers();
  });

  afterAll(async () => {
    server.close();
    if (ctx) await ctx.cleanup();
  });

  it("syncs activities into activity table", async () => {
    await saveTokens(ctx.db, "trainerroad", {
      accessToken: "valid-cookie",
      refreshToken: null,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "username:testuser",
    });

    const trActivities = [
      fakeActivity({ Id: 5001, WorkoutName: "Baxter", ActivityType: "Ride", IsOutside: false }),
      fakeActivity({
        Id: 5002,
        WorkoutName: "Morning Run",
        ActivityType: "Run",
        IsOutside: true,
        CompletedDate: "2026-03-05T08:00:00Z",
      }),
    ];

    server.use(...trainerroadHandlers(trActivities));

    const provider = new TrainerRoadProvider();
    const since = new Date("2026-02-01T00:00:00Z");
    const result = await provider.sync(ctx.db, since);

    expect(result.provider).toBe("trainerroad");
    expect(result.recordsSynced).toBe(2);
    expect(result.errors).toHaveLength(0);

    // Verify activity rows
    const rows = await ctx.db.select().from(activity).where(eq(activity.providerId, "trainerroad"));
    expect(rows).toHaveLength(2);

    const ride = rows.find((r) => r.externalId === "5001");
    if (!ride) throw new Error("expected activity 5001");
    expect(ride.activityType).toBe("virtual_cycling");
    expect(ride.name).toBe("Baxter");

    const run = rows.find((r) => r.externalId === "5002");
    if (!run) throw new Error("expected activity 5002");
    expect(run.activityType).toBe("running");
    expect(run.name).toBe("Morning Run");
  });

  it("upserts on re-sync (no duplicates)", async () => {
    await saveTokens(ctx.db, "trainerroad", {
      accessToken: "valid-cookie",
      refreshToken: null,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "username:testuser",
    });

    const trActivities = [fakeActivity({ Id: 5001, WorkoutName: "Baxter Updated" })];

    server.use(...trainerroadHandlers(trActivities));

    const provider = new TrainerRoadProvider();
    await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    // Sync again
    await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    const rows = await ctx.db.select().from(activity).where(eq(activity.providerId, "trainerroad"));
    const countOf5001 = rows.filter((r) => r.externalId === "5001").length;
    expect(countOf5001).toBe(1);

    // Verify it was updated
    const updated = rows.find((r) => r.externalId === "5001");
    expect(updated?.name).toBe("Baxter Updated");
  });

  it("returns error when cookie is expired", async () => {
    await saveTokens(ctx.db, "trainerroad", {
      accessToken: "expired-cookie",
      refreshToken: null,
      expiresAt: new Date("2025-01-01T00:00:00Z"), // expired
      scopes: "username:testuser",
    });

    const provider = new TrainerRoadProvider();
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain(
      "TrainerRoad session expired — please re-authenticate via Settings",
    );
    expect(result.recordsSynced).toBe(0);
  });

  it("returns error when no tokens exist", async () => {
    await ctx.db.delete(oauthToken).where(eq(oauthToken.providerId, "trainerroad"));

    const provider = new TrainerRoadProvider();
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("not connected");
    expect(result.recordsSynced).toBe(0);
  });

  it("returns error when username is missing from scopes", async () => {
    await saveTokens(ctx.db, "trainerroad", {
      accessToken: "valid-cookie",
      refreshToken: null,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: null, // no username encoded
    });

    const provider = new TrainerRoadProvider();
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("username not found");
    expect(result.recordsSynced).toBe(0);
  });

  it("maps activity types correctly", async () => {
    await saveTokens(ctx.db, "trainerroad", {
      accessToken: "valid-cookie",
      refreshToken: null,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "username:testuser",
    });

    const trActivities = [
      fakeActivity({ Id: 7001, ActivityType: "Ride", IsOutside: true }),
      fakeActivity({
        Id: 7002,
        ActivityType: "VirtualRide",
        IsOutside: false,
        CompletedDate: "2026-03-06T10:00:00Z",
      }),
      fakeActivity({
        Id: 7003,
        ActivityType: "Swim",
        IsOutside: true,
        CompletedDate: "2026-03-07T10:00:00Z",
      }),
    ];

    server.use(...trainerroadHandlers(trActivities));

    const provider = new TrainerRoadProvider();
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.errors).toHaveLength(0);

    const rows = await ctx.db.select().from(activity).where(eq(activity.providerId, "trainerroad"));

    const outdoorRide = rows.find((r) => r.externalId === "7001");
    expect(outdoorRide?.activityType).toBe("cycling");

    const virtualRide = rows.find((r) => r.externalId === "7002");
    expect(virtualRide?.activityType).toBe("virtual_cycling");

    const swim = rows.find((r) => r.externalId === "7003");
    expect(swim?.activityType).toBe("swimming");
  });
});
