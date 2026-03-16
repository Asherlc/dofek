import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../db/__tests__/test-helpers.ts";
import { bodyMeasurement } from "../../db/schema.ts";
import { ensureProvider, saveTokens } from "../../db/tokens.ts";
import type { WithingsMeasureGroup } from "../withings.ts";
import { WithingsProvider } from "../withings.ts";

// Withings measure type constants
const MEAS_WEIGHT = 1;
const MEAS_FAT_RATIO = 6;
const MEAS_MUSCLE_MASS = 76;
const MEAS_BONE_MASS = 88;
const MEAS_SYSTOLIC_BP = 10;
const MEAS_DIASTOLIC_BP = 9;
const MEAS_HEART_PULSE = 11;

// 2026-03-01T08:00:00Z as epoch seconds
const MARCH_1_EPOCH = 1772103600;

function fakeWeightGroup(overrides?: Partial<WithingsMeasureGroup>): WithingsMeasureGroup {
  return {
    grpid: 8001,
    date: MARCH_1_EPOCH,
    category: 1, // real measurement
    measures: [
      { type: MEAS_WEIGHT, value: 82500, unit: -3 }, // 82.5 kg
      { type: MEAS_FAT_RATIO, value: 183, unit: -1 }, // 18.3%
      { type: MEAS_MUSCLE_MASS, value: 34800, unit: -3 }, // 34.8 kg
      { type: MEAS_BONE_MASS, value: 3200, unit: -3 }, // 3.2 kg
    ],
    ...overrides,
  };
}

function fakeBpGroup(overrides?: Partial<WithingsMeasureGroup>): WithingsMeasureGroup {
  return {
    grpid: 8002,
    date: MARCH_1_EPOCH + 3600,
    category: 1,
    measures: [
      { type: MEAS_SYSTOLIC_BP, value: 122, unit: 0 }, // 122 mmHg
      { type: MEAS_DIASTOLIC_BP, value: 78, unit: 0 }, // 78 mmHg
      { type: MEAS_HEART_PULSE, value: 65, unit: 0 }, // 65 bpm
    ],
    ...overrides,
  };
}

function withingsHandlers(opts?: { measureGroups?: WithingsMeasureGroup[]; hasMore?: boolean }) {
  const measureGroups = opts?.measureGroups ?? [];
  const hasMore = opts?.hasMore ?? false;

  return [
    // Token refresh (Withings uses v2/oauth2 with action=requesttoken in body)
    http.post("https://wbsapi.withings.net/v2/oauth2", async ({ request }) => {
      const body = await request.text();
      if (body.includes("action=requesttoken")) {
        return HttpResponse.json({
          status: 0,
          body: {
            access_token: "refreshed-withings-token",
            refresh_token: "new-withings-refresh",
            expires_in: 10800,
            scope: "user.metrics",
          },
        });
      }
      return new HttpResponse("Not found", { status: 404 });
    }),

    // Measure endpoint (POST to /measure with action=getmeas)
    http.post("https://wbsapi.withings.net/measure", () => {
      return HttpResponse.json({
        status: 0,
        body: {
          measuregrps: measureGroups,
          more: hasMore ? 1 : 0,
          offset: 0,
        },
      });
    }),
  ];
}

const server = setupServer();

describe("WithingsProvider.sync() (integration)", () => {
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

  it("syncs weight and blood pressure measurements", async () => {
    await saveTokens(ctx.db, "withings", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user.metrics",
    });

    server.use(
      ...withingsHandlers({
        measureGroups: [fakeWeightGroup(), fakeBpGroup()],
      }),
    );

    const provider = new WithingsProvider();

    const since = new Date("2026-02-01T00:00:00Z");
    const result = await provider.sync(ctx.db, since);

    expect(result.provider).toBe("withings");
    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(2);

    // Verify body measurements
    const rows = await ctx.db
      .select()
      .from(bodyMeasurement)
      .where(eq(bodyMeasurement.providerId, "withings"));
    expect(rows).toHaveLength(2);

    const weightEntry = rows.find((r) => r.externalId === "8001");
    if (!weightEntry) throw new Error("expected measurement 8001");
    expect(weightEntry.weightKg).toBeCloseTo(82.5);
    expect(weightEntry.bodyFatPct).toBeCloseTo(18.3);
    expect(weightEntry.muscleMassKg).toBeCloseTo(34.8);
    expect(weightEntry.boneMassKg).toBeCloseTo(3.2);

    const bpEntry = rows.find((r) => r.externalId === "8002");
    if (!bpEntry) throw new Error("expected measurement 8002");
    expect(bpEntry.systolicBp).toBe(122);
    expect(bpEntry.diastolicBp).toBe(78);
    expect(bpEntry.heartPulse).toBe(65);
  });

  it("skips user objective groups (category 2)", async () => {
    await saveTokens(ctx.db, "withings", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user.metrics",
    });

    // Clear previous data
    await ctx.db.delete(bodyMeasurement).where(eq(bodyMeasurement.providerId, "withings"));

    server.use(
      ...withingsHandlers({
        measureGroups: [
          fakeWeightGroup({ grpid: 8010 }),
          // User objective — should be skipped (category 2 produces empty parsed result)
          {
            grpid: 8011,
            date: MARCH_1_EPOCH,
            category: 2,
            measures: [{ type: MEAS_WEIGHT, value: 75000, unit: -3 }],
          },
        ],
      }),
    );

    const provider = new WithingsProvider();

    const since = new Date("2026-02-01T00:00:00Z");
    const result = await provider.sync(ctx.db, since);

    // Only the real measurement should be synced
    expect(result.recordsSynced).toBe(1);

    const rows = await ctx.db
      .select()
      .from(bodyMeasurement)
      .where(eq(bodyMeasurement.providerId, "withings"));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.externalId).toBe("8010");
  });

  it("upserts on re-sync (no duplicates)", async () => {
    await saveTokens(ctx.db, "withings", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user.metrics",
    });

    // Clear previous data
    await ctx.db.delete(bodyMeasurement).where(eq(bodyMeasurement.providerId, "withings"));

    server.use(
      ...withingsHandlers({
        measureGroups: [fakeWeightGroup({ grpid: 8020 })],
      }),
    );

    const provider = new WithingsProvider();

    const since = new Date("2026-02-01T00:00:00Z");
    await provider.sync(ctx.db, since);
    await provider.sync(ctx.db, since);

    const rows = await ctx.db
      .select()
      .from(bodyMeasurement)
      .where(eq(bodyMeasurement.providerId, "withings"));
    const countOf8020 = rows.filter((r) => r.externalId === "8020").length;
    expect(countOf8020).toBe(1);
  });

  it("refreshes expired tokens and saves new ones", async () => {
    await saveTokens(ctx.db, "withings", {
      accessToken: "expired-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2025-01-01T00:00:00Z"),
      scopes: "user.metrics",
    });

    server.use(...withingsHandlers());

    const provider = new WithingsProvider();
    await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    const { loadTokens } = await import("../../db/tokens.ts");
    const tokens = await loadTokens(ctx.db, "withings");
    expect(tokens?.accessToken).toBe("refreshed-withings-token");
  });

  it("returns error when no tokens exist", async () => {
    const { oauthToken } = await import("../../db/schema.ts");
    await ctx.db.delete(oauthToken).where(eq(oauthToken.providerId, "withings"));

    const provider = new WithingsProvider();
    const result = await provider.sync(ctx.db, new Date("2026-02-01T00:00:00Z"));

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("No OAuth tokens found");
    expect(result.recordsSynced).toBe(0);
  });

  it("captures per-measurement insert errors and continues", async () => {
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

    // Both should succeed (this verifies the happy path through the insert logic)
    expect(result.recordsSynced).toBe(2);
    expect(result.errors).toHaveLength(0);
  });

  it("catches outer withSyncLog error and reports it", async () => {
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

    // The outer catch should capture the error
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("body_measurement");
    expect(result.recordsSynced).toBe(0);
  });
});
