import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AmazfitZeppClient,
  AmazfitZeppProvider,
  decodeZeppHeartRateSamples,
  decodeZeppSummary,
  parseZeppBandDay,
} from "./amazfit-zepp.ts";

function encodeBase64(value: string | Buffer): string {
  return Buffer.from(value).toString("base64");
}

describe("Amazfit/Zepp provider", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("requires app token and user id configuration", () => {
    const provider = new AmazfitZeppProvider();

    expect(provider.validate()).toBe("ZEPP_APP_TOKEN is not set");

    vi.stubEnv("ZEPP_APP_TOKEN", "token-123");
    expect(provider.validate()).toBe("ZEPP_USER_ID is not set");

    vi.stubEnv("ZEPP_USER_ID", "user-123");
    expect(provider.validate()).toBeNull();
  });

  it("decodes base64 summary payloads", () => {
    const summary = decodeZeppSummary(
      encodeBase64(JSON.stringify({ stp: { ttl: 8123, dis: 6400 }, slp: { dp: 80, lt: 320 } })),
    );

    expect(summary.stp?.ttl).toBe(8123);
    expect(summary.slp?.dp).toBe(80);
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
      externalId: "zepp-sleep-2026-02-06",
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
});
