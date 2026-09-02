import {
  ProviderRateLimitError,
  ProviderRequestTimeoutError,
} from "@dofek/provider-http/rate-limit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";

vi.mock("../db/provider-data-deletion.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/provider-data-deletion.ts")>();
  const { resolveProviderDataGenerationsForTest } = await import("./test-helpers.ts");
  return { ...actual, getProviderDataGenerations: resolveProviderDataGenerationsForTest };
});

vi.mock("../db/token-user-context.ts", () => ({
  getTokenUserId: () => "00000000-0000-0000-0000-000000000001",
  runWithTokenUser: async (_userId: string, callback: () => Promise<unknown>) => callback(),
}));

import { createProviderRateLimitFetch } from "../lib/provider-rate-limit-fetch.ts";
import { createMockDatabase } from "./test-helpers.ts";
import {
  exchangeWithingsCode,
  parseMeasureGroup,
  WithingsClient,
  type WithingsMeasureGroup,
  WithingsProvider,
} from "./withings.ts";

const { mockMetricStreamPublishRows, publishedMetricStreamBatches } = vi.hoisted<{
  mockMetricStreamPublishRows: CallableVitestMock;
  publishedMetricStreamBatches: Record<string, unknown>[][];
}>(() => ({
  mockMetricStreamPublishRows: vi.fn(),
  publishedMetricStreamBatches: [],
}));

vi.mock("../metric-stream/redpanda-producer.ts", () => ({
  getDefaultMetricStreamEventPublisher: async () => ({
    publishRows: mockMetricStreamPublishRows,
  }),
}));

// ============================================================
// Pure parsing unit tests
// ============================================================

// Withings returns values as (value * 10^unit), e.g. weight 72.5kg = value:72500, unit:-3

const scaleGroup: WithingsMeasureGroup = {
  grpid: 1001,
  date: 1709251200, // Unix seconds
  category: 1, // real measurement
  measures: [
    { type: 1, value: 72500, unit: -3 }, // weight 72.5 kg
    { type: 6, value: 215, unit: -1 }, // fat ratio 21.5%
    { type: 76, value: 31200, unit: -3 }, // muscle mass 31.2 kg
    { type: 88, value: 3100, unit: -3 }, // bone mass 3.1 kg
    { type: 77, value: 38500, unit: -3 }, // hydration 38.5 kg (water)
    { type: 5, value: 57300, unit: -3 }, // fat free mass 57.3 kg
    { type: 8, value: 15200, unit: -3 }, // fat mass weight 15.2 kg
  ],
};

const bpGroup: WithingsMeasureGroup = {
  grpid: 2001,
  date: 1709337600,
  category: 1,
  measures: [
    { type: 10, value: 120, unit: 0 }, // systolic 120 mmHg
    { type: 9, value: 80, unit: 0 }, // diastolic 80 mmHg
    { type: 11, value: 72, unit: 0 }, // heart pulse 72 bpm
  ],
};

const tempGroup: WithingsMeasureGroup = {
  grpid: 3001,
  date: 1709424000,
  category: 1,
  measures: [
    { type: 71, value: 3720, unit: -2 }, // body temp 37.20 C
  ],
};

describe("Withings Provider — parsing", () => {
  describe("parseMeasureGroup", () => {
    it("parses scale measurements", () => {
      const result = parseMeasureGroup(scaleGroup);
      expect(result.externalId).toBe("1001");
      expect(result.recordedAt).toEqual(new Date(1709251200 * 1000));
      expect(result.weightKg).toBeCloseTo(72.5);
      expect(result.bodyFatPct).toBeCloseTo(21.5);
      expect(result.muscleMassKg).toBeCloseTo(31.2);
      expect(result.boneMassKg).toBeCloseTo(3.1);
      expect(result.waterPct).toBeUndefined(); // hydration is in kg, not %
      expect(result.systolicBp).toBeUndefined();
    });

    it("parses blood pressure measurements", () => {
      const result = parseMeasureGroup(bpGroup);
      expect(result.systolicBp).toBe(120);
      expect(result.diastolicBp).toBe(80);
      expect(result.heartPulse).toBe(72);
      expect(result.weightKg).toBeUndefined();
    });

    it("parses temperature measurements", () => {
      const result = parseMeasureGroup(tempGroup);
      expect(result.temperatureC).toBeCloseTo(37.2);
      expect(result.weightKg).toBeUndefined();
    });

    it("skips user objectives (category 2)", () => {
      const objective = { ...scaleGroup, category: 2 };
      const result = parseMeasureGroup(objective);
      expect(result.weightKg).toBeUndefined();
    });

    it("computes BMI when weight is present", () => {
      // BMI needs height which comes from user profile, not from measure group
      // So parseMeasureGroup doesn't compute BMI itself
      const result = parseMeasureGroup(scaleGroup);
      expect(result.bmi).toBeUndefined();
    });
  });
});

// ============================================================
// Sync & integration tests (mock DB)
// ============================================================

function createMockDb(options: Parameters<typeof createMockDatabase>[0] = {}) {
  return createMockDatabase(options);
}

describe("WithingsProvider.sync() — unit tests", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    publishedMetricStreamBatches.length = 0;
    mockMetricStreamPublishRows.mockReset();
    mockMetricStreamPublishRows.mockImplementation(
      async (rows: readonly Record<string, unknown>[]) => {
        publishedMetricStreamBatches.push([...rows]);
        return rows.map((row, index) => ({
          version: 1,
          id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
          recordedAt:
            row.recordedAt instanceof Date ? row.recordedAt.toISOString() : row.recordedAt,
        }));
      },
    );
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns error when no tokens are stored", async () => {
    process.env.WITHINGS_CLIENT_ID = "test-id";
    process.env.WITHINGS_CLIENT_SECRET = "test-secret";

    const { db: mockDb } = createMockDb();
    const provider = new WithingsProvider();

    const result = await provider.sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );
    expect(result.provider).toBe("withings");
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.message).toBe("Withings authentication failed.");
    expect(result.errors[0]?.cause).toMatchObject({ authFailureReason: "authentication_failed" });
  });

  it("syncs measurements successfully with valid tokens", async () => {
    process.env.WITHINGS_CLIENT_ID = "test-id";
    process.env.WITHINGS_CLIENT_SECRET = "test-secret";

    const futureDate = new Date("2099-01-01");
    const { db: mockDb } = createMockDb({
      tokensResult: [
        {
          providerId: "withings",
          accessToken: "valid-token",
          refreshToken: "valid-refresh",
          expiresAt: futureDate,
          scopes: "user.metrics",
        },
      ],
    });

    const mockFetch: typeof globalThis.fetch = async (
      input: RequestInfo | URL,
      _init?: RequestInit,
    ): Promise<Response> => {
      const url = input.toString();
      if (url.includes("/measure")) {
        return Response.json({
          status: 0,
          body: {
            measuregrps: [
              {
                grpid: 1001,
                date: 1709251200,
                category: 1,
                measures: [{ type: 1, value: 72500, unit: -3 }],
              },
            ],
            more: 0,
            offset: 0,
          },
        });
      }
      return new Response("Not found", { status: 404 });
    };

    const provider = new WithingsProvider(mockFetch);
    const result = await provider.sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );
    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(publishedMetricStreamBatches.flat()).toContainEqual(
      expect.objectContaining({
        providerId: "withings",
        externalId: "1001",
        channel: "body_weight",
        scalar: 72.5,
      }),
    );
  });

  it("handles pagination when more > 0", async () => {
    process.env.WITHINGS_CLIENT_ID = "test-id";
    process.env.WITHINGS_CLIENT_SECRET = "test-secret";

    const futureDate = new Date("2099-01-01");
    const { db: mockDb } = createMockDb({
      tokensResult: [
        {
          providerId: "withings",
          accessToken: "valid-token",
          refreshToken: "valid-refresh",
          expiresAt: futureDate,
          scopes: "user.metrics",
        },
      ],
    });

    let callCount = 0;
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      callCount++;
      if (callCount === 1) {
        return Response.json({
          status: 0,
          body: {
            measuregrps: [
              {
                grpid: 1001,
                date: 1709251200,
                category: 1,
                measures: [{ type: 1, value: 72500, unit: -3 }],
              },
            ],
            more: 1,
            offset: 50,
          },
        });
      }
      return Response.json({
        status: 0,
        body: {
          measuregrps: [
            {
              grpid: 1002,
              date: 1709337600,
              category: 1,
              measures: [{ type: 10, value: 120, unit: 0 }],
            },
          ],
          more: 0,
          offset: 0,
        },
      });
    };

    const provider = new WithingsProvider(mockFetch);
    const result = await provider.sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );
    expect(result.recordsSynced).toBe(2);
    expect(callCount).toBe(2);
  });

  it("retains measurements when pagination stalls on a repeated offset", async () => {
    process.env.WITHINGS_CLIENT_ID = "test-id";
    process.env.WITHINGS_CLIENT_SECRET = "test-secret";

    const futureDate = new Date("2099-01-01");
    const { db: mockDb } = createMockDb({
      tokensResult: [
        {
          providerId: "withings",
          accessToken: "valid-token",
          refreshToken: "valid-refresh",
          expiresAt: futureDate,
          scopes: "user.metrics",
        },
      ],
    });

    let callCount = 0;
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      callCount += 1;
      return Response.json({
        status: 0,
        body: {
          measuregrps: [
            {
              grpid: 1000 + callCount,
              date: 1709251200 + callCount,
              category: 1,
              measures: [{ type: 1, value: 72000 + callCount, unit: -3 }],
            },
          ],
          more: 1,
          offset: 50,
        },
      });
    };

    const provider = new WithingsProvider(mockFetch);
    const result = await provider.sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );

    expect(result.errors).toHaveLength(0);
    expect(callCount).toBe(2);
    expect(result.recordsSynced).toBe(2);
    expect(publishedMetricStreamBatches.flat()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ externalId: "1001", scalar: 72.001 }),
        expect.objectContaining({ externalId: "1002", scalar: 72.002 }),
      ]),
    );
  });

  it("retains measurements from earlier pages when a later page fetch fails", async () => {
    process.env.WITHINGS_CLIENT_ID = "test-id";
    process.env.WITHINGS_CLIENT_SECRET = "test-secret";

    const futureDate = new Date("2099-01-01");
    const { db: mockDb } = createMockDb({
      tokensResult: [
        {
          providerId: "withings",
          accessToken: "valid-token",
          refreshToken: "valid-refresh",
          expiresAt: futureDate,
          scopes: "user.metrics",
        },
      ],
    });

    let measureCallCount = 0;
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      measureCallCount += 1;
      if (measureCallCount === 1) {
        return Response.json({
          status: 0,
          body: {
            measuregrps: [
              {
                grpid: 1001,
                date: 1709251200,
                category: 1,
                measures: [{ type: 1, value: 72500, unit: -3 }],
              },
            ],
            more: 1,
            offset: 50,
          },
        });
      }
      return Response.json({ status: 500, body: {} });
    };

    const provider = new WithingsProvider(mockFetch);
    const result = await provider.sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );

    expect(measureCallCount).toBe(2);
    expect(result.recordsSynced).toBe(1);
    expect(publishedMetricStreamBatches.flat()).toContainEqual(
      expect.objectContaining({
        providerId: "withings",
        externalId: "1001",
        channel: "body_weight",
      }),
    );
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.message).toContain("metric_stream");
  });

  it("skips empty groups (objectives or unknown types)", async () => {
    process.env.WITHINGS_CLIENT_ID = "test-id";
    process.env.WITHINGS_CLIENT_SECRET = "test-secret";

    const futureDate = new Date("2099-01-01");
    const { db: mockDb } = createMockDb({
      tokensResult: [
        {
          providerId: "withings",
          accessToken: "valid-token",
          refreshToken: "valid-refresh",
          expiresAt: futureDate,
          scopes: "user.metrics",
        },
      ],
    });

    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return Response.json({
        status: 0,
        body: {
          measuregrps: [
            {
              grpid: 2001,
              date: 1709251200,
              category: 2, // user objective — will be skipped in parsing
              measures: [{ type: 1, value: 72500, unit: -3 }],
            },
            {
              grpid: 2002,
              date: 1709251200,
              category: 1,
              measures: [{ type: 999, value: 100, unit: 0 }], // unknown type
            },
          ],
          more: 0,
          offset: 0,
        },
      });
    };

    const provider = new WithingsProvider(mockFetch);
    const result = await provider.sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );
    expect(result.recordsSynced).toBe(0);
  });

  it("captures per-measurement insert errors", async () => {
    process.env.WITHINGS_CLIENT_ID = "test-id";
    process.env.WITHINGS_CLIENT_SECRET = "test-secret";

    const futureDate = new Date("2099-01-01");
    const { db: mockDb } = createMockDb({
      tokensResult: [
        {
          providerId: "withings",
          accessToken: "valid-token",
          refreshToken: "valid-refresh",
          expiresAt: futureDate,
          scopes: "user.metrics",
        },
      ],
    });
    mockMetricStreamPublishRows.mockRejectedValueOnce(new Error("Redpanda publish failed"));

    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return Response.json({
        status: 0,
        body: {
          measuregrps: [
            {
              grpid: 3001,
              date: 1709251200,
              category: 1,
              measures: [{ type: 1, value: 72500, unit: -3 }],
            },
          ],
          more: 0,
          offset: 0,
        },
      });
    };

    const provider = new WithingsProvider(mockFetch);
    const result = await provider.sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );
    expect(result.recordsSynced).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.message).toContain("Redpanda publish failed");
  });

  it("catches non-auth API error in outer withSyncLog catch", async () => {
    process.env.WITHINGS_CLIENT_ID = "test-id";
    process.env.WITHINGS_CLIENT_SECRET = "test-secret";

    const futureDate = new Date("2099-01-01");
    const { db: mockDb } = createMockDb({
      tokensResult: [
        {
          providerId: "withings",
          accessToken: "valid-token",
          refreshToken: "valid-refresh",
          expiresAt: futureDate,
          scopes: "user.metrics",
        },
      ],
    });

    let refreshCallCount = 0;
    const mockFetch: typeof globalThis.fetch = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = input.toString();
      const body = String(init?.body ?? "");

      if (url.includes("/v2/oauth2") && body.includes("grant_type=refresh_token")) {
        refreshCallCount++;
        return Response.json({
          status: 0,
          body: {
            access_token: "refreshed-access-token",
            refresh_token: "new-refresh-token",
            expires_in: 10800,
            scope: "user.metrics",
          },
        });
      }

      return Response.json({ status: 500, body: {} });
    };

    const provider = new WithingsProvider(mockFetch);
    const result = await provider.sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );
    expect(refreshCallCount).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.message).toContain("metric_stream");
  });

  it("refreshes and retries once when Withings rejects an unexpired access token", async () => {
    process.env.WITHINGS_CLIENT_ID = "test-id";
    process.env.WITHINGS_CLIENT_SECRET = "test-secret";

    const { db: mockDb } = createMockDb({
      tokensResult: [
        {
          providerId: "withings",
          accessToken: "stale-access-token",
          refreshToken: "valid-refresh",
          expiresAt: new Date("2099-01-01"),
          scopes: "user.metrics",
        },
      ],
    });

    let measureCallCount = 0;
    let refreshCallCount = 0;
    let retriedAuthorization: string | null = null;
    const mockFetch: typeof globalThis.fetch = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = input.toString();
      const body = String(init?.body ?? "");

      if (url.includes("/measure")) {
        measureCallCount++;
        const headers = new Headers(init?.headers);
        if (measureCallCount === 1) {
          expect(headers.get("Authorization")).toBe("Bearer stale-access-token");
          return Response.json({ status: 401, body: {} });
        }

        retriedAuthorization = headers.get("Authorization");
        return Response.json({
          status: 0,
          body: {
            measuregrps: [
              {
                grpid: 5001,
                date: 1709251200,
                category: 1,
                measures: [{ type: 1, value: 72500, unit: -3 }],
              },
            ],
            more: 0,
            offset: 0,
          },
        });
      }

      if (url.includes("/v2/oauth2") && body.includes("grant_type=refresh_token")) {
        refreshCallCount++;
        return Response.json({
          status: 0,
          body: {
            access_token: "refreshed-access-token",
            refresh_token: "new-refresh-token",
            expires_in: 10800,
            scope: "user.metrics",
          },
        });
      }

      return new Response("Not found", { status: 404 });
    };

    const provider = new WithingsProvider(mockFetch);
    const result = await provider.sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );

    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toHaveLength(0);
    expect(refreshCallCount).toBe(1);
    expect(measureCallCount).toBe(2);
    expect(retriedAuthorization).toBe("Bearer refreshed-access-token");
  });

  it("refreshes only once when Withings keeps rejecting the access token", async () => {
    process.env.WITHINGS_CLIENT_ID = "test-id";
    process.env.WITHINGS_CLIENT_SECRET = "test-secret";

    const { db: mockDb } = createMockDb({
      tokensResult: [
        {
          providerId: "withings",
          accessToken: "stale-access-token",
          refreshToken: "valid-refresh",
          expiresAt: new Date("2099-01-01"),
          scopes: "user.metrics",
        },
      ],
    });

    let measureCallCount = 0;
    let refreshCallCount = 0;
    const mockFetch: typeof globalThis.fetch = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = input.toString();
      const body = String(init?.body ?? "");

      if (url.includes("/measure")) {
        measureCallCount++;
        return Response.json({ status: 401, body: {} });
      }

      if (url.includes("/v2/oauth2") && body.includes("grant_type=refresh_token")) {
        refreshCallCount++;
        return Response.json({
          status: 0,
          body: {
            access_token: "refreshed-access-token",
            refresh_token: "new-refresh-token",
            expires_in: 10800,
            scope: "user.metrics",
          },
        });
      }

      return new Response("Not found", { status: 404 });
    };

    const provider = new WithingsProvider(mockFetch);
    const result = await provider.sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );

    expect(result.recordsSynced).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.message).toContain("metric_stream");
    expect(refreshCallCount).toBe(1);
    expect(measureCallCount).toBe(2);
  });

  it("refreshes expired token during resolveTokens", async () => {
    process.env.WITHINGS_CLIENT_ID = "test-id";
    process.env.WITHINGS_CLIENT_SECRET = "test-secret";

    const expiredDate = new Date("2020-01-01");
    let tokenCallMade = false;

    const { db: mockDb } = createMockDb({
      tokensResult: [
        {
          providerId: "withings",
          accessToken: "expired-token",
          refreshToken: "valid-refresh",
          expiresAt: expiredDate,
          scopes: "user.metrics",
        },
      ],
    });

    const mockFetch: typeof globalThis.fetch = async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = input.toString();
      const body = String(init?.body ?? "");

      // Token refresh request
      if (url.includes("/v2/oauth2") && body.includes("grant_type=refresh_token")) {
        tokenCallMade = true;
        return Response.json({
          status: 0,
          body: {
            access_token: "new-access-token",
            refresh_token: "new-refresh-token",
            expires_in: 10800,
            scope: "user.metrics",
          },
        });
      }

      // After refresh, the measurement call
      if (url.includes("/measure")) {
        return Response.json({
          status: 0,
          body: { measuregrps: [], more: 0, offset: 0 },
        });
      }

      return new Response("Not found", { status: 404 });
    };

    const provider = new WithingsProvider(mockFetch);
    const result = await provider.sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );
    expect(tokenCallMade).toBe(true);
    expect(result.provider).toBe("withings");
  });

  it("refreshes token when expiresAt equals current time", async () => {
    vi.useFakeTimers({ now: new Date("2026-06-17T12:00:00.000Z"), toFake: ["Date"] });
    try {
      process.env.WITHINGS_CLIENT_ID = "test-id";
      process.env.WITHINGS_CLIENT_SECRET = "test-secret";

      const expiryAtNow = new Date("2026-06-17T12:00:00.000Z");
      let tokenCallMade = false;

      const { db: mockDb } = createMockDb({
        tokensResult: [
          {
            providerId: "withings",
            accessToken: "expired-token",
            refreshToken: "valid-refresh",
            expiresAt: expiryAtNow,
            scopes: "user.metrics",
          },
        ],
      });

      const mockFetch: typeof globalThis.fetch = async (
        input: RequestInfo | URL,
        init?: RequestInit,
      ): Promise<Response> => {
        const url = input.toString();
        const body = String(init?.body ?? "");

        if (url.includes("/v2/oauth2") && body.includes("grant_type=refresh_token")) {
          tokenCallMade = true;
          return Response.json({
            status: 0,
            body: {
              access_token: "new-access-token",
              refresh_token: "new-refresh-token",
              expires_in: 10800,
              scope: "user.metrics",
            },
          });
        }

        if (url.includes("/measure")) {
          return Response.json({
            status: 0,
            body: { measuregrps: [], more: 0, offset: 0 },
          });
        }

        return new Response("Not found", { status: 404 });
      };

      const provider = new WithingsProvider(mockFetch);
      await provider.sync(
        new SyncRun({
          db: mockDb,
          window: SyncWindow.fromSince({ since: new Date("2026-01-01") }),
        }),
      );
      expect(tokenCallMade).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("deletes stored tokens and asks the user to reconnect when Withings rejects refresh params", async () => {
    process.env.WITHINGS_CLIENT_ID = "test-id";
    process.env.WITHINGS_CLIENT_SECRET = "test-secret";

    const { db: mockDb, spies } = createMockDb({
      tokensResult: [
        {
          providerId: "withings",
          accessToken: "expired-token",
          refreshToken: "stale-refresh",
          expiresAt: new Date("2020-01-01"),
          scopes: "user.metrics",
        },
      ],
    });

    const mockFetch: typeof globalThis.fetch = async () =>
      Response.json({ status: 503, error: "Invalid Params: invalid refresh token", body: {} });

    const provider = new WithingsProvider(mockFetch);
    const result = await provider.sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );

    expect(spies.deleteFn).toHaveBeenCalledOnce();
    expect(spies.deleteWhere).toHaveBeenCalledOnce();
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toBe("Withings refresh token was revoked or expired.");
    expect(result.errors[0]?.cause).toMatchObject({ authFailureReason: "refresh_token_revoked" });
  });

  it("returns error when expired token has no refresh token", async () => {
    process.env.WITHINGS_CLIENT_ID = "test-id";
    process.env.WITHINGS_CLIENT_SECRET = "test-secret";

    const { db: mockDb } = createMockDb({
      tokensResult: [
        {
          providerId: "withings",
          accessToken: "expired-token",
          refreshToken: null,
          expiresAt: new Date("2020-01-01"),
          scopes: "user.metrics",
        },
      ],
    });

    const provider = new WithingsProvider();
    const result = await provider.sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.message).toContain("No refresh token");
  });

  it("returns error when refresh config is missing", async () => {
    delete process.env.WITHINGS_CLIENT_ID;
    delete process.env.WITHINGS_CLIENT_SECRET;

    const { db: mockDb } = createMockDb({
      tokensResult: [
        {
          providerId: "withings",
          accessToken: "expired-token",
          refreshToken: "some-refresh",
          expiresAt: new Date("2020-01-01"),
          scopes: "user.metrics",
        },
      ],
    });

    const provider = new WithingsProvider();
    const result = await provider.sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.message).toContain("WITHINGS_CLIENT_ID");
  });
});

describe("WithingsProvider.sync() — temperature measurement", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("syncs temperature measurements", async () => {
    process.env.WITHINGS_CLIENT_ID = "test-id";
    process.env.WITHINGS_CLIENT_SECRET = "test-secret";

    const futureDate = new Date("2099-01-01");
    const { db: mockDb } = createMockDb({
      tokensResult: [
        {
          providerId: "withings",
          accessToken: "valid-token",
          refreshToken: "valid-refresh",
          expiresAt: futureDate,
          scopes: "user.metrics",
        },
      ],
    });

    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return Response.json({
        status: 0,
        body: {
          measuregrps: [
            {
              grpid: 4001,
              date: 1709424000,
              category: 1,
              measures: [{ type: 71, value: 3720, unit: -2 }],
            },
          ],
          more: 0,
          offset: 0,
        },
      });
    };

    const provider = new WithingsProvider(mockFetch);
    const result = await provider.sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
    );
    expect(result.recordsSynced).toBe(1);
  });
});

// ============================================================
// Webhook method tests
// ============================================================

describe("WithingsProvider webhook methods", () => {
  const provider = new WithingsProvider();

  describe("registerWebhook", () => {
    it("returns withings-user-subscription as subscriptionId", async () => {
      const result = await provider.registerWebhook("https://example.com/webhook", "verify-token");
      expect(result.subscriptionId).toBe("withings-user-subscription");
    });

    it("does not return a signingSecret or expiresAt", async () => {
      const result = await provider.registerWebhook("https://example.com/webhook", "verify-token");
      expect(result.signingSecret).toBeUndefined();
      expect(result.expiresAt).toBeUndefined();
    });
  });

  describe("verifyWebhookSignature", () => {
    it("returns true with valid-looking inputs", () => {
      const result = provider.verifyWebhookSignature(
        Buffer.from("some body"),
        { "x-signature": "abc123" },
        "secret",
      );
      expect(result).toBe(true);
    });

    it("returns true with empty inputs", () => {
      const result = provider.verifyWebhookSignature(Buffer.from(""), {}, "");
      expect(result).toBe(true);
    });

    it("returns true regardless of header values", () => {
      const result = provider.verifyWebhookSignature(
        Buffer.from("anything"),
        { "x-withings-signature": "wrong" },
        "any-secret",
      );
      expect(result).toBe(true);
    });
  });

  describe("parseWebhookPayload", () => {
    it("maps appli 1 to weight", () => {
      const events = provider.parseWebhookPayload({ userid: "12345", appli: 1 });
      expect(events).toHaveLength(1);
      expect(events[0]?.objectType).toBe("weight");
    });

    it("maps appli 4 to blood_pressure", () => {
      const events = provider.parseWebhookPayload({ userid: "12345", appli: 4 });
      expect(events).toHaveLength(1);
      expect(events[0]?.objectType).toBe("blood_pressure");
    });

    it("maps appli 16 to activity", () => {
      const events = provider.parseWebhookPayload({ userid: "12345", appli: 16 });
      expect(events).toHaveLength(1);
      expect(events[0]?.objectType).toBe("activity");
    });

    it("maps appli 44 to sleep", () => {
      const events = provider.parseWebhookPayload({ userid: "12345", appli: 44 });
      expect(events).toHaveLength(1);
      expect(events[0]?.objectType).toBe("sleep");
    });

    it("maps appli 54 to spo2", () => {
      const events = provider.parseWebhookPayload({ userid: "12345", appli: 54 });
      expect(events).toHaveLength(1);
      expect(events[0]?.objectType).toBe("spo2");
    });

    it("maps unknown appli code to unknown", () => {
      const events = provider.parseWebhookPayload({ userid: "12345", appli: 999 });
      expect(events).toHaveLength(1);
      expect(events[0]?.objectType).toBe("unknown");
    });

    it("maps missing appli to unknown", () => {
      const events = provider.parseWebhookPayload({ userid: "12345" });
      expect(events).toHaveLength(1);
      expect(events[0]?.objectType).toBe("unknown");
    });

    it("sets ownerExternalId from userid", () => {
      const events = provider.parseWebhookPayload({ userid: "67890", appli: 1 });
      expect(events).toHaveLength(1);
      expect(events[0]?.ownerExternalId).toBe("67890");
    });

    it("coerces numeric userid to string", () => {
      const events = provider.parseWebhookPayload({ userid: 99999, appli: 1 });
      expect(events).toHaveLength(1);
      expect(events[0]?.ownerExternalId).toBe("99999");
    });

    it("sets eventType to update for all valid payloads", () => {
      const events = provider.parseWebhookPayload({ userid: "12345", appli: 1 });
      expect(events).toHaveLength(1);
      expect(events[0]?.eventType).toBe("update");
    });

    it("returns empty array for non-object data", () => {
      const events = provider.parseWebhookPayload(42);
      expect(events).toEqual([]);
    });

    it("returns empty array for null input", () => {
      const events = provider.parseWebhookPayload(null);
      expect(events).toEqual([]);
    });

    it("returns empty array for undefined input", () => {
      const events = provider.parseWebhookPayload(undefined);
      expect(events).toEqual([]);
    });

    it("returns empty array for string input", () => {
      const events = provider.parseWebhookPayload("not-an-object");
      expect(events).toEqual([]);
    });

    it("includes startdate and enddate without affecting output structure", () => {
      const events = provider.parseWebhookPayload({
        userid: "12345",
        appli: 1,
        startdate: 1700000000,
        enddate: 1700086400,
      });
      expect(events).toHaveLength(1);
      expect(events[0]?.ownerExternalId).toBe("12345");
      expect(events[0]?.objectType).toBe("weight");
      expect(events[0]?.eventType).toBe("update");
    });
  });

  describe("authSetup", () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
      process.env = { ...originalEnv };
    });

    it("returns exchangeCode as a callable function", () => {
      process.env.WITHINGS_CLIENT_ID = "test-id";
      process.env.WITHINGS_CLIENT_SECRET = "test-secret";

      const setup = provider.authSetup();
      expect(typeof setup.exchangeCode).toBe("function");
    });

    it("exchangeCode returns a promise (not undefined)", () => {
      process.env.WITHINGS_CLIENT_ID = "test-id";
      process.env.WITHINGS_CLIENT_SECRET = "test-secret";

      const setup = provider.authSetup();
      // Calling exchangeCode should return a promise, not undefined
      const { exchangeCode } = setup;
      if (!exchangeCode) throw new Error("exchangeCode not defined");
      const result = exchangeCode("test-code");
      expect(result).toBeInstanceOf(Promise);
      // Catch the rejection since there's no real server
      result.catch((_error: unknown) => {});
    });

    it("returns apiBaseUrl as the Withings API base", () => {
      process.env.WITHINGS_CLIENT_ID = "test-id";
      process.env.WITHINGS_CLIENT_SECRET = "test-secret";

      const setup = provider.authSetup();
      expect(setup.apiBaseUrl).toBe("https://wbsapi.withings.net");
    });

    it("throws when env vars are missing", () => {
      delete process.env.WITHINGS_CLIENT_ID;
      delete process.env.WITHINGS_CLIENT_SECRET;

      expect(() => provider.authSetup()).toThrow(
        "WITHINGS_CLIENT_ID and WITHINGS_CLIENT_SECRET are required",
      );
    });
  });

  describe("provider identity", () => {
    it("has id 'withings'", () => {
      expect(provider.id).toBe("withings");
    });

    it("has name 'Withings'", () => {
      expect(provider.name).toBe("Withings");
    });

    it("has webhookScope 'user'", () => {
      expect(provider.webhookScope).toBe("user");
    });
  });
});

describe("exchangeWithingsCode — scope handling", () => {
  it("captures the stable Withings userid from the token response", async () => {
    const mockFetch: typeof globalThis.fetch = async () =>
      Response.json({
        status: 0,
        body: {
          access_token: "access",
          expires_in: 3600,
          refresh_token: "refresh",
          scope: "user.metrics",
          userid: 489418,
        },
      });
    const config = {
      clientId: "test-id",
      clientSecret: "test-secret",
      authorizeUrl: "",
      tokenUrl: "https://wbsapi.withings.net/v2/oauth2",
      redirectUri: "",
      scopes: [],
    };

    await expect(exchangeWithingsCode(config, "code", mockFetch)).resolves.toEqual(
      expect.objectContaining({ providerAccountId: "489418" }),
    );
  });

  it("does not treat an empty Withings userid as a provider account", async () => {
    const mockFetch: typeof globalThis.fetch = async () =>
      Response.json({
        status: 0,
        body: {
          access_token: "access",
          refresh_token: "refresh",
          userid: "",
        },
      });
    const config = {
      clientId: "test-id",
      clientSecret: "test-secret",
      authorizeUrl: "https://account.withings.com/authorize",
      tokenUrl: "https://wbsapi.withings.net/v2/oauth2",
      redirectUri: "",
      scopes: [],
    };

    await expect(exchangeWithingsCode(config, "code", mockFetch)).resolves.not.toHaveProperty(
      "providerAccountId",
    );
  });

  it("handles non-string scope in response", async () => {
    const mockFetch: typeof globalThis.fetch = async () => {
      return Response.json({
        status: 0,
        body: {
          access_token: "access",
          refresh_token: "refresh",
          expires_in: 3600,
          scope: 12345, // non-string scope
          userid: 489418,
        },
      });
    };

    const config = {
      clientId: "test-id",
      clientSecret: "test-secret",
      authorizeUrl: "",
      tokenUrl: "https://wbsapi.withings.net/v2/oauth2",
      redirectUri: "",
      scopes: [],
    };

    const result = await exchangeWithingsCode(config, "code", mockFetch);
    expect(result.scopes).toBe("");
  });
});

describe("Withings — rate-limit aware fetch wiring", () => {
  const originalEnv = { ...process.env };
  afterEach(() => {
    process.env = { ...originalEnv };
  });

  const rateLimited429: typeof globalThis.fetch = async () =>
    new Response("rate limited", { status: 429, headers: { "Retry-After": "60" } });

  const oauthConfig = {
    clientId: "test-id",
    clientSecret: "test-secret",
    authorizeUrl: "",
    tokenUrl: "https://wbsapi.withings.net/v2/oauth2",
    redirectUri: "",
    scopes: [],
  };

  it("token exchange surfaces a 429 as a ProviderRateLimitError tagged 'withings'", async () => {
    const err = await exchangeWithingsCode(
      oauthConfig,
      "code",
      createProviderRateLimitFetch("withings", rateLimited429),
    ).catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(ProviderRateLimitError);
    if (err instanceof ProviderRateLimitError) {
      expect(err.providerId).toBe("withings");
      expect(err.statusCode).toBe(429);
    }
  });

  it("WithingsClient surfaces a 429 as a ProviderRateLimitError tagged 'withings'", async () => {
    const client = new WithingsClient(
      "access-token",
      createProviderRateLimitFetch("withings", rateLimited429),
    );
    const err = await client.getMeas(0, 1).catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(ProviderRateLimitError);
    if (err instanceof ProviderRateLimitError) {
      expect(err.providerId).toBe("withings");
      expect(err.statusCode).toBe(429);
    }
  });

  it("provider sync rethrows a 429 from its fetch as a ProviderRateLimitError", async () => {
    process.env.WITHINGS_CLIENT_ID = "test-id";
    process.env.WITHINGS_CLIENT_SECRET = "test-secret";

    const { db } = createMockDatabase({
      tokensResult: [
        {
          accessToken: "valid-token",
          refreshToken: "refresh-token",
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      ],
    });

    const provider = new WithingsProvider(rateLimited429);
    await expect(
      provider.sync(
        new SyncRun({ db: db, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
      ),
    ).rejects.toBeInstanceOf(ProviderRateLimitError);
  });

  it("provider sync rethrows retryable infrastructure errors instead of collecting them", async () => {
    process.env.WITHINGS_CLIENT_ID = "test-id";
    process.env.WITHINGS_CLIENT_SECRET = "test-secret";

    const cause = Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
    const fetchError = new TypeError("fetch failed", { cause });
    const timedOutFetch: typeof globalThis.fetch = vi.fn().mockRejectedValue(fetchError);

    const { db } = createMockDatabase({
      tokensResult: [
        {
          accessToken: "valid-token",
          refreshToken: "refresh-token",
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      ],
    });

    const provider = new WithingsProvider(timedOutFetch);
    await expect(
      provider.sync(
        new SyncRun({ db: db, window: SyncWindow.fromSince({ since: new Date("2026-01-01") }) }),
      ),
    ).rejects.toBeInstanceOf(ProviderRequestTimeoutError);
  });
});
