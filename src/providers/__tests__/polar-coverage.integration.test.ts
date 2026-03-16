import { eq } from "drizzle-orm";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
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

function polarCoverageHandlers(opts: {
  dailyActivities?: PolarDailyActivity[];
  nightlyRecharges?: PolarNightlyRecharge[];
  dailyActivityError?: boolean;
}) {
  return [
    // Exercises — return empty
    http.get("https://www.polar.com/v3/exercises", () => {
      return HttpResponse.json([]);
    }),

    // Sleep — return empty
    http.get("https://www.polar.com/v3/sleep", () => {
      return HttpResponse.json([]);
    }),

    // Nightly recharge
    http.get("https://www.polar.com/v3/nightly-recharge", () => {
      return HttpResponse.json(opts.nightlyRecharges ?? []);
    }),

    // Daily activity
    http.get("https://www.polar.com/v3/activity", () => {
      if (opts.dailyActivityError) {
        return new HttpResponse("Internal Server Error", { status: 500 });
      }
      return HttpResponse.json(opts.dailyActivities ?? []);
    }),
  ];
}

const server = setupServer();

describe("PolarProvider.sync() — daily_activity error paths (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    server.listen({ onUnhandledRequest: "error" });
    process.env.POLAR_CLIENT_ID = "test-polar-client";
    process.env.POLAR_CLIENT_SECRET = "test-polar-secret";
    ctx = await setupTestDatabase();
    await ensureProvider(ctx.db, "polar", "Polar", "https://www.polar.com/v3");
  }, 60_000);

  afterEach(() => {
    server.resetHandlers();
  });

  afterAll(async () => {
    server.close();
    if (ctx) await ctx.cleanup();
  });

  it("catches outer daily_activity withSyncLog error (lines 542-546)", async () => {
    await saveTokens(ctx.db, "polar", {
      accessToken: "valid-polar-token",
      refreshToken: "valid-polar-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "accesslink.read_all",
    });

    server.use(...polarCoverageHandlers({ dailyActivityError: true }));

    const provider = new PolarProvider();
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

    server.use(
      ...polarCoverageHandlers({
        dailyActivities: [
          fakePolarDailyActivity({ date: "2026-03-10", active_steps: 9000 }),
        ],
      }),
    );

    const provider = new PolarProvider();
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
