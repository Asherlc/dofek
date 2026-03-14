import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../db/__tests__/test-helpers.ts";
import { ensureProvider, saveTokens } from "../../db/tokens.ts";
import { OuraProvider } from "../oura.ts";

// ============================================================
// Integration tests for sync() error paths
// ============================================================

function createMockFetchForErrors(opts: {
  sleepError?: boolean;
  dailyError?: boolean;
}): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const urlStr = input.toString();

    // Token refresh
    if (urlStr.includes("/oauth/token")) {
      return Response.json({
        access_token: "refreshed-oura-token",
        refresh_token: "new-oura-refresh",
        expires_in: 86400,
        token_type: "Bearer",
      });
    }

    // Sleep — error or empty
    if (urlStr.includes("/v2/usercollection/sleep")) {
      if (opts.sleepError) {
        return new Response("Rate Limited", { status: 429 });
      }
      return Response.json({ data: [], next_token: null });
    }

    // Daily readiness — error or empty
    if (urlStr.includes("/v2/usercollection/daily_readiness")) {
      if (opts.dailyError) {
        return new Response("Server Error", { status: 500 });
      }
      return Response.json({ data: [], next_token: null });
    }

    // Daily activity — empty
    if (urlStr.includes("/v2/usercollection/daily_activity")) {
      return Response.json({ data: [], next_token: null });
    }

    // Daily SpO2 — empty
    if (urlStr.includes("/v2/usercollection/daily_spo2")) {
      return Response.json({ data: [], next_token: null });
    }

    // VO2 max — empty
    if (urlStr.includes("/v2/usercollection/vO2_max")) {
      return Response.json({ data: [], next_token: null });
    }

    return new Response("Not found", { status: 404 });
  }) as typeof globalThis.fetch;
}

describe("OuraProvider.sync() — error paths (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    process.env.OURA_CLIENT_ID = "test-oura-client";
    process.env.OURA_CLIENT_SECRET = "test-oura-secret";
    ctx = await setupTestDatabase();
    await ensureProvider(ctx.db, "oura", "Oura", "https://api.ouraring.com");
  }, 60_000);

  afterAll(async () => {
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

    const provider = new OuraProvider(createMockFetchForErrors({ sleepError: true }));
    const result = await provider.sync(ctx.db, since);

    const sleepError = result.errors.find((e) => e.message.includes("sleep"));
    expect(sleepError).toBeDefined();
  });

  it("captures daily metrics fetch errors", async () => {
    await saveTokens(ctx.db, "oura", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "daily heartrate personal session spo2",
    });

    const since = new Date();
    since.setDate(since.getDate() - 1);

    const provider = new OuraProvider(createMockFetchForErrors({ dailyError: true }));
    const result = await provider.sync(ctx.db, since);

    const dailyError = result.errors.find((e) => e.message.includes("daily_metrics"));
    expect(dailyError).toBeDefined();
  });
});
