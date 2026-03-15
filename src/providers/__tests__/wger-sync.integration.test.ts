import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../db/__tests__/test-helpers.ts";
import { activity, bodyMeasurement, oauthToken } from "../../db/schema.ts";
import { ensureProvider, saveTokens } from "../../db/tokens.ts";
import { WgerProvider } from "../wger.ts";

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

function createMockFetch(
  sessions: FakeWgerWorkoutSession[],
  weightEntries: FakeWgerWeightEntry[],
  opts?: { refreshError?: boolean },
): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
    const urlStr = input.toString();

    // Token refresh
    if (urlStr.includes("/api/v2/token")) {
      if (opts?.refreshError) {
        return new Response("Unauthorized", { status: 401 });
      }
      return Response.json({
        access_token: "refreshed-token",
        refresh_token: "new-refresh",
        expires_in: 7200,
        scope: "read",
        token_type: "Bearer",
      });
    }

    // Workout sessions list
    if (urlStr.includes("/workoutsession/")) {
      return Response.json({
        count: sessions.length,
        next: null,
        previous: null,
        results: sessions,
      });
    }

    // Weight entries list
    if (urlStr.includes("/weightentry/")) {
      return Response.json({
        count: weightEntries.length,
        next: null,
        previous: null,
        results: weightEntries,
      });
    }

    return new Response("Not found", { status: 404 });
  }) as typeof globalThis.fetch;
}

describe("WgerProvider.sync() (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    process.env.WGER_CLIENT_ID = "test-client-id";
    process.env.WGER_CLIENT_SECRET = "test-client-secret";
    ctx = await setupTestDatabase();
    await ensureProvider(ctx.db, "wger", "Wger", "https://wger.de/api/v2");
  }, 60_000);

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  it("syncs workout sessions into activity and weight entries into body_measurement", async () => {
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

    const provider = new WgerProvider(createMockFetch(sessions, weights));
    const since = new Date("2026-02-01T00:00:00Z");
    const result = await provider.sync(ctx.db, since);

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
    expect(session1.activityType).toBe("strength");
    expect(session1.name).toBe("Morning strength session");

    const session2 = activityRows.find((r) => r.externalId === "102");
    if (!session2) throw new Error("expected session 102");
    expect(session2.name).toBe("Leg day");

    // Verify body measurement rows
    const weightRows = await ctx.db
      .select()
      .from(bodyMeasurement)
      .where(eq(bodyMeasurement.providerId, "wger"));
    expect(weightRows).toHaveLength(2);

    const weight1 = weightRows.find((r) => r.externalId === "201");
    if (!weight1) throw new Error("expected weight 201");
    expect(weight1.weightKg).toBeCloseTo(82.5);

    const weight2 = weightRows.find((r) => r.externalId === "202");
    if (!weight2) throw new Error("expected weight 202");
    expect(weight2.weightKg).toBeCloseTo(82.0);
  });

  it("upserts on re-sync (no duplicates)", async () => {
    await saveTokens(ctx.db, "wger", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "read",
    });

    const sessions = [fakeWorkoutSession({ id: 101, date: "2026-03-01" })];
    const weights = [fakeWeightEntry({ id: 201, date: "2026-03-01", weight: "83.0" })];

    const provider = new WgerProvider(createMockFetch(sessions, weights));
    await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    // Sync again — should upsert, not duplicate
    await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    const activityRows = await ctx.db
      .select()
      .from(activity)
      .where(eq(activity.providerId, "wger"));
    const countOf101 = activityRows.filter((r) => r.externalId === "101").length;
    expect(countOf101).toBe(1);

    const weightRows = await ctx.db
      .select()
      .from(bodyMeasurement)
      .where(eq(bodyMeasurement.providerId, "wger"));
    const countOf201 = weightRows.filter((r) => r.externalId === "201").length;
    expect(countOf201).toBe(1);

    // Verify weight was updated
    const updatedWeight = weightRows.find((r) => r.externalId === "201");
    if (!updatedWeight) throw new Error("expected weight 201");
    expect(updatedWeight.weightKg).toBeCloseTo(83.0);
  });

  it("refreshes expired tokens and saves new ones", async () => {
    await saveTokens(ctx.db, "wger", {
      accessToken: "expired-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2025-01-01T00:00:00Z"), // expired
      scopes: "read",
    });

    const provider = new WgerProvider(createMockFetch([], []));
    await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    // Verify token was refreshed in DB
    const { loadTokens } = await import("../../db/tokens.ts");
    const tokens = await loadTokens(ctx.db, "wger");
    expect(tokens?.accessToken).toBe("refreshed-token");
  });

  it("handles pagination across multiple pages", async () => {
    await saveTokens(ctx.db, "wger", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "read",
    });

    let callCount = 0;
    const paginatedFetch = (async (
      input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> => {
      const urlStr = input.toString();

      if (urlStr.includes("/workoutsession/")) {
        callCount++;
        if (callCount === 1) {
          return Response.json({
            count: 2,
            next: "https://wger.de/api/v2/workoutsession/?format=json&ordering=-date&offset=50&limit=50",
            previous: null,
            results: [fakeWorkoutSession({ id: 301, date: "2026-03-10" })],
          });
        }
        return Response.json({
          count: 2,
          next: null,
          previous: null,
          results: [fakeWorkoutSession({ id: 302, date: "2026-03-08" })],
        });
      }

      if (urlStr.includes("/weightentry/")) {
        return Response.json({ count: 0, next: null, previous: null, results: [] });
      }

      return new Response("Not found", { status: 404 });
    }) as typeof globalThis.fetch;

    const provider = new WgerProvider(paginatedFetch);
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(2);
    expect(callCount).toBe(2);
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

    const provider = new WgerProvider(createMockFetch(sessions, []));
    const result = await provider.sync(ctx.db, new Date("2026-01-01T00:00:00Z"));

    // Only the first session should be synced
    expect(result.recordsSynced).toBe(1);
  });

  it("returns error when no tokens exist", async () => {
    await ctx.db.delete(oauthToken).where(eq(oauthToken.providerId, "wger"));

    const provider = new WgerProvider(createMockFetch([], []));
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("No OAuth tokens");
    expect(result.recordsSynced).toBe(0);
  });
});
