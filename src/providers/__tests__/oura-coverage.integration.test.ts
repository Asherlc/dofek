import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../db/__tests__/test-helpers.ts";
import { ensureProvider, saveTokens } from "../../db/tokens.ts";
import { OuraProvider } from "../oura.ts";

// ============================================================
// Integration tests for sync() error paths
// ============================================================

function ouraErrorHandlers(opts: { sleepError?: boolean }) {
  return [
    // Token refresh
    http.post("https://api.ouraring.com/oauth/token", () => {
      return HttpResponse.json({
        access_token: "refreshed-oura-token",
        refresh_token: "new-oura-refresh",
        expires_in: 86400,
        token_type: "Bearer",
      });
    }),

    // Sleep time (must come before sleep)
    http.get("https://api.ouraring.com/v2/usercollection/sleep_time", () => {
      return HttpResponse.json({ data: [], next_token: null });
    }),

    // Sleep — error or empty
    http.get("https://api.ouraring.com/v2/usercollection/sleep", () => {
      if (opts.sleepError) {
        return new HttpResponse("Rate Limited", { status: 429 });
      }
      return HttpResponse.json({ data: [], next_token: null });
    }),

    // All other endpoints — empty
    http.get("https://api.ouraring.com/v2/usercollection/daily_spo2", () => {
      return HttpResponse.json({ data: [], next_token: null });
    }),
    http.get("https://api.ouraring.com/v2/usercollection/daily_readiness", () => {
      return HttpResponse.json({ data: [], next_token: null });
    }),
    http.get("https://api.ouraring.com/v2/usercollection/daily_activity", () => {
      return HttpResponse.json({ data: [], next_token: null });
    }),
    http.get("https://api.ouraring.com/v2/usercollection/daily_stress", () => {
      return HttpResponse.json({ data: [], next_token: null });
    }),
    http.get("https://api.ouraring.com/v2/usercollection/daily_resilience", () => {
      return HttpResponse.json({ data: [], next_token: null });
    }),
    http.get("https://api.ouraring.com/v2/usercollection/daily_cardiovascular_age", () => {
      return HttpResponse.json({ data: [], next_token: null });
    }),
    http.get("https://api.ouraring.com/v2/usercollection/vO2_max", () => {
      return HttpResponse.json({ data: [], next_token: null });
    }),
    http.get("https://api.ouraring.com/v2/usercollection/workout", () => {
      return HttpResponse.json({ data: [], next_token: null });
    }),
    http.get("https://api.ouraring.com/v2/usercollection/heartrate", () => {
      return HttpResponse.json({ data: [] });
    }),
    http.get("https://api.ouraring.com/v2/usercollection/session", () => {
      return HttpResponse.json({ data: [], next_token: null });
    }),
    http.get("https://api.ouraring.com/v2/usercollection/enhanced_tag", () => {
      return HttpResponse.json({ data: [], next_token: null });
    }),
    http.get("https://api.ouraring.com/v2/usercollection/tag", () => {
      return HttpResponse.json({ data: [], next_token: null });
    }),
    http.get("https://api.ouraring.com/v2/usercollection/rest_mode_period", () => {
      return HttpResponse.json({ data: [], next_token: null });
    }),
  ];
}

const server = setupServer();

describe("OuraProvider.sync() — error paths (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    server.listen({ onUnhandledRequest: "error" });
    process.env.OURA_CLIENT_ID = "test-oura-client";
    process.env.OURA_CLIENT_SECRET = "test-oura-secret";
    ctx = await setupTestDatabase();
    await ensureProvider(ctx.db, "oura", "Oura", "https://api.ouraring.com");
  }, 60_000);

  afterEach(() => {
    server.resetHandlers();
  });

  afterAll(async () => {
    server.close();
    if (ctx) await ctx.cleanup();
  });

  it("captures sleep fetch errors", async () => {
    await saveTokens(ctx.db, "oura", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "daily heartrate personal session spo2",
    });

    const since = new Date();
    since.setDate(since.getDate() - 1);

    server.use(...ouraErrorHandlers({ sleepError: true }));

    const provider = new OuraProvider();
    const result = await provider.sync(ctx.db, since);

    const sleepError = result.errors.find((e) => e.message.includes("sleep"));
    expect(sleepError).toBeDefined();
  });
});
