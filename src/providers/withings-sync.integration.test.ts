import { eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { ensureProvider, saveTokens } from "../db/tokens.ts";
import { failOnUnhandledExternalRequest } from "../test/msw.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";
import { createCapturingMetricStreamPublisher } from "./test-helpers.ts";
import type { WithingsMeasureGroup } from "./withings.ts";
import { WithingsProvider } from "./withings.ts";

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
const metricStreamCapture = createCapturingMetricStreamPublisher();

describe("WithingsProvider.sync() (integration)", () => {
  let ctx: TestContext;

  beforeAll(async () => {
    process.env.WITHINGS_CLIENT_ID = "test-withings-client";
    process.env.WITHINGS_CLIENT_SECRET = "test-withings-secret";
    ctx = await setupTestDatabase();
    server.listen({ onUnhandledRequest: failOnUnhandledExternalRequest });
    await ensureProvider(ctx.db, "withings", "Withings", "https://wbsapi.withings.net");
  }, 60_000);

  beforeEach(() => {
    metricStreamCapture.publishedMetricStreamRows.length = 0;
  });

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
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: since }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    expect(result.provider).toBe("withings");
    expect(result.errors).toHaveLength(0);
    expect(result.recordsSynced).toBe(2);

    const rows = metricStreamCapture.publishedMetricStreamRows;
    expect(new Set(rows.map((row) => row.externalId))).toEqual(new Set(["8001", "8002"]));

    const weightEntry = rows.find(
      (row) => row.externalId === "8001" && row.channel === "body_weight",
    );
    if (!weightEntry) throw new Error("expected measurement 8001");
    expect(weightEntry.scalar).toBeCloseTo(82.5);
    expect(
      rows.find((row) => row.externalId === "8001" && row.channel === "body_fat_percentage")
        ?.scalar,
    ).toBeCloseTo(18.3);
    expect(
      rows.find((row) => row.externalId === "8001" && row.channel === "muscle_mass")?.scalar,
    ).toBeCloseTo(34.8);
    expect(
      rows.find((row) => row.externalId === "8001" && row.channel === "bone_mass")?.scalar,
    ).toBeCloseTo(3.2);

    const bpEntry = rows.find(
      (row) => row.externalId === "8002" && row.channel === "systolic_blood_pressure",
    );
    if (!bpEntry) throw new Error("expected measurement 8002");
    expect(bpEntry.scalar).toBe(122);
    expect(
      rows.find((row) => row.externalId === "8002" && row.channel === "diastolic_blood_pressure")
        ?.scalar,
    ).toBe(78);
    expect(
      rows.find((row) => row.externalId === "8002" && row.channel === "heart_pulse")?.scalar,
    ).toBe(65);
  });

  it("skips user objective groups (category 2)", async () => {
    await saveTokens(ctx.db, "withings", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user.metrics",
    });

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
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: since }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    // Only the real measurement should be synced
    expect(result.recordsSynced).toBe(1);

    const rows = metricStreamCapture.publishedMetricStreamRows;
    expect(new Set(rows.map((row) => row.externalId))).toEqual(new Set(["8010"]));
    expect(rows[0]?.externalId).toBe("8010");
  });

  it("publishes measurement events on each re-sync", async () => {
    await saveTokens(ctx.db, "withings", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user.metrics",
    });

    server.use(
      ...withingsHandlers({
        measureGroups: [fakeWeightGroup({ grpid: 8020 })],
      }),
    );

    const provider = new WithingsProvider();

    const since = new Date("2026-02-01T00:00:00Z");
    await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: since }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );
    await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: since }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    const rows = metricStreamCapture.publishedMetricStreamRows;
    const countOf8020 = rows.filter(
      (row) => row.externalId === "8020" && row.channel === "body_weight",
    ).length;
    expect(countOf8020).toBe(2);
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
    await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    const { loadTokens } = await import("../db/tokens.ts");
    const tokens = await loadTokens(ctx.db, "withings");
    expect(tokens?.accessToken).toBe("refreshed-withings-token");
  });

  it("returns error when no tokens exist", async () => {
    const { oauthToken } = await import("../db/schema/reference.ts");
    await ctx.db.delete(oauthToken).where(eq(oauthToken.providerId, "withings"));

    const provider = new WithingsProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toBe("Withings authentication failed.");
    expect(result.errors[0]?.cause).toMatchObject({ authFailureReason: "authentication_failed" });
    expect(result.recordsSynced).toBe(0);
  });

  it("captures per-measurement insert errors and continues", async () => {
    await saveTokens(ctx.db, "withings", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user.metrics",
    });

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
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    // Both should succeed (this verifies the happy path through the insert logic)
    expect(result.recordsSynced).toBe(2);
    expect(result.errors).toHaveLength(0);
  });

  it("catches outer withSyncLog error and reports non-auth API errors", async () => {
    await saveTokens(ctx.db, "withings", {
      accessToken: "valid-token",
      refreshToken: "valid-refresh",
      expiresAt: new Date("2027-01-01T00:00:00Z"),
      scopes: "user.metrics",
    });

    server.use(
      http.post("https://wbsapi.withings.net/measure", () => {
        return HttpResponse.json({
          status: 500, // Non-zero = Withings API error
          body: {},
        });
      }),
    );

    const provider = new WithingsProvider();
    const result = await provider.sync(
      new SyncRun({
        db: ctx.db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00Z") }),
        metricStreamPublisher: metricStreamCapture.publisher,
      }),
    );

    // The outer catch should capture the error
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toContain("metric_stream");
    expect(result.recordsSynced).toBe(0);
  });
});
