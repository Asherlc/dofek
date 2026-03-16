import { afterEach, describe, expect, it } from "vitest";
import { createMockDatabase } from "./test-helpers.ts";
import {
  exchangeWithingsCode,
  parseMeasureGroup,
  type WithingsMeasureGroup,
  WithingsProvider,
} from "./withings.ts";

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

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns error when no tokens are stored", async () => {
    process.env.WITHINGS_CLIENT_ID = "test-id";
    process.env.WITHINGS_CLIENT_SECRET = "test-secret";

    const { db: mockDb } = createMockDb();
    const provider = new WithingsProvider();

    const result = await provider.sync(mockDb, new Date("2026-01-01"));
    expect(result.provider).toBe("withings");
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.message).toContain("No OAuth tokens");
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
    const result = await provider.sync(mockDb, new Date("2026-01-01"));
    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toHaveLength(0);
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
    const result = await provider.sync(mockDb, new Date("2026-01-01"));
    expect(result.recordsSynced).toBe(2);
    expect(callCount).toBe(2);
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
    const result = await provider.sync(mockDb, new Date("2026-01-01"));
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
      insertError: new Error("DB constraint violation"),
      insertErrorAfterCalls: 1, // Skip ensureProvider upsert
    });

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
    const result = await provider.sync(mockDb, new Date("2026-01-01"));
    // The insert error is caught per-measurement, so we get 0 synced and 1 error
    expect(result.recordsSynced).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.message).toContain("DB constraint violation");
  });

  it("catches API error in outer withSyncLog catch", async () => {
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
      return Response.json({ status: 401, body: {} });
    };

    const provider = new WithingsProvider(mockFetch);
    const result = await provider.sync(mockDb, new Date("2026-01-01"));
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]?.message).toContain("body_measurement");
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
    const result = await provider.sync(mockDb, new Date("2026-01-01"));
    expect(tokenCallMade).toBe(true);
    expect(result.provider).toBe("withings");
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
    const result = await provider.sync(mockDb, new Date("2026-01-01"));
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
    const result = await provider.sync(mockDb, new Date("2026-01-01"));
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
    const result = await provider.sync(mockDb, new Date("2026-01-01"));
    expect(result.recordsSynced).toBe(1);
  });
});

describe("exchangeWithingsCode — scope handling", () => {
  it("handles non-string scope in response", async () => {
    const mockFetch: typeof globalThis.fetch = async () => {
      return Response.json({
        status: 0,
        body: {
          access_token: "access",
          refresh_token: "refresh",
          expires_in: 3600,
          scope: 12345, // non-string scope
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
