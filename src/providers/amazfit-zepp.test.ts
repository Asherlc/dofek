import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { captureException } from "@sentry/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runWithTokenUser } from "../db/token-user-context.ts";
import {
  AmazfitZeppClient,
  AmazfitZeppProvider,
  decodeZeppHeartRateSamples,
  decodeZeppSummary,
  parseZeppBandDay,
} from "./amazfit-zepp.ts";
import { createCapturingMetricStreamPublisher, createMockDatabase } from "./test-helpers.ts";

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
}));

vi.mock("../db/tokens.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/tokens.ts")>();
  return {
    ...actual,
    loadTokens: vi.fn(actual.loadTokens),
  };
});

const TEST_USER_ID = "11111111-1111-4111-8111-111111111111";

function encodeBase64(value: string | Buffer): string {
  return Buffer.from(value).toString("base64");
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
    scopes: `userId:${zeppUserId}`,
  });
}

describe("Amazfit/Zepp provider", () => {
  afterEach(async () => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    const { loadTokens } = await import("../db/tokens.ts");
    vi.mocked(loadTokens).mockReset();
  });

  it("is always enabled and checks auth at sync time", () => {
    expect(new AmazfitZeppProvider().validate()).toBeNull();
  });

  it("authSetup returns credential login configuration", async () => {
    const fetchFn: typeof globalThis.fetch = async () =>
      new Response(null, {
        status: 302,
        headers: {
          Location:
            "https://s3-us-west-2.amazonaws.com/hm-registration/successsignin.html?access=access-code&country_code=US",
        },
      });
    const provider = new AmazfitZeppProvider(fetchFn);
    const setup = provider.authSetup();

    expect(setup.automatedLogin).toBeTypeOf("function");
    expect(setup.apiBaseUrl).toBe("https://api-mifit.zepp.com");
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
          stp: { ttl: 8123, dis: 6400, cal: 410 },
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
      activeEnergyKcal: 410,
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
    });
    expect(parsed.heartRateSamples).toHaveLength(2);
  });

  it("parses numeric summary strings and minute-based sleep boundaries", () => {
    const parsed = parseZeppBandDay({
      date_time: "2026-02-06",
      summary: encodeBase64(
        JSON.stringify({
          stp: { ttl: "8123.4", dis: "6400", cal: "410" },
          slp: { st: "1320", ed: "1800", dp: "85.4", lt: "280.2", dt: "45.3", wk: "20.2" },
        }),
      ),
    });

    expect(parsed.dailyMetrics).toEqual({
      date: "2026-02-06",
      steps: 8123,
      activeEnergyKcal: 410,
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
    });
  });

  it("parses partial daily metrics without inventing missing fields", () => {
    const parsed = parseZeppBandDay({
      date_time: "2026-02-06",
      summary: encodeBase64(JSON.stringify({ stp: { cal: 75 } })),
    });

    expect(parsed.dailyMetrics).toEqual({
      date: "2026-02-06",
      steps: undefined,
      activeEnergyKcal: 75,
      distanceKm: undefined,
    });
    expect(parsed.sleep).toBeUndefined();
    expect(parsed.heartRateSamples).toEqual([]);
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
      new Response("service unavailable", { status: 503 });
    const client = new AmazfitZeppClient("token-123", "user-123", fetchFn);

    await expect(client.getBandData("2026-02-01", "2026-02-06")).rejects.toThrow(
      "Amazfit/Zepp API error (503): service unavailable",
    );
  });

  it("throws a specific error for non-success API payloads", async () => {
    const fetchFn: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify({ code: 1002, message: "invalid token", data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const client = new AmazfitZeppClient("token-123", "user-123", fetchFn);

    await expect(client.getBandData("2026-02-01", "2026-02-06")).rejects.toThrow(
      "Amazfit/Zepp API error: invalid token",
    );
  });

  it("syncs daily metrics, sleep, and heart rate samples from band data", async () => {
    await mockStoredZeppCredentials();

    const { db, spies } = createMockDatabase();
    const metricStreamCapture = createCapturingMetricStreamPublisher();
    const onProgress = vi.fn();
    const fetchFn: typeof globalThis.fetch = async () =>
      new Response(
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
    const provider = new AmazfitZeppProvider(fetchFn);

    const result = await runWithTokenUser(TEST_USER_ID, () =>
      provider.sync(db, new Date("2026-02-01T00:00:00.000Z"), {
        metricStreamPublisher: metricStreamCapture.publisher,
        onProgress,
        userId: TEST_USER_ID,
      }),
    );

    expect(result.errors).toEqual([]);
    expect(result.recordsSynced).toBe(4);
    expect(spies.onConflictDoUpdate).toHaveBeenCalledTimes(3);
    expect(spies.values).toHaveBeenCalledWith(
      expect.objectContaining({
        date: "2026-02-06",
        providerId: "amazfit-zepp",
        userId: TEST_USER_ID,
        sourceName: "Zepp",
        steps: 8123,
        activeEnergyKcal: 410,
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
          activeEnergyKcal: 410,
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

  it("records malformed band days as sync errors and continues", async () => {
    await mockStoredZeppCredentials();

    const { db } = createMockDatabase();
    const fetchFn: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify({ code: 1, data: [{}] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const provider = new AmazfitZeppProvider(fetchFn);

    const result = await runWithTokenUser(TEST_USER_ID, () =>
      provider.sync(db, new Date("2026-02-01T00:00:00.000Z"), {
        userId: TEST_USER_ID,
      }),
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

    const result = await provider.sync(db, new Date("2026-02-01T00:00:00.000Z"), {
      userId: TEST_USER_ID,
    });

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

    const result = await provider.sync(db, new Date("2026-02-01T00:00:00.000Z"), {
      userId: TEST_USER_ID,
    });

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

    const result = await provider.sync(db, new Date("2026-02-01T00:00:00.000Z"), {
      userId: TEST_USER_ID,
    });

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

    await provider.sync(db, new Date("2026-02-01T00:00:00.000Z"), {
      userId: TEST_USER_ID,
    });

    expect(String(fetchFn.mock.calls[0]?.[0])).toContain("userid=zepp-user-42");
    expect(fetchFn.mock.calls[0]?.[1]?.headers).toMatchObject({
      apptoken: "my-app-token",
    });
  });

  it("records API errors from the sync request and reports them", async () => {
    await mockStoredZeppCredentials();

    const { db } = createMockDatabase();
    const fetchFn: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify({ code: 1002, message: "invalid token", data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const provider = new AmazfitZeppProvider(fetchFn);

    const result = await provider.sync(db, new Date("2026-02-01T00:00:00.000Z"), {
      userId: TEST_USER_ID,
    });

    expect(result.recordsSynced).toBe(0);
    expect(result.errors).toMatchObject([
      { message: "band_data: Amazfit/Zepp API error: invalid token" },
    ]);
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      tags: { provider: "amazfit-zepp", dataType: "band_data", phase: "sync" },
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
      provider.sync(db, new Date("2026-02-01T00:00:00.000Z"), {
        userId: TEST_USER_ID,
      }),
    ).rejects.toBeInstanceOf(ProviderRateLimitError);
    expect(captureException).not.toHaveBeenCalled();
  });
});
