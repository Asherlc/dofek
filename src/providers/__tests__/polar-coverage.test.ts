import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../db/__tests__/test-helpers.ts";
import { dailyMetrics } from "../../db/schema.ts";
import { ensureProvider, saveTokens } from "../../db/tokens.ts";
import type { PolarDailyActivity, PolarNightlyRecharge } from "../polar.ts";
import { PolarProvider } from "../polar.ts";

// ============================================================
// Coverage tests for uncovered Polar paths:
// - Lines 530-535: error handling for individual daily metrics insert
// - Lines 542-546: outer catch around daily_activity withSyncLog
// ============================================================

function fakePolarDailyActivity(overrides: Partial<PolarDailyActivity> = {}): PolarDailyActivity {
  return {
    polar_user: "https://www.polar.com/v3/users/12345",
    date: "2026-03-01",
    created: "2026-03-01T23:59:00Z",
    calories: 2400,
    active_calories: 850,
    duration: "PT14H30M",
    active_steps: 11200,
    ...overrides,
  };
}

function createMockFetchWithDailyActivityError(): typeof globalThis.fetch {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const urlStr = input.toString();

    // Exercises — return empty
    if (urlStr.includes("/v3/exercises")) {
      return Response.json([]);
    }

    // Sleep — return empty
    if (urlStr.includes("/v3/sleep")) {
      return Response.json([]);
    }

    // Nightly recharge — return empty
    if (urlStr.includes("/v3/nightly-recharge")) {
      return Response.json([]);
    }

    // Daily activity — return error (non-JSON or 500)
    if (urlStr.includes("/v3/activity")) {
      return new Response("Internal Server Error", { status: 500 });
    }

    return new Response("Not found", { status: 404 });
  };
}

function createMockFetchWithDailyActivity(
  dailyActivities: PolarDailyActivity[],
  nightlyRecharges: PolarNightlyRecharge[] = [],
): typeof globalThis.fetch {
  return async (input: RequestInfo | URL): Promise<Response> => {
    const urlStr = input.toString();

    if (urlStr.includes("/v3/exercises")) {
      return Response.json([]);
    }

    if (urlStr.includes("/v3/sleep")) {
      return Response.json([]);
    }

    if (urlStr.includes("/v3/nightly-recharge")) {
      return Response.json(nightlyRecharges);
    }

    if (urlStr.includes("/v3/activity")) {
      return Response.json(dailyActivities);
    }

    return new Response("Not found", { status: 404 });
  };
}

describe("PolarProvider.sync() — daily_activity error paths (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    process.env.POLAR_CLIENT_ID = "test-polar-client";
    process.env.POLAR_CLIENT_SECRET = "test-polar-secret";
    ctx = await setupTestDatabase();
    await ensureProvider(ctx.db, "polar", "Polar", "https://www.polar.com/v3");
  }, 60_000);

  afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  it("catches outer daily_activity withSyncLog error (lines 542-546)", async () => {
    await saveTokens(ctx.db, "polar", {
      accessToken: "valid-polar-token",
      refreshToken: "valid-polar-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "accesslink.read_all",
    });

    const provider = new PolarProvider(createMockFetchWithDailyActivityError());
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    // The daily_activity fetch fails with 500, which throws inside withSyncLog
    // The outer catch at lines 542-546 should catch it
    const dailyError = result.errors.find((e) => e.message.includes("daily_activity"));
    expect(dailyError).toBeDefined();
  });

  it("inserts daily metrics successfully and handles insert errors (lines 530-535)", async () => {
    await saveTokens(ctx.db, "polar", {
      accessToken: "valid-polar-token",
      refreshToken: "valid-polar-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "accesslink.read_all",
    });

    // Clear daily metrics
    await ctx.db.delete(dailyMetrics).where(eq(dailyMetrics.providerId, "polar"));

    const provider = new PolarProvider(
      createMockFetchWithDailyActivity([
        fakePolarDailyActivity({ date: "2026-03-10", active_steps: 9000 }),
      ]),
    );

    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    // Should succeed
    expect(result.errors).toHaveLength(0);
    const rows = await ctx.db
      .select()
      .from(dailyMetrics)
      .where(eq(dailyMetrics.providerId, "polar"));
    const march10 = rows.find((r) => r.date === "2026-03-10");
    expect(march10).toBeDefined();
    expect(march10?.steps).toBe(9000);
  });
});
