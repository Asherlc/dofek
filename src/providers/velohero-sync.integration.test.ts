import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activity, oauthToken } from "../db/schema.ts";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { ensureProvider, saveTokens } from "../db/tokens.ts";
import { VeloHeroProvider } from "./velohero.ts";

// ============================================================
// Fake VeloHero API responses
// ============================================================

interface FakeVeloHeroWorkout {
  id: string;
  date_ymd: string;
  start_time: string;
  dur_time: string;
  sport_id: string;
  dist_km: string;
  title?: string;
  ascent?: string;
  descent?: string;
  avg_hr?: string;
  max_hr?: string;
  avg_power?: string;
  max_power?: string;
  avg_cadence?: string;
  max_cadence?: string;
  calories?: string;
}

function fakeWorkout(overrides: Partial<FakeVeloHeroWorkout> = {}): FakeVeloHeroWorkout {
  return {
    id: "3001",
    date_ymd: "2026-03-01",
    start_time: "08:00:00",
    dur_time: "01:30:00",
    sport_id: "1", // cycling
    dist_km: "45.5",
    title: "Morning ride",
    ascent: "650",
    descent: "640",
    avg_hr: "145",
    max_hr: "172",
    avg_power: "210",
    max_power: "450",
    avg_cadence: "88",
    max_cadence: "115",
    calories: "950",
    ...overrides,
  };
}

function veloheroHandlers(workouts: FakeVeloHeroWorkout[]) {
  return [
    // Workouts export
    http.get("https://app.velohero.com/export/workouts/json", () => {
      return HttpResponse.json({
        workouts,
      });
    }),
  ];
}

const server = setupServer();

describe("VeloHeroProvider.sync() (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    ctx = await setupTestDatabase();
    server.listen({ onUnhandledRequest: "error" });
    await ensureProvider(ctx.db, "velohero", "VeloHero", "https://app.velohero.com");
  }, 60_000);

  afterEach(() => {
    server.resetHandlers();
  });

  afterAll(async () => {
    server.close();
    if (ctx) await ctx.cleanup();
  });

  it("syncs workouts into activity table", async () => {
    await saveTokens(ctx.db, "velohero", {
      accessToken: "VeloHero_session=valid-session",
      refreshToken: null,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "userId:user-456",
    });

    const workouts = [
      fakeWorkout({ id: "3001", title: "Morning ride", sport_id: "1" }),
      fakeWorkout({
        id: "3002",
        title: "Evening run",
        sport_id: "2",
        date_ymd: "2026-03-05",
        start_time: "18:00:00",
        dur_time: "00:45:00",
        dist_km: "8.5",
      }),
    ];

    server.use(...veloheroHandlers(workouts));

    const provider = new VeloHeroProvider();
    const since = new Date("2026-02-01T00:00:00Z");
    const result = await provider.sync(ctx.db, since);

    expect(result.provider).toBe("velohero");
    expect(result.recordsSynced).toBe(2);
    expect(result.errors).toHaveLength(0);

    // Verify activity rows
    const rows = await ctx.db.select().from(activity).where(eq(activity.providerId, "velohero"));
    expect(rows).toHaveLength(2);

    const ride = rows.find((r) => r.externalId === "3001");
    if (!ride) throw new Error("expected workout 3001");
    expect(ride.name).toBe("Morning ride");

    const run = rows.find((r) => r.externalId === "3002");
    if (!run) throw new Error("expected workout 3002");
    expect(run.name).toBe("Evening run");
  });

  it("upserts on re-sync (no duplicates)", async () => {
    await saveTokens(ctx.db, "velohero", {
      accessToken: "VeloHero_session=valid-session",
      refreshToken: null,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "userId:user-456",
    });

    const workouts = [fakeWorkout({ id: "3001", title: "Updated ride" })];

    server.use(...veloheroHandlers(workouts));

    const provider = new VeloHeroProvider();
    await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    // Sync again
    await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    const rows = await ctx.db.select().from(activity).where(eq(activity.providerId, "velohero"));
    const countOf3001 = rows.filter((r) => r.externalId === "3001").length;
    expect(countOf3001).toBe(1);

    // Verify it was updated
    const updated = rows.find((r) => r.externalId === "3001");
    expect(updated?.name).toBe("Updated ride");
  });

  it("returns error when session is expired", async () => {
    await saveTokens(ctx.db, "velohero", {
      accessToken: "VeloHero_session=expired-session",
      refreshToken: null,
      expiresAt: new Date("2025-01-01T00:00:00Z"), // expired
      scopes: "userId:user-456",
    });

    const provider = new VeloHeroProvider();
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain(
      "VeloHero session expired — please re-authenticate via Settings",
    );
    expect(result.recordsSynced).toBe(0);
  });

  it("returns error when no tokens exist", async () => {
    await ctx.db.delete(oauthToken).where(eq(oauthToken.providerId, "velohero"));

    const provider = new VeloHeroProvider();
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("not connected");
    expect(result.recordsSynced).toBe(0);
  });

  it("syncs empty workouts list without errors", async () => {
    // Re-create provider and tokens after previous test deleted them
    await ensureProvider(ctx.db, "velohero", "VeloHero", "https://app.velohero.com");
    await saveTokens(ctx.db, "velohero", {
      accessToken: "VeloHero_session=valid-session",
      refreshToken: null,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "userId:user-456",
    });

    server.use(...veloheroHandlers([]));

    const provider = new VeloHeroProvider();
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(0);
  });

  it("stores raw data from workouts", async () => {
    await saveTokens(ctx.db, "velohero", {
      accessToken: "VeloHero_session=valid-session",
      refreshToken: null,
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "userId:user-456",
    });

    const workouts = [
      fakeWorkout({
        id: "5001",
        avg_power: "215",
        max_power: "480",
        avg_hr: "148",
        ascent: "750",
        calories: "1100",
      }),
    ];

    server.use(...veloheroHandlers(workouts));

    const provider = new VeloHeroProvider();
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.errors).toHaveLength(0);

    const rows = await ctx.db.select().from(activity).where(eq(activity.externalId, "5001"));
    expect(rows).toHaveLength(1);

    const raw = rows[0]?.raw;
    if (raw === null || typeof raw !== "object") throw new Error("expected raw to be object");
    if ("avgPower" in raw) expect(raw.avgPower).toBe(215);
    if ("maxPower" in raw) expect(raw.maxPower).toBe(480);
    if ("avgHeartRate" in raw) expect(raw.avgHeartRate).toBe(148);
    if ("ascent" in raw) expect(raw.ascent).toBe(750);
    if ("calories" in raw) expect(raw.calories).toBe(1100);
  });
});
