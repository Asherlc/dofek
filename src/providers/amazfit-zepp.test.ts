import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { ZeppInvalidCredentialsError } from "@dofek/zepp-client/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runWithTokenUser } from "../db/token-user-context.ts";
import { captureException } from "../lib/error-reporting.ts";
import { createProviderRateLimitFetch } from "../lib/provider-rate-limit-fetch.ts";
import {
  AmazfitZeppClient,
  AmazfitZeppProvider,
  decodeZeppHeartRateSamples,
  decodeZeppSummary,
  decodeZeppUserIdFromScopes,
  encodeZeppTokenScopes,
  parseZeppBandDay,
} from "./amazfit-zepp.ts";
import { AccessTokenExpiredError, ProviderInvalidCredentialsError } from "./auth-errors.ts";
import { SyncRun } from "./sync-run.ts";
import { SyncWindow } from "./sync-window.ts";
import { createCapturingMetricStreamPublisher, createMockDatabase } from "./test-helpers.ts";

vi.mock("../db/provider-data-deletion.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/provider-data-deletion.ts")>();
  const { resolveProviderDataGenerationsForTest } = await import("./test-helpers.ts");
  return { ...actual, getProviderDataGenerations: resolveProviderDataGenerationsForTest };
});

vi.mock("../lib/provider-rate-limit-fetch.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/provider-rate-limit-fetch.ts")>();
  return {
    ...actual,
    createProviderRateLimitFetch: vi.fn(actual.createProviderRateLimitFetch),
  };
});

vi.mock("../lib/error-reporting.ts", () => ({
  captureException: vi.fn(),
}));

vi.mock("../db/tokens.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/tokens.ts")>();
  return {
    ...actual,
    loadTokens: vi.fn(actual.loadTokens),
    deleteTokens: vi.fn(),
  };
});

const TEST_USER_ID = "11111111-1111-4111-8111-111111111111";

const providerActivityAbsenceMocks = vi.hoisted(() => ({
  finishProviderActivityListSync: vi.fn().mockResolvedValue(undefined),
  upsertProviderActivity: vi.fn().mockResolvedValue({ id: "activity-id" }),
}));

vi.mock("../db/provider-activity-sync.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/provider-activity-sync.ts")>();
  return {
    ...actual,
    finishProviderActivityListSync: providerActivityAbsenceMocks.finishProviderActivityListSync,
    upsertProviderActivity: providerActivityAbsenceMocks.upsertProviderActivity,
  };
});

function encodeBase64(value: string | Buffer): string {
  return Buffer.from(value).toString("base64");
}

function mockZeppLoginFetch(
  tokenInfo: { app_token: string; user_id: string; login_token?: string } = {
    app_token: "app-token-456",
    user_id: "987654321",
    login_token: "login-token-789",
  },
): typeof globalThis.fetch {
  return async (input) => {
    const url = String(input);
    if (url.includes("/registrations/")) {
      return new Response(null, {
        status: 302,
        headers: {
          Location:
            "https://s3-us-west-2.amazonaws.com/hm-registration/successsignin.html?access=access-code&country_code=US",
        },
      });
    }
    return new Response(JSON.stringify({ token_info: tokenInfo }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

async function mockStoredZeppCredentials(
  appToken = "token-123",
  zeppUserId = "user-123",
): Promise<void> {
  const { loadTokens } = await import("../db/tokens.ts");
  vi.mocked(loadTokens).mockResolvedValue({
    accessToken: appToken,
    refreshToken: "login-token",
    expiresAt: new Date("2099-01-01"),
    scopes: encodeZeppTokenScopes(zeppUserId),
  });
}

function emptyZeppWorkoutHistoryResponse(): Response {
  return new Response(JSON.stringify({ code: 1, data: { next: -1, summary: [] } }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("AmazfitZeppClient workout history", () => {
  it("requests workout history with Zepp auth headers", async () => {
    const requests: { url: string | URL | Request; init?: RequestInit }[] = [];
    const fetchFn: typeof globalThis.fetch = async (url, init) => {
      requests.push({ url, init });
      return emptyZeppWorkoutHistoryResponse();
    };
    const client = new AmazfitZeppClient("token-123", "user-123", fetchFn);

    await client.getWorkoutHistory("amazfit-zepp");

    const request = requests[0];
    expect(String(request?.url)).toContain("/v1/sport/run/history.json");
    expect(String(request?.url)).toContain("userid=user-123");
    expect(String(request?.url)).not.toContain("trackid=");
    expect(request?.init?.headers).toMatchObject({
      apptoken: "token-123",
      appname: "com.xiaomi.hm.health",
      Accept: "application/json",
    });
  });

  it("paginates workout history with trackid cursors", async () => {
    const startedAt = new Date("2026-02-06T14:00:00.000Z");
    const secondStartedAt = new Date("2026-02-06T16:00:00.000Z");
    const thirdStartedAt = new Date("2026-02-06T18:00:00.000Z");
    const secondPageCursor = thirdStartedAt.getTime() / 1000;
    const historyRequests: string[] = [];
    const fetchFn: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      historyRequests.push(url);
      const historyUrl = new URL(url);
      if (historyUrl.searchParams.get("trackid") === String(secondPageCursor)) {
        return new Response(
          JSON.stringify({
            code: 1,
            data: {
              next: -1,
              summary: [{ trackid: thirdStartedAt.getTime() / 1000, type: 23 }],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          code: 1,
          data: {
            next: secondPageCursor,
            summary: [
              { trackid: startedAt.getTime() / 1000, type: 1 },
              { trackid: secondStartedAt.getTime() / 1000, type: 10 },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const client = new AmazfitZeppClient("token-123", "user-123", fetchFn);

    const summaries = await client.getWorkoutHistory("amazfit-zepp");

    expect(summaries.items).toHaveLength(3);
    expect(historyRequests).toHaveLength(2);
    expect(historyRequests[1]).toContain(`trackid=${secondPageCursor}`);
  });

  it("coerces numeric string workout fields from the API", async () => {
    const startedAt = new Date("2026-02-06T14:00:00.000Z");
    const endedAt = new Date("2026-02-06T15:00:00.000Z");
    const fetchFn: typeof globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          code: 1,
          data: {
            next: -1,
            summary: [
              {
                trackid: ` ${startedAt.getTime() / 1000} `,
                end_time: String(endedAt.getTime() / 1000),
                type: "9",
                source: "   ",
              },
            ],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    const client = new AmazfitZeppClient("token-123", "user-123", fetchFn);

    const result = await client.getWorkoutHistory("amazfit-zepp");

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.trackid).toBe(startedAt.getTime() / 1000);
    expect(result.items[0]?.type).toBe(9);
    expect(result.items[0]?.source).toBeUndefined();
  });

  it("returns a pagination_stalled degradation when cursor repeats", async () => {
    const startedAt = new Date("2026-02-06T14:00:00.000Z");
    const repeatedCursor = startedAt.getTime() / 1000;
    const fetchFn: typeof globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          code: 1,
          data: {
            next: repeatedCursor,
            summary: [{ trackid: repeatedCursor, type: 1 }],
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    const client = new AmazfitZeppClient("token-123", "user-123", fetchFn);

    const result = await client.getWorkoutHistory("amazfit-zepp");

    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.trackid).toBe(repeatedCursor);
    expect(result.degradations).toEqual([
      expect.objectContaining({
        kind: "pagination_stalled",
        context: expect.objectContaining({
          cursorFingerprint: expect.stringMatching(/^[0-9a-f]{12}$/),
          pagesFetched: 2,
        }),
      }),
    ]);
  });

  it("throws a specific error for non-success HTTP responses", async () => {
    const fetchFn: typeof globalThis.fetch = async () =>
      new Response("server error", { status: 500 });
    const client = new AmazfitZeppClient("token-123", "user-123", fetchFn);

    await expect(client.getWorkoutHistory("amazfit-zepp")).rejects.toThrow(
      "Amazfit/Zepp workout API error (500): server error",
    );
  });

  it("throws AccessTokenExpiredError for HTTP 401 responses", async () => {
    const fetchFn: typeof globalThis.fetch = async () =>
      new Response("unauthorized", { status: 401 });
    const client = new AmazfitZeppClient("token-123", "user-123", fetchFn);

    await expect(client.getWorkoutHistory("amazfit-zepp")).rejects.toThrow(
      "Amazfit/Zepp access token expired.",
    );
  });

  it("includes status code in error cause for workout HTTP 401 responses", async () => {
    const fetchFn: typeof globalThis.fetch = async () =>
      new Response("unauthorized", { status: 401 });
    const client = new AmazfitZeppClient("token-123", "user-123", fetchFn);

    try {
      await client.getWorkoutHistory("amazfit-zepp");
      expect.fail("Expected error to be thrown");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(AccessTokenExpiredError);
      if (!(error instanceof Error)) throw new Error("Expected Error");
      if (!(error.cause instanceof Error)) throw new Error("Expected Error cause");
      expect(error.cause.message).toContain("401");
    }
  });

  it("includes message in error cause for workout code 1002 responses", async () => {
    const fetchFn: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify({ code: 1002, message: "workout token expired", data: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const client = new AmazfitZeppClient("token-123", "user-123", fetchFn);

    try {
      await client.getWorkoutHistory("amazfit-zepp");
      expect.fail("Expected error to be thrown");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(AccessTokenExpiredError);
      if (!(error instanceof Error)) throw new Error("Expected Error");
      if (!(error.cause instanceof Error)) throw new Error("Expected Error cause");
      expect(error.cause.message).toContain("workout token expired");
    }
  });

  it("throws a specific error for non-success API payloads", async () => {
    const fetchFn: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify({ code: 1002, message: "invalid token", data: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const client = new AmazfitZeppClient("token-123", "user-123", fetchFn);

    await expect(client.getWorkoutHistory("amazfit-zepp")).rejects.toThrow(
      "Amazfit/Zepp access token expired.",
    );
  });

  it("throws generic error for non-1002 workout API error codes", async () => {
    const fetchFn: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify({ code: 9999, message: "some other error", data: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const client = new AmazfitZeppClient("token-123", "user-123", fetchFn);

    await expect(client.getWorkoutHistory("amazfit-zepp")).rejects.toThrow(
      "Amazfit/Zepp workout API error: some other error",
    );
  });

  it("rejects workout history payloads without a trackid", async () => {
    const fetchFn: typeof globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          code: 1,
          data: { next: -1, summary: [{ type: 1 }] },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    const client = new AmazfitZeppClient("token-123", "user-123", fetchFn);

    await expect(client.getWorkoutHistory("amazfit-zepp")).rejects.toThrow();
  });
});

describe("Amazfit/Zepp provider", () => {
  afterEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    providerActivityAbsenceMocks.finishProviderActivityListSync.mockClear();
    const { loadTokens } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockReset();
  });

  it("is always enabled and checks auth at sync time", () => {
    expect(new AmazfitZeppProvider().validate()).toBeNull();
  });

  it("decodes base64 summary payloads", () => {
    const summary = decodeZeppSummary(
      encodeBase64(JSON.stringify({ stp: { ttl: 8123, dis: 6400 }, slp: { dp: 80, lt: 320 } })),
    );

    expect(summary.stp?.ttl).toBe(8123);
    expect(summary.slp?.dp).toBe(80);
  });

  it("rejects blank numeric strings instead of coercing them to zero", () => {
    expect(() => decodeZeppSummary(encodeBase64(JSON.stringify({ stp: { ttl: " " } })))).toThrow();
  });

  it("decodes one heart rate sample per valid minute", () => {
    const heartRateBytes = Buffer.from([0, 61, 254, 130]);

    const samples = decodeZeppHeartRateSamples("2026-02-06", encodeBase64(heartRateBytes));

    expect(samples).toEqual([
      { recordedAt: new Date("2026-02-06T00:01:00.000Z"), heartRate: 61 },
      { recordedAt: new Date("2026-02-06T00:03:00.000Z"), heartRate: 130 },
    ]);
  });

  it("parses daily steps, sleep, and heart rate from a band day", () => {
    const parsed = parseZeppBandDay({
      date_time: "2026-02-06",
      summary: encodeBase64(
        JSON.stringify({
          stp: { ttl: 8123, dis: 6400 },
          slp: {
            st: 1707199200,
            ed: 1707224400,
            dp: 85,
            lt: 280,
            dt: 45,
            wk: 20,
            ss: 88,
            rhr: 52,
          },
        }),
      ),
      data_hr: encodeBase64(Buffer.from([55, 0, 62])),
    });

    expect(parsed.date).toBe("2026-02-06");
    expect(parsed.dailyMetrics).toEqual({
      date: "2026-02-06",
      steps: 8123,
      distanceKm: 6.4,
    });
    expect(parsed.sleep).toEqual({
      externalId: "zepp-sleep-2024-02-06T06:00:00.000Z-2024-02-06T13:00:00.000Z",
      startedAt: new Date("2024-02-06T06:00:00.000Z"),
      endedAt: new Date("2024-02-06T13:00:00.000Z"),
      durationMinutes: 410,
      deepMinutes: 85,
      lightMinutes: 280,
      remMinutes: 45,
      awakeMinutes: 20,
      stagingAvailable: true,
    });
    expect(parsed.heartRateSamples).toHaveLength(2);
  });

  it("parses numeric summary strings and minute-based sleep boundaries", () => {
    const parsed = parseZeppBandDay({
      date_time: "2026-02-06",
      summary: encodeBase64(
        JSON.stringify({
          stp: { ttl: "8123.4", dis: "6400" },
          slp: { st: "1320", ed: "1800", dp: "85.4", lt: "280.2", dt: "45.3", wk: "20.2" },
        }),
      ),
    });

    expect(parsed.dailyMetrics).toEqual({
      date: "2026-02-06",
      steps: 8123,
      distanceKm: 6.4,
    });
    expect(parsed.sleep).toEqual({
      externalId: "zepp-sleep-2026-02-06T22:00:00.000Z-2026-02-07T06:00:00.000Z",
      startedAt: new Date("2026-02-06T22:00:00.000Z"),
      endedAt: new Date("2026-02-07T06:00:00.000Z"),
      durationMinutes: 411,
      deepMinutes: 85,
      lightMinutes: 280,
      remMinutes: 45,
      awakeMinutes: 20,
      stagingAvailable: true,
    });
  });

  it("retains daily metrics when only steps or only distance is present", () => {
    const stepsOnly = parseZeppBandDay({
      date_time: "2026-02-06",
      summary: encodeBase64(JSON.stringify({ stp: { ttl: 8123 } })),
    });
    const distanceOnly = parseZeppBandDay({
      date_time: "2026-02-07",
      summary: encodeBase64(JSON.stringify({ stp: { dis: 6400 } })),
    });

    expect(stepsOnly.dailyMetrics).toEqual({
      date: "2026-02-06",
      steps: 8123,
      distanceKm: undefined,
    });
    expect(distanceOnly.dailyMetrics).toEqual({
      date: "2026-02-07",
      steps: undefined,
      distanceKm: 6.4,
    });
  });

  it("parses epoch-second sleep boundaries at the cutoff", () => {
    const parsed = parseZeppBandDay({
      date_time: "2026-02-06",
      summary: encodeBase64(
        JSON.stringify({ slp: { st: 1_000_000_000, ed: 1_000_000_060, dp: 30 } }),
      ),
    });

    expect(parsed.sleep).toEqual({
      externalId: "zepp-sleep-2001-09-09T01:46:40.000Z-2001-09-09T01:47:40.000Z",
      startedAt: new Date("2001-09-09T01:46:40.000Z"),
      endedAt: new Date("2001-09-09T01:47:40.000Z"),
      durationMinutes: 30,
      deepMinutes: 30,
      lightMinutes: undefined,
      remMinutes: undefined,
      awakeMinutes: undefined,
      stagingAvailable: false,
    });
  });

  it.each([
    "dp",
    "lt",
    "dt",
    "wk",
  ] as const)("marks staging unavailable when %s is omitted", (omittedField) => {
    const stages = { dp: 85, lt: 280, dt: 45, wk: 20 };
    delete stages[omittedField];

    const parsed = parseZeppBandDay({
      date_time: "2026-02-06",
      summary: encodeBase64(
        JSON.stringify({
          slp: { st: 1320, ed: 1800, ...stages },
        }),
      ),
    });

    expect(parsed.sleep).toMatchObject({
      stagingAvailable: false,
      deepMinutes: omittedField === "dp" ? undefined : 85,
      lightMinutes: omittedField === "lt" ? undefined : 280,
      remMinutes: omittedField === "dt" ? undefined : 45,
      awakeMinutes: omittedField === "wk" ? undefined : 20,
    });
  });

  it("omits daily metrics and sleep when summary values are incomplete", () => {
    const withoutMetrics = parseZeppBandDay({
      date_time: "2026-02-06",
      summary: encodeBase64(JSON.stringify({ stp: {}, slp: { dp: 20, lt: 40 } })),
    });
    const withoutSleepDuration = parseZeppBandDay({
      dateTime: "2026-02-07",
      summary: encodeBase64(JSON.stringify({ slp: { st: 1320, ed: 1800, dp: 0, lt: 0, dt: 0 } })),
    });
    const withoutSleepBoundary = parseZeppBandDay({
      date_time: "2026-02-08",
      summary: encodeBase64(JSON.stringify({ slp: { st: 1320, dp: 20, lt: 40 } })),
    });

    expect(withoutMetrics.dailyMetrics).toBeUndefined();
    expect(withoutMetrics.sleep).toBeUndefined();
    expect(withoutMetrics.heartRateSamples).toEqual([]);
    expect(withoutSleepDuration.sleep).toBeUndefined();
    expect(withoutSleepBoundary.sleep).toBeUndefined();
  });

  it("rejects band days without a date", () => {
    expect(() =>
      parseZeppBandDay({ summary: encodeBase64(JSON.stringify({ stp: { ttl: 1 } })) }),
    ).toThrow("Zepp band day is missing date_time");
  });

  it("requests band data with Zepp app token headers", async () => {
    const requests: { url: string | URL | Request; init?: RequestInit }[] = [];
    const fetchFn: typeof globalThis.fetch = async (url, init) => {
      requests.push({ url, init });
      return new Response(JSON.stringify({ code: 1, data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const client = new AmazfitZeppClient("token-123", "user-123", fetchFn);

    await client.getBandData("2026-02-01", "2026-02-06");

    const request = requests[0];
    expect(request).toBeDefined();
    expect(String(request?.url)).toContain("/v1/data/band_data.json");
    expect(String(request?.url)).toContain("query_type=detail");
    expect(String(request?.url)).toContain("userid=user-123");
    expect(request?.init?.headers).toMatchObject({
      apptoken: "token-123",
      appname: "com.xiaomi.hm.health",
    });
  });

  it("throws a specific error for non-success HTTP responses", async () => {
    const fetchFn: typeof globalThis.fetch = async () =>
      new Response("server error", { status: 500 });
    const client = new AmazfitZeppClient("token-123", "user-123", fetchFn);

    await expect(client.getBandData("2026-02-01", "2026-02-06")).rejects.toThrow(
      "Amazfit/Zepp API error (500): server error",
    );
  });

  it("throws AccessTokenExpiredError for HTTP 401 responses", async () => {
    const fetchFn: typeof globalThis.fetch = async () =>
      new Response("unauthorized", { status: 401 });
    const client = new AmazfitZeppClient("token-123", "user-123", fetchFn);

    await expect(client.getBandData("2026-02-01", "2026-02-06")).rejects.toThrow(
      "Amazfit/Zepp access token expired.",
    );
  });

  it("includes status code in error cause for HTTP 401 responses", async () => {
    const fetchFn: typeof globalThis.fetch = async () =>
      new Response("unauthorized", { status: 401 });
    const client = new AmazfitZeppClient("token-123", "user-123", fetchFn);

    try {
      await client.getBandData("2026-02-01", "2026-02-06");
      expect.fail("Expected error to be thrown");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(AccessTokenExpiredError);
      if (!(error instanceof Error)) throw new Error("Expected Error");
      if (!(error.cause instanceof Error)) throw new Error("Expected Error cause");
      expect(error.cause.message).toContain("401");
    }
  });

  it("includes message in error cause for code 1002 responses", async () => {
    const fetchFn: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify({ code: 1002, message: "token expired", data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const client = new AmazfitZeppClient("token-123", "user-123", fetchFn);

    try {
      await client.getBandData("2026-02-01", "2026-02-06");
      expect.fail("Expected error to be thrown");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(AccessTokenExpiredError);
      if (!(error instanceof Error)) throw new Error("Expected Error");
      if (!(error.cause instanceof Error)) throw new Error("Expected Error cause");
      expect(error.cause.message).toContain("token expired");
    }
  });

  it("throws a specific error for non-success API payloads", async () => {
    const fetchFn: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify({ code: 1002, message: "invalid token", data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const client = new AmazfitZeppClient("token-123", "user-123", fetchFn);

    await expect(client.getBandData("2026-02-01", "2026-02-06")).rejects.toThrow(
      "Amazfit/Zepp access token expired.",
    );
  });

  it("throws generic error for non-1002 API error codes", async () => {
    const fetchFn: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify({ code: 9999, message: "some other error", data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const client = new AmazfitZeppClient("token-123", "user-123", fetchFn);

    await expect(client.getBandData("2026-02-01", "2026-02-06")).rejects.toThrow(
      "Amazfit/Zepp API error: some other error",
    );
  });

  it("syncs daily metrics, sleep, and heart rate samples from band data", async () => {
    await mockStoredZeppCredentials();

    const { db, spies } = createMockDatabase();
    const metricStreamCapture = createCapturingMetricStreamPublisher();
    const onProgress = vi.fn();
    const fetchFn: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("/v1/sport/run/history.json")) return emptyZeppWorkoutHistoryResponse();
      return new Response(
        JSON.stringify({
          code: 1,
          data: [
            {
              date_time: "2026-02-06",
              summary: encodeBase64(
                JSON.stringify({
                  stp: { ttl: 8123, dis: 6400, cal: 410 },
                  slp: { st: 1320, ed: 1800, dp: 85, lt: 280, dt: 45, wk: 20 },
                }),
              ),
              data_hr: encodeBase64(Buffer.from([55, 0, 62])),
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const provider = new AmazfitZeppProvider(fetchFn);

    const result = await runWithTokenUser(TEST_USER_ID, () =>
      provider.sync(
        new SyncRun({
          db: db,
          window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00.000Z") }),
          metricStreamPublisher: metricStreamCapture.publisher,
          onProgress,
          userId: TEST_USER_ID,
        }),
      ),
    );

    expect(result.errors).toEqual([]);
    expect(result.recordsSynced).toBe(4);
    expect(spies.onConflictDoUpdate).toHaveBeenCalledTimes(2);
    expect(spies.values).toHaveBeenCalledWith(
      expect.objectContaining({
        date: "2026-02-06",
        providerId: "amazfit-zepp",
        userId: TEST_USER_ID,
        sourceName: "Zepp",
        steps: 8123,
        distanceKm: 6.4,
      }),
    );
    expect(spies.values).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "amazfit-zepp",
        userId: TEST_USER_ID,
        externalId: "zepp-sleep-2026-02-06T22:00:00.000Z-2026-02-07T06:00:00.000Z",
        durationMinutes: 410,
        sourceName: "Zepp",
      }),
    );
    expect(spies.onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({
          sourceName: "Zepp",
          steps: 8123,
          distanceKm: 6.4,
        }),
      }),
    );
    expect(spies.onConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({
          sourceName: "Zepp",
          durationMinutes: 410,
          deepMinutes: 85,
          lightMinutes: 280,
          remMinutes: 45,
          awakeMinutes: 20,
        }),
      }),
    );
    expect(onProgress).toHaveBeenNthCalledWith(1, 0, "Fetching band data");
    expect(onProgress).toHaveBeenNthCalledWith(2, 100, "1/1 days");
    expect(metricStreamCapture.publishedMetricStreamRows).toMatchObject([
      {
        userId: TEST_USER_ID,
        providerId: "amazfit-zepp",
        externalId: "zepp-heart-rate-2026-02-06T00:00:00.000Z",
        deviceId: "Zepp",
        scalar: 55,
      },
      {
        userId: TEST_USER_ID,
        providerId: "amazfit-zepp",
        externalId: "zepp-heart-rate-2026-02-06T00:02:00.000Z",
        deviceId: "Zepp",
        scalar: 62,
      },
    ]);
  });

  it("syncs every workout summary returned by Zepp history as activities", async () => {
    await mockStoredZeppCredentials();

    const { db } = createMockDatabase();
    const startedAt = new Date("2026-02-06T14:00:00.000Z");
    const endedAt = new Date("2026-02-06T15:00:00.000Z");
    const secondStartedAt = new Date(startedAt.getTime() + 7200 * 1000);
    const secondEndedAt = new Date(endedAt.getTime() + 7200 * 1000);
    const thirdStartedAt = new Date(startedAt.getTime() + 14400 * 1000);
    const thirdEndedAt = new Date(endedAt.getTime() + 14400 * 1000);
    const secondPageCursor = thirdStartedAt.getTime() / 1000;
    const historyRequests: string[] = [];
    const fetchFn: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("/v1/data/band_data.json")) {
        return new Response(JSON.stringify({ code: 1, data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/v1/sport/run/history.json")) {
        historyRequests.push(url);
        const historyUrl = new URL(url);
        if (historyUrl.searchParams.get("trackid") === String(secondPageCursor)) {
          return new Response(
            JSON.stringify({
              code: 1,
              data: {
                next: -1,
                summary: [
                  {
                    trackid: String(thirdStartedAt.getTime() / 1000),
                    source: "watch",
                    end_time: String(thirdEndedAt.getTime() / 1000),
                    run_time: "3600",
                    type: 999,
                    dis: "1000",
                    calorie: "120",
                    app_name: "Zepp",
                  },
                ],
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            code: 1,
            data: {
              next: secondPageCursor,
              summary: [
                {
                  trackid: String(startedAt.getTime() / 1000),
                  source: "watch",
                  end_time: String(endedAt.getTime() / 1000),
                  run_time: "3600",
                  type: 1,
                  dis: "10000",
                  calorie: "620",
                  app_name: "Zepp",
                },
                {
                  trackid: String(secondStartedAt.getTime() / 1000),
                  source: "watch",
                  end_time: String(secondEndedAt.getTime() / 1000),
                  run_time: "3600",
                  type: 9,
                  dis: "30000",
                  calorie: "710",
                  app_name: "Zepp",
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unexpected Amazfit/Zepp request: ${url}`);
    };
    const provider = new AmazfitZeppProvider(fetchFn);

    const result = await provider.sync(
      new SyncRun({
        db: db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00.000Z") }),
        userId: TEST_USER_ID,
      }),
    );

    expect(result.errors).toEqual([]);
    expect(result.recordsSynced).toBe(3);
    expect(historyRequests).toHaveLength(2);
    expect(historyRequests[1]).toContain(`trackid=${secondPageCursor}`);
    expect(providerActivityAbsenceMocks.upsertProviderActivity).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        providerId: "amazfit-zepp",
        userId: TEST_USER_ID,
        externalId: String(startedAt.getTime() / 1000),
        activityType: expect.objectContaining({ canonicalType: "running" }),
        startedAt,
        endedAt,
        sourceName: "Zepp",
      }),
      expect.objectContaining({
        activityType: expect.objectContaining({ canonicalType: "running" }),
        startedAt,
        endedAt,
        sourceName: "Zepp",
      }),
    );
    expect(providerActivityAbsenceMocks.upsertProviderActivity).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        activityType: expect.objectContaining({ canonicalType: "cycling" }),
        externalId: String(secondStartedAt.getTime() / 1000),
      }),
      expect.objectContaining({
        activityType: expect.objectContaining({ canonicalType: "cycling" }),
      }),
    );
    expect(providerActivityAbsenceMocks.upsertProviderActivity).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        activityType: expect.objectContaining({ canonicalType: "other" }),
        externalId: String(thirdStartedAt.getTime() / 1000),
      }),
      expect.objectContaining({
        activityType: expect.objectContaining({ canonicalType: "other" }),
      }),
    );
    expect(providerActivityAbsenceMocks.finishProviderActivityListSync).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        providerId: "amazfit-zepp",
        userId: TEST_USER_ID,
        presentExternalIds: new Set([
          String(startedAt.getTime() / 1000),
          String(secondStartedAt.getTime() / 1000),
          String(thirdStartedAt.getTime() / 1000),
        ]),
      }),
    );
  });

  it("derives workout endedAt from run_time when end_time is missing", async () => {
    await mockStoredZeppCredentials();

    const { db } = createMockDatabase();
    const startedAt = new Date("2026-02-06T14:00:00.000Z");
    const fetchFn: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("/v1/data/band_data.json")) {
        return new Response(JSON.stringify({ code: 1, data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/v1/sport/run/history.json")) {
        return new Response(
          JSON.stringify({
            code: 1,
            data: {
              next: -1,
              summary: [{ trackid: startedAt.getTime() / 1000, run_time: 3600, type: 6 }],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unexpected Amazfit/Zepp request: ${url}`);
    };
    const provider = new AmazfitZeppProvider(fetchFn);

    const result = await provider.sync(
      new SyncRun({
        db: db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00.000Z") }),
        userId: TEST_USER_ID,
      }),
    );

    expect(result.errors).toEqual([]);
    expect(result.recordsSynced).toBe(1);
    expect(providerActivityAbsenceMocks.upsertProviderActivity).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        activityType: expect.objectContaining({ canonicalType: "walking" }),
        startedAt,
        endedAt: new Date("2026-02-06T15:00:00.000Z"),
      }),
      expect.objectContaining({
        activityType: expect.objectContaining({ canonicalType: "walking" }),
        startedAt,
        endedAt: new Date("2026-02-06T15:00:00.000Z"),
      }),
    );
  });

  it("skips workouts outside the sync window", async () => {
    await mockStoredZeppCredentials();

    const { db } = createMockDatabase();
    const onProgress = vi.fn();
    const inWindowStartedAt = new Date("2026-02-06T14:00:00.000Z");
    const beforeWindowStartedAt = new Date("2026-01-31T14:00:00.000Z");
    const afterWindowStartedAt = new Date("2026-02-08T14:00:00.000Z");
    const fetchFn: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("/v1/data/band_data.json")) {
        return new Response(JSON.stringify({ code: 1, data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/v1/sport/run/history.json")) {
        return new Response(
          JSON.stringify({
            code: 1,
            data: {
              next: -1,
              summary: [
                {
                  trackid: beforeWindowStartedAt.getTime() / 1000,
                  end_time: String(beforeWindowStartedAt.getTime() / 1000 + 3600),
                  type: 1,
                },
                {
                  trackid: inWindowStartedAt.getTime() / 1000,
                  end_time: String(inWindowStartedAt.getTime() / 1000 + 3600),
                  type: 9,
                },
                {
                  trackid: afterWindowStartedAt.getTime() / 1000,
                  end_time: String(afterWindowStartedAt.getTime() / 1000 + 3600),
                  type: 6,
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unexpected Amazfit/Zepp request: ${url}`);
    };
    const provider = new AmazfitZeppProvider(fetchFn);

    const result = await provider.sync(
      new SyncRun({
        db: db,
        window: new SyncWindow({
          since: new Date("2026-02-01T00:00:00.000Z"),
          until: new Date("2026-02-07T00:00:00.000Z"),
        }),
        onProgress,
        userId: TEST_USER_ID,
      }),
    );

    expect(result.errors).toEqual([]);
    expect(result.recordsSynced).toBe(1);
    const activityUpserts = providerActivityAbsenceMocks.upsertProviderActivity.mock.calls.map(
      (call) => call[1],
    );
    expect(activityUpserts).toHaveLength(1);
    expect(activityUpserts[0]).toMatchObject({
      externalId: String(inWindowStartedAt.getTime() / 1000),
      activityType: expect.objectContaining({ canonicalType: "cycling" }),
    });
    expect(onProgress).toHaveBeenCalledWith(100, "3/3 workouts");
    expect(providerActivityAbsenceMocks.finishProviderActivityListSync).toHaveBeenCalledWith(
      db,
      expect.objectContaining({
        providerId: "amazfit-zepp",
        userId: TEST_USER_ID,
        presentExternalIds: new Set([String(inWindowStartedAt.getTime() / 1000)]),
      }),
    );
  });

  it("reports workout sync progress and empty-history progress", async () => {
    await mockStoredZeppCredentials();

    const { db } = createMockDatabase();
    const onProgress = vi.fn();
    const startedAt = new Date("2026-02-06T14:00:00.000Z");
    const endedAt = new Date("2026-02-06T15:00:00.000Z");
    const secondStartedAt = new Date("2026-02-06T16:00:00.000Z");
    const secondEndedAt = new Date("2026-02-06T17:00:00.000Z");
    const fetchFn: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("/v1/data/band_data.json")) {
        return new Response(JSON.stringify({ code: 1, data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/v1/sport/run/history.json")) {
        return new Response(
          JSON.stringify({
            code: 1,
            data: {
              next: -1,
              summary: [
                {
                  trackid: startedAt.getTime() / 1000,
                  end_time: String(endedAt.getTime() / 1000),
                  type: 1,
                },
                {
                  trackid: secondStartedAt.getTime() / 1000,
                  end_time: String(secondEndedAt.getTime() / 1000),
                  type: 8,
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unexpected Amazfit/Zepp request: ${url}`);
    };
    const provider = new AmazfitZeppProvider(fetchFn);

    await provider.sync(
      new SyncRun({
        db: db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00.000Z") }),
        onProgress,
        userId: TEST_USER_ID,
      }),
    );

    expect(onProgress).toHaveBeenCalledWith(0, "Fetching workout history");
    expect(onProgress).toHaveBeenCalledWith(50, "1/2 workouts");
    expect(onProgress).toHaveBeenCalledWith(100, "2/2 workouts");
  });

  it("reports empty workout history progress", async () => {
    await mockStoredZeppCredentials();

    const { db } = createMockDatabase();
    const onProgress = vi.fn();
    const fetchFn: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("/v1/sport/run/history.json")) return emptyZeppWorkoutHistoryResponse();
      return new Response(JSON.stringify({ code: 1, data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const provider = new AmazfitZeppProvider(fetchFn);

    await provider.sync(
      new SyncRun({
        db: db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00.000Z") }),
        onProgress,
        userId: TEST_USER_ID,
      }),
    );

    expect(onProgress).toHaveBeenCalledWith(100, "0/0 workouts");
  });

  it("records workout API errors during sync", async () => {
    await mockStoredZeppCredentials();

    const { db } = createMockDatabase();
    const fetchFn: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("/v1/data/band_data.json")) {
        return new Response(JSON.stringify({ code: 1, data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/v1/sport/run/history.json")) {
        return new Response(JSON.stringify({ code: 1002, message: "invalid token", data: {} }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`Unexpected Amazfit/Zepp request: ${url}`);
    };
    const provider = new AmazfitZeppProvider(fetchFn);

    const result = await provider.sync(
      new SyncRun({
        db: db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00.000Z") }),
        userId: TEST_USER_ID,
      }),
    );

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toMatchObject([
      { message: "workouts: Amazfit/Zepp access token expired." },
    ]);
    expect(captureException).not.toHaveBeenCalled();
    const { deleteTokens } = await import("../db/tokens.ts");
    expect(deleteTokens).toHaveBeenCalledWith(db, "amazfit-zepp", TEST_USER_ID);
  });

  it("records per-workout insert failures and continues", async () => {
    await mockStoredZeppCredentials();

    const { db } = createMockDatabase();
    let activityUpserts = 0;
    providerActivityAbsenceMocks.upsertProviderActivity.mockImplementation(async () => {
      activityUpserts++;
      if (activityUpserts === 2) {
        throw new Error("activity insert failed");
      }
      return { id: "activity-id" };
    });
    const startedAt = new Date("2026-02-06T14:00:00.000Z");
    const endedAt = new Date("2026-02-06T15:00:00.000Z");
    const secondStartedAt = new Date("2026-02-06T16:00:00.000Z");
    const secondEndedAt = new Date("2026-02-06T17:00:00.000Z");
    const fetchFn: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("/v1/data/band_data.json")) {
        return new Response(JSON.stringify({ code: 1, data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.includes("/v1/sport/run/history.json")) {
        return new Response(
          JSON.stringify({
            code: 1,
            data: {
              next: -1,
              summary: [
                {
                  trackid: startedAt.getTime() / 1000,
                  end_time: String(endedAt.getTime() / 1000),
                  type: 1,
                },
                {
                  trackid: secondStartedAt.getTime() / 1000,
                  end_time: String(secondEndedAt.getTime() / 1000),
                  type: 9,
                },
              ],
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      throw new Error(`Unexpected Amazfit/Zepp request: ${url}`);
    };
    const provider = new AmazfitZeppProvider(fetchFn);

    const result = await provider.sync(
      new SyncRun({
        db: db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00.000Z") }),
        userId: TEST_USER_ID,
      }),
    );

    expect(result.recordsSynced).toBe(1);
    expect(result.errors).toMatchObject([{ message: "activity insert failed" }]);
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { provider: "amazfit-zepp", dataType: "workouts", phase: "workout" },
    });
  });

  it("propagates rate limit errors from workout sync", async () => {
    await mockStoredZeppCredentials();

    const { db } = createMockDatabase();
    const fetchFn: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("/v1/data/band_data.json")) {
        return new Response(JSON.stringify({ code: 1, data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response("slow down", {
        status: 429,
        headers: { "Retry-After": "30" },
      });
    };
    const provider = new AmazfitZeppProvider(fetchFn);

    await expect(
      provider.sync(
        new SyncRun({
          db: db,
          window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00.000Z") }),
          userId: TEST_USER_ID,
        }),
      ),
    ).rejects.toBeInstanceOf(ProviderRateLimitError);
    expect(captureException).not.toHaveBeenCalledWith(expect.any(ProviderRateLimitError), {
      tags: { provider: "amazfit-zepp", dataType: "workouts", phase: "sync" },
    });
  });

  it("records malformed band days as sync errors and continues", async () => {
    await mockStoredZeppCredentials();

    const { db } = createMockDatabase();
    const fetchFn: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("/v1/sport/run/history.json")) return emptyZeppWorkoutHistoryResponse();
      return new Response(JSON.stringify({ code: 1, data: [{}] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const provider = new AmazfitZeppProvider(fetchFn);

    const result = await runWithTokenUser(TEST_USER_ID, () =>
      provider.sync(
        new SyncRun({
          db: db,
          window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00.000Z") }),
          userId: TEST_USER_ID,
        }),
      ),
    );

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toMatchObject([{ message: "Zepp band day is missing date_time" }]);
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { provider: "amazfit-zepp", dataType: "band_data", phase: "day" },
    });
  });

  it("returns a not-connected error before fetching when credentials are missing", async () => {
    const { db } = createMockDatabase();
    const fetchFn = vi.fn<typeof globalThis.fetch>();
    const provider = new AmazfitZeppProvider(fetchFn);

    const result = await provider.sync(
      new SyncRun({
        db: db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00.000Z") }),
        userId: TEST_USER_ID,
      }),
    );

    expect(fetchFn).not.toHaveBeenCalled();
    expect(result.recordsSynced).toBe(0);
    expect(result.errors[0]?.message).toContain("credentials");
  });

  it("returns a not-connected error when the stored access token is missing", async () => {
    const { loadTokens } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValue({
      accessToken: "",
      refreshToken: "login-token",
      expiresAt: new Date("2099-01-01"),
      scopes: "userId:user-123",
    });

    const { db } = createMockDatabase();
    const fetchFn = vi.fn<typeof globalThis.fetch>();
    const provider = new AmazfitZeppProvider(fetchFn);

    const result = await provider.sync(
      new SyncRun({
        db: db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00.000Z") }),
        userId: TEST_USER_ID,
      }),
    );

    expect(fetchFn).not.toHaveBeenCalled();
    expect(result.errors[0]?.message).toContain("credentials");
  });

  it("returns a not-connected error when stored scopes omit the Zepp user id", async () => {
    const { loadTokens } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValue({
      accessToken: "token-123",
      refreshToken: "login-token",
      expiresAt: new Date("2099-01-01"),
      scopes: null,
    });

    const { db } = createMockDatabase();
    const fetchFn = vi.fn<typeof globalThis.fetch>();
    const provider = new AmazfitZeppProvider(fetchFn);

    const result = await provider.sync(
      new SyncRun({
        db: db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00.000Z") }),
        userId: TEST_USER_ID,
      }),
    );

    expect(fetchFn).not.toHaveBeenCalled();
    expect(result.errors[0]?.message).toContain("credentials");
  });

  it("uses stored app token and Zepp user id when requesting band data", async () => {
    await mockStoredZeppCredentials("my-app-token", "zepp-user-42");

    const { db } = createMockDatabase();
    const fetchFn = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify({ code: 1, data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const provider = new AmazfitZeppProvider(fetchFn);

    await provider.sync(
      new SyncRun({
        db: db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00.000Z") }),
        userId: TEST_USER_ID,
      }),
    );

    expect(String(fetchFn.mock.calls[0]?.[0])).toContain("userid=zepp-user-42");
    expect(fetchFn.mock.calls[0]?.[1]?.headers).toMatchObject({
      apptoken: "my-app-token",
    });
  });

  it("accepts legacy userId: scopes when resolving stored credentials", async () => {
    const { loadTokens } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockResolvedValue({
      accessToken: "legacy-token",
      refreshToken: "login-token",
      expiresAt: new Date("2099-01-01"),
      scopes: "userId:legacy-zepp-user",
    });

    const { db } = createMockDatabase();
    const fetchFn = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(JSON.stringify({ code: 1, data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const provider = new AmazfitZeppProvider(fetchFn);

    await provider.sync(
      new SyncRun({
        db: db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00.000Z") }),
        userId: TEST_USER_ID,
      }),
    );

    expect(String(fetchFn.mock.calls[0]?.[0])).toContain("userid=legacy-zepp-user");
    expect(fetchFn.mock.calls[0]?.[1]?.headers).toMatchObject({
      apptoken: "legacy-token",
    });
  });

  it("records API errors from the sync request and reports them", async () => {
    await mockStoredZeppCredentials();

    const { db } = createMockDatabase();
    const fetchFn: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("/v1/sport/run/history.json")) return emptyZeppWorkoutHistoryResponse();
      return new Response(JSON.stringify({ code: 1002, message: "invalid token", data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const provider = new AmazfitZeppProvider(fetchFn);

    const result = await provider.sync(
      new SyncRun({
        db: db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00.000Z") }),
        userId: TEST_USER_ID,
      }),
    );

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toMatchObject([
      { message: "band_data: Amazfit/Zepp access token expired." },
    ]);
    expect(captureException).not.toHaveBeenCalled();
    const { deleteTokens } = await import("../db/tokens.ts");
    expect(deleteTokens).toHaveBeenCalledWith(db, "amazfit-zepp", TEST_USER_ID);
  });

  it("reports non-auth errors to Sentry with correct tags", async () => {
    await mockStoredZeppCredentials();

    const { db } = createMockDatabase();
    const fetchFn: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("/v1/sport/run/history.json")) return emptyZeppWorkoutHistoryResponse();
      return new Response(JSON.stringify({ code: 9999, message: "server error", data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const provider = new AmazfitZeppProvider(fetchFn);

    const result = await provider.sync(
      new SyncRun({
        db: db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00.000Z") }),
        userId: TEST_USER_ID,
      }),
    );

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toMatchObject([
      { message: "band_data: Amazfit/Zepp API error: server error" },
    ]);
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { provider: "amazfit-zepp", dataType: "band_data", phase: "sync" },
    });
  });

  it("reports workout non-auth errors to Sentry with correct tags", async () => {
    await mockStoredZeppCredentials();

    const { db } = createMockDatabase();
    const fetchFn: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("/v1/data/band_data.json")) {
        return new Response(JSON.stringify({ code: 1, data: [] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ code: 9999, message: "workout error", data: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const provider = new AmazfitZeppProvider(fetchFn);

    const result = await provider.sync(
      new SyncRun({
        db: db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00.000Z") }),
        userId: TEST_USER_ID,
      }),
    );

    expect(result.errors).toMatchObject([
      { message: "workouts: Amazfit/Zepp workout API error: workout error" },
    ]);
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { provider: "amazfit-zepp", dataType: "workouts", phase: "sync" },
    });
  });

  it("reports deleteTokens errors but continues with sync result", async () => {
    await mockStoredZeppCredentials();

    const { db } = createMockDatabase();
    const { deleteTokens } = await import("../db/tokens.ts");
    vi.mocked(deleteTokens).mockRejectedValueOnce(new Error("token deletion failed"));

    const fetchFn: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("/v1/sport/run/history.json")) return emptyZeppWorkoutHistoryResponse();
      return new Response(JSON.stringify({ code: 1002, message: "invalid token", data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };
    const provider = new AmazfitZeppProvider(fetchFn);

    const result = await provider.sync(
      new SyncRun({
        db: db,
        window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00.000Z") }),
        userId: TEST_USER_ID,
      }),
    );

    expect(result.errors).toMatchObject([
      { message: "band_data: Amazfit/Zepp access token expired." },
    ]);
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { provider: "amazfit-zepp", phase: "token_deletion" },
    });
  });

  it("propagates rate limit errors from sync", async () => {
    await mockStoredZeppCredentials();

    const { db } = createMockDatabase();
    const fetchFn: typeof globalThis.fetch = async () =>
      new Response("slow down", {
        status: 429,
        headers: { "Retry-After": "30" },
      });
    const provider = new AmazfitZeppProvider(fetchFn);

    await expect(
      provider.sync(
        new SyncRun({
          db: db,
          window: SyncWindow.fromSince({ since: new Date("2026-02-01T00:00:00.000Z") }),
          userId: TEST_USER_ID,
        }),
      ),
    ).rejects.toBeInstanceOf(ProviderRateLimitError);
    expect(captureException).not.toHaveBeenCalled();
  });
});

describe("Zepp token scopes", () => {
  it("round-trips zepp user id through JSON scopes", () => {
    const scopes = encodeZeppTokenScopes("987654321");
    expect(scopes).toBe('{"zeppUserId":"987654321"}');
    expect(decodeZeppUserIdFromScopes(scopes)).toBe("987654321");
  });

  it("falls back to legacy userId: scopes", () => {
    expect(decodeZeppUserIdFromScopes("userId:legacy-user")).toBe("legacy-user");
  });

  it("returns null for missing scopes", () => {
    expect(decodeZeppUserIdFromScopes(null)).toBeNull();
    expect(decodeZeppUserIdFromScopes(undefined)).toBeNull();
    expect(decodeZeppUserIdFromScopes("")).toBeNull();
  });

  it("returns null when JSON scopes omit zeppUserId", () => {
    expect(decodeZeppUserIdFromScopes('{"other":"value"}')).toBeNull();
  });

  it("returns null when zeppUserId is not a string", () => {
    expect(decodeZeppUserIdFromScopes('{"zeppUserId":123}')).toBeNull();
  });

  it("returns null when zeppUserId is empty", () => {
    expect(decodeZeppUserIdFromScopes('{"zeppUserId":""}')).toBeNull();
  });

  it("returns null for JSON null literal scopes", () => {
    expect(decodeZeppUserIdFromScopes("null")).toBeNull();
  });

  it("returns null for non-object JSON scopes", () => {
    expect(decodeZeppUserIdFromScopes('"hello"')).toBeNull();
    expect(decodeZeppUserIdFromScopes("42")).toBeNull();
  });

  it("requires exact legacy userId: prefix match", () => {
    expect(decodeZeppUserIdFromScopes("prefix userId:legacy-user")).toBeNull();
    expect(decodeZeppUserIdFromScopes("userId:legacy-user suffix")).toBeNull();
  });

  it("returns null for unrelated scope strings", () => {
    expect(decodeZeppUserIdFromScopes("oauth:google")).toBeNull();
  });
});

describe("AmazfitZeppProvider auth", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("wraps fetch with amazfit-zepp rate limit config", () => {
    new AmazfitZeppProvider();
    expect(createProviderRateLimitFetch).toHaveBeenCalledWith("amazfit-zepp", expect.any(Function));
  });

  it("authSetup returns credential configuration", () => {
    const setup = new AmazfitZeppProvider().authSetup();
    expect(setup.oauthConfig).toBeUndefined();
    expect(setup.exchangeCode).toBeUndefined();
    expect(setup.apiBaseUrl).toContain("zepp.com");
    expect(setup.automatedLogin).toBeTypeOf("function");
  });

  it("automatedLogin stores tokens with structured scopes and one-year expiry", async () => {
    const before = Date.now();
    const setup = new AmazfitZeppProvider(mockZeppLoginFetch()).authSetup();
    const tokens = await setup.automatedLogin?.("user@example.com", "password123");
    const after = Date.now();

    expect(tokens).toEqual({
      accessToken: "app-token-456",
      refreshToken: "login-token-789",
      expiresAt: expect.any(Date),
      scopes: encodeZeppTokenScopes("987654321"),
    });
    expect(tokens?.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 364 * 24 * 60 * 60 * 1000);
    expect(tokens?.expiresAt.getTime()).toBeLessThanOrEqual(after + 366 * 24 * 60 * 60 * 1000);
  });

  it("wraps invalid credentials as an expected provider auth failure", async () => {
    const originalError = new ZeppInvalidCredentialsError();
    const setup = new AmazfitZeppProvider(async () => {
      throw originalError;
    }).authSetup();

    const error = await setup
      .automatedLogin?.("user@example.com", "wrong")
      .catch((caught) => caught);

    expect(error).toBeInstanceOf(ProviderInvalidCredentialsError);
    expect(error).toHaveProperty("cause", originalError);
  });

  it("does not wrap unrelated automated login errors as invalid credentials", async () => {
    const originalError = new Error("Zepp returned malformed token payload");
    const setup = new AmazfitZeppProvider(async () => {
      throw originalError;
    }).authSetup();

    await expect(setup.automatedLogin?.("user@example.com", "wrong")).rejects.toBe(originalError);
  });

  it("does not wrap non-error automated login failures as invalid credentials", async () => {
    const setup = new AmazfitZeppProvider(async () => {
      throw "plain upstream failure";
    }).authSetup();

    await expect(setup.automatedLogin?.("user@example.com", "wrong")).rejects.toBe(
      "plain upstream failure",
    );
  });
});
