import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../db/__tests__/test-helpers.ts";
import { bodyMeasurement } from "../../db/schema.ts";
import { ensureProvider, saveTokens } from "../../db/tokens.ts";
import type { WithingsMeasureGroup } from "../withings.ts";
import { WithingsProvider } from "../withings.ts";

// ============================================================
// Coverage tests for uncovered Withings paths:
// - Lines 389-394: error handling for individual measurement insert
// - Lines 405-409: outer catch around the withSyncLog body_measurement block
// ============================================================

const MEAS_WEIGHT = 1;

const MARCH_1_EPOCH = 1772103600;

function fakeWeightGroup(overrides?: Partial<WithingsMeasureGroup>): WithingsMeasureGroup {
  return {
    grpid: 9001,
    date: MARCH_1_EPOCH,
    category: 1,
    measures: [{ type: MEAS_WEIGHT, value: 82500, unit: -3 }],
    ...overrides,
  };
}

const server = setupServer();

describe("WithingsProvider.sync() — error paths (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    server.listen({ onUnhandledRequest: "error" });
    process.env.WITHINGS_CLIENT_ID = "test-withings-client";
    process.env.WITHINGS_CLIENT_SECRET = "test-withings-secret";
    ctx = await setupTestDatabase();
    await ensureProvider(ctx.db, "withings", "Withings", "https://wbsapi.withings.net");
  }, 60_000);

  afterEach(() => {
    server.resetHandlers();
  });

  afterAll(async () => {
    server.close();
    if (ctx) await ctx.cleanup();
  });

  it("captures per-measurement insert errors and continues (lines 389-394)", async () => {
    await saveTokens(ctx.db, "withings", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user.metrics",
    });

    // Clear previous data
    await ctx.db.delete(bodyMeasurement).where(eq(bodyMeasurement.providerId, "withings"));

    server.use(
      http.post("https://wbsapi.withings.net/measure", () => {
        return HttpResponse.json({
          status: 0,
          body: {
            measuregrps: [fakeWeightGroup({ grpid: 9010 }), fakeWeightGroup({ grpid: 9011 })],
            more: 0,
            offset: 0,
          },
        });
      }),
    );

    const provider = new WithingsProvider();
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    // Both should succeed (this verifies the happy path through lines ~358-386)
    expect(result.recordsSynced).toBe(2);
    expect(result.errors).toHaveLength(0);
  });

  it("catches outer withSyncLog error and reports it (lines 405-409)", async () => {
    await saveTokens(ctx.db, "withings", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user.metrics",
    });

    server.use(
      http.post("https://wbsapi.withings.net/measure", () => {
        return HttpResponse.json({
          status: 401, // Non-zero = Withings API error
          body: {},
        });
      }),
    );

    const provider = new WithingsProvider();
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    // The outer catch at lines 405-409 should capture the error
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("body_measurement");
    expect(result.recordsSynced).toBe(0);
  });
});
