import { afterEach, describe, expect, it } from "vitest";
import {
  mapOuraActivityType,
  OuraClient,
  type OuraDailySpO2,
  OuraProvider,
  type OuraSleepDocument,
  type OuraVO2Max,
  ouraOAuthConfig,
  parseOuraSleep,
} from "../oura.ts";

// ============================================================
// Sample API responses (Oura API v2 format)
// ============================================================

const sampleSleep: OuraSleepDocument = {
  id: "sleep-abc123",
  day: "2026-03-01",
  bedtime_start: "2026-02-28T22:30:00+00:00",
  bedtime_end: "2026-03-01T06:45:00+00:00",
  total_sleep_duration: 28800, // 480 min = 8h
  deep_sleep_duration: 5400, // 90 min
  rem_sleep_duration: 5700, // 95 min
  light_sleep_duration: 14400, // 240 min
  awake_time: 3300, // 55 min
  efficiency: 87,
  type: "long_sleep",
  average_heart_rate: 52,
  lowest_heart_rate: 45,
  average_hrv: 48,
  time_in_bed: 29700, // seconds
  readiness_score_delta: 2.5,
  latency: 900, // seconds
};

const sampleNap: OuraSleepDocument = {
  id: "sleep-nap456",
  day: "2026-03-01",
  bedtime_start: "2026-03-01T14:00:00+00:00",
  bedtime_end: "2026-03-01T14:30:00+00:00",
  total_sleep_duration: 1500,
  deep_sleep_duration: 0,
  rem_sleep_duration: 300,
  light_sleep_duration: 1200,
  awake_time: 300,
  efficiency: 80,
  type: "rest",
  average_heart_rate: 58,
  lowest_heart_rate: 52,
  average_hrv: 42,
  time_in_bed: 1800,
  readiness_score_delta: null,
  latency: 120,
};

const sampleSpO2: OuraDailySpO2 = {
  id: "spo2-abc123",
  day: "2026-03-01",
  spo2_percentage: { average: 97.5 },
  breathing_disturbance_index: 12,
};

const sampleVO2Max: OuraVO2Max = {
  id: "vo2max-abc123",
  day: "2026-03-01",
  timestamp: "2026-03-01T08:00:00",
  vo2_max: 42.5,
};

// ============================================================
// Parsing tests
// ============================================================

describe("Oura Provider", () => {
  describe("parseOuraSleep", () => {
    it("maps sleep fields correctly", () => {
      const result = parseOuraSleep(sampleSleep);

      expect(result.externalId).toBe("sleep-abc123");
      expect(result.startedAt).toEqual(new Date("2026-02-28T22:30:00+00:00"));
      expect(result.endedAt).toEqual(new Date("2026-03-01T06:45:00+00:00"));
      expect(result.durationMinutes).toBe(480);
      expect(result.deepMinutes).toBe(90);
      expect(result.remMinutes).toBe(95);
      expect(result.lightMinutes).toBe(240);
      expect(result.awakeMinutes).toBe(55);
      expect(result.efficiencyPct).toBe(87);
      expect(result.isNap).toBe(false);
    });

    it("identifies naps from rest type", () => {
      const result = parseOuraSleep(sampleNap);

      expect(result.isNap).toBe(true);
      expect(result.durationMinutes).toBe(25);
      expect(result.lightMinutes).toBe(20);
    });

    it("identifies late_nap as nap", () => {
      const lateNap: OuraSleepDocument = { ...sampleSleep, type: "late_nap" };
      const result = parseOuraSleep(lateNap);
      expect(result.isNap).toBe(true);
    });

    it("identifies sleep type as non-nap", () => {
      const sleepType: OuraSleepDocument = { ...sampleSleep, type: "sleep" };
      const result = parseOuraSleep(sleepType);
      expect(result.isNap).toBe(false);
    });

    it("handles missing optional duration fields", () => {
      const minimal: OuraSleepDocument = {
        ...sampleSleep,
        total_sleep_duration: null,
        deep_sleep_duration: null,
        rem_sleep_duration: null,
        light_sleep_duration: null,
        awake_time: null,
      };

      const result = parseOuraSleep(minimal);

      expect(result.deepMinutes).toBeUndefined();
      expect(result.remMinutes).toBeUndefined();
      expect(result.lightMinutes).toBeUndefined();
      expect(result.awakeMinutes).toBeUndefined();
      expect(result.durationMinutes).toBeUndefined();
    });

    it("rounds seconds to nearest minute", () => {
      const oddDurations: OuraSleepDocument = {
        ...sampleSleep,
        total_sleep_duration: 1850, // 30.83 min → 31
        deep_sleep_duration: 95, // 1.58 min → 2
      };
      const result = parseOuraSleep(oddDurations);
      expect(result.durationMinutes).toBe(31);
      expect(result.deepMinutes).toBe(2);
    });
  });
});

// ============================================================
// OAuth config tests
// ============================================================

describe("ouraOAuthConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns null when OURA_CLIENT_ID is not set", () => {
    delete process.env.OURA_CLIENT_ID;
    delete process.env.OURA_CLIENT_SECRET;
    expect(ouraOAuthConfig()).toBeNull();
  });

  it("returns null when OURA_CLIENT_SECRET is not set", () => {
    process.env.OURA_CLIENT_ID = "test-id";
    delete process.env.OURA_CLIENT_SECRET;
    expect(ouraOAuthConfig()).toBeNull();
  });

  it("returns config when both env vars are set", () => {
    process.env.OURA_CLIENT_ID = "test-id";
    process.env.OURA_CLIENT_SECRET = "test-secret";
    const config = ouraOAuthConfig();
    expect(config).not.toBeNull();
    expect(config?.clientId).toBe("test-id");
    expect(config?.clientSecret).toBe("test-secret");
    expect(config?.scopes).toContain("daily");
    expect(config?.authorizeUrl).toContain("cloud.ouraring.com");
    expect(config?.tokenUrl).toContain("api.ouraring.com");
  });

  it("uses custom OAUTH_REDIRECT_URI_unencrypted when set", () => {
    process.env.OURA_CLIENT_ID = "test-id";
    process.env.OURA_CLIENT_SECRET = "test-secret";
    process.env.OAUTH_REDIRECT_URI_unencrypted = "https://example.com/callback";
    const config = ouraOAuthConfig();
    expect(config?.redirectUri).toBe("https://example.com/callback");
  });

  it("uses default redirect URI when not set", () => {
    process.env.OURA_CLIENT_ID = "test-id";
    process.env.OURA_CLIENT_SECRET = "test-secret";
    delete process.env.OAUTH_REDIRECT_URI_unencrypted;
    const config = ouraOAuthConfig();
    expect(config?.redirectUri).toContain("dofek");
  });
});

// ============================================================
// Provider validate/authSetup tests
// ============================================================

describe("OuraProvider.validate()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns error when OURA_CLIENT_ID is missing", () => {
    delete process.env.OURA_CLIENT_ID;
    delete process.env.OURA_CLIENT_SECRET;
    const provider = new OuraProvider();
    expect(provider.validate()).toContain("OURA_CLIENT_ID");
  });

  it("returns error when OURA_CLIENT_SECRET is missing", () => {
    process.env.OURA_CLIENT_ID = "test-id";
    delete process.env.OURA_CLIENT_SECRET;
    const provider = new OuraProvider();
    expect(provider.validate()).toContain("OURA_CLIENT_SECRET");
  });

  it("returns null when both OAuth vars are set", () => {
    process.env.OURA_CLIENT_ID = "test-id";
    process.env.OURA_CLIENT_SECRET = "test-secret";
    const provider = new OuraProvider();
    expect(provider.validate()).toBeNull();
  });
});

describe("OuraProvider.authSetup()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns auth setup with OAuth config", () => {
    process.env.OURA_CLIENT_ID = "test-id";
    process.env.OURA_CLIENT_SECRET = "test-secret";
    const provider = new OuraProvider();
    const setup = provider.authSetup();
    expect(setup.oauthConfig.clientId).toBe("test-id");
    expect(setup.exchangeCode).toBeTypeOf("function");
    expect(setup.apiBaseUrl).toContain("ouraring.com");
  });

  it("throws when env vars are missing", () => {
    delete process.env.OURA_CLIENT_ID;
    delete process.env.OURA_CLIENT_SECRET;
    const provider = new OuraProvider();
    expect(() => provider.authSetup()).toThrow("OURA_CLIENT_ID");
  });
});

describe("OuraProvider properties", () => {
  it("has correct id and name", () => {
    const provider = new OuraProvider();
    expect(provider.id).toBe("oura");
    expect(provider.name).toBe("Oura");
  });
});

// ============================================================
// OuraClient tests
// ============================================================

describe("OuraClient", () => {
  it("throws on non-OK response for sleep", async () => {
    const mockFetch = (async (): Promise<Response> => {
      return new Response("Unauthorized", { status: 401 });
    }) as typeof globalThis.fetch;

    const client = new OuraClient("bad-token", mockFetch);
    await expect(client.getSleep("2026-03-01", "2026-03-02")).rejects.toThrow(
      "Oura API error (401)",
    );
  });

  it("fetches sleep data with correct URL", async () => {
    let capturedUrl = "";
    const mockFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      capturedUrl = input.toString();
      return Response.json({ data: [sampleSleep], next_token: null });
    }) as typeof globalThis.fetch;

    const client = new OuraClient("test-token", mockFetch);
    const result = await client.getSleep("2026-03-01", "2026-03-02");

    expect(capturedUrl).toContain("/v2/usercollection/sleep");
    expect(capturedUrl).toContain("start_date=2026-03-01");
    expect(capturedUrl).toContain("end_date=2026-03-02");
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.id).toBe("sleep-abc123");
  });

  it("passes next_token for pagination", async () => {
    let capturedUrl = "";
    const mockFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      capturedUrl = input.toString();
      return Response.json({ data: [], next_token: null });
    }) as typeof globalThis.fetch;

    const client = new OuraClient("test-token", mockFetch);
    await client.getSleep("2026-03-01", "2026-03-02", "page2token");

    expect(capturedUrl).toContain("next_token=page2token");
  });

  it("sends Authorization header with Bearer token", async () => {
    let capturedHeaders: Record<string, string> = {};
    const mockFetch = (async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      capturedHeaders = Object.fromEntries(Object.entries(init?.headers ?? {})) as Record<
        string,
        string
      >;
      return Response.json({ data: [], next_token: null });
    }) as typeof globalThis.fetch;

    const client = new OuraClient("my-secret-token", mockFetch);
    await client.getSleep("2026-03-01", "2026-03-02");

    expect(capturedHeaders.Authorization).toBe("Bearer my-secret-token");
  });

  it("includes error response body in error message", async () => {
    const mockFetch = (async (): Promise<Response> => {
      return new Response("Invalid API key provided", { status: 403 });
    }) as typeof globalThis.fetch;

    const client = new OuraClient("bad-token", mockFetch);
    await expect(client.getSleep("2026-03-01", "2026-03-02")).rejects.toThrow(
      "Invalid API key provided",
    );
  });

  it("fetches daily SpO2 data successfully", async () => {
    let capturedUrl = "";
    const mockFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      capturedUrl = input.toString();
      return Response.json({ data: [sampleSpO2], next_token: null });
    }) as typeof globalThis.fetch;

    const client = new OuraClient("test-token", mockFetch);
    const result = await client.getDailySpO2("2026-03-01", "2026-03-02");

    expect(capturedUrl).toContain("/v2/usercollection/daily_spo2");
    expect(capturedUrl).toContain("start_date=2026-03-01");
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.spo2_percentage?.average).toBe(97.5);
  });

  it("passes next_token for SpO2 pagination", async () => {
    let capturedUrl = "";
    const mockFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      capturedUrl = input.toString();
      return Response.json({ data: [], next_token: null });
    }) as typeof globalThis.fetch;

    const client = new OuraClient("test-token", mockFetch);
    await client.getDailySpO2("2026-03-01", "2026-03-02", "spo2page");

    expect(capturedUrl).toContain("next_token=spo2page");
  });

  it("throws on non-OK response for SpO2", async () => {
    const mockFetch = (async (): Promise<Response> => {
      return new Response("Forbidden", { status: 403 });
    }) as typeof globalThis.fetch;

    const client = new OuraClient("token", mockFetch);
    await expect(client.getDailySpO2("2026-03-01", "2026-03-02")).rejects.toThrow(
      "Oura API error (403)",
    );
  });

  it("fetches VO2 max data successfully", async () => {
    let capturedUrl = "";
    const mockFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      capturedUrl = input.toString();
      return Response.json({ data: [sampleVO2Max], next_token: null });
    }) as typeof globalThis.fetch;

    const client = new OuraClient("test-token", mockFetch);
    const result = await client.getVO2Max("2026-03-01", "2026-03-02");

    expect(capturedUrl).toContain("/v2/usercollection/vO2_max");
    expect(capturedUrl).toContain("start_date=2026-03-01");
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.vo2_max).toBe(42.5);
  });

  it("passes next_token for VO2 max pagination", async () => {
    let capturedUrl = "";
    const mockFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      capturedUrl = input.toString();
      return Response.json({ data: [], next_token: null });
    }) as typeof globalThis.fetch;

    const client = new OuraClient("test-token", mockFetch);
    await client.getVO2Max("2026-03-01", "2026-03-02", "vo2page");

    expect(capturedUrl).toContain("next_token=vo2page");
  });

  it("throws on non-OK response for VO2 max", async () => {
    const mockFetch = (async (): Promise<Response> => {
      return new Response("Server Error", { status: 500 });
    }) as typeof globalThis.fetch;

    const client = new OuraClient("token", mockFetch);
    await expect(client.getVO2Max("2026-03-01", "2026-03-02")).rejects.toThrow(
      "Oura API error (500)",
    );
  });

  it("fetches workouts with correct URL", async () => {
    let capturedUrl = "";
    const mockFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      capturedUrl = input.toString();
      return Response.json({ data: [], next_token: null });
    }) as typeof globalThis.fetch;

    const client = new OuraClient("test-token", mockFetch);
    await client.getWorkouts("2026-03-01", "2026-03-02");
    expect(capturedUrl).toContain("/v2/usercollection/workout");
    expect(capturedUrl).toContain("start_date=2026-03-01");
  });

  it("fetches heart rate with datetime params", async () => {
    let capturedUrl = "";
    const mockFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      capturedUrl = input.toString();
      return Response.json({ data: [] });
    }) as typeof globalThis.fetch;

    const client = new OuraClient("test-token", mockFetch);
    await client.getHeartRate("2026-03-01", "2026-03-02");
    expect(capturedUrl).toContain("/v2/usercollection/heartrate");
    expect(capturedUrl).toContain("start_datetime=2026-03-01T00:00:00");
    expect(capturedUrl).toContain("end_datetime=2026-03-02T23:59:59");
  });

  it("fetches sessions with correct URL", async () => {
    let capturedUrl = "";
    const mockFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      capturedUrl = input.toString();
      return Response.json({ data: [], next_token: null });
    }) as typeof globalThis.fetch;

    const client = new OuraClient("test-token", mockFetch);
    await client.getSessions("2026-03-01", "2026-03-02");
    expect(capturedUrl).toContain("/v2/usercollection/session");
  });

  it("fetches daily stress with correct URL", async () => {
    let capturedUrl = "";
    const mockFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      capturedUrl = input.toString();
      return Response.json({ data: [], next_token: null });
    }) as typeof globalThis.fetch;

    const client = new OuraClient("test-token", mockFetch);
    await client.getDailyStress("2026-03-01", "2026-03-02");
    expect(capturedUrl).toContain("/v2/usercollection/daily_stress");
  });

  it("fetches daily resilience with correct URL", async () => {
    let capturedUrl = "";
    const mockFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      capturedUrl = input.toString();
      return Response.json({ data: [], next_token: null });
    }) as typeof globalThis.fetch;

    const client = new OuraClient("test-token", mockFetch);
    await client.getDailyResilience("2026-03-01", "2026-03-02");
    expect(capturedUrl).toContain("/v2/usercollection/daily_resilience");
  });

  it("fetches cardiovascular age with correct URL", async () => {
    let capturedUrl = "";
    const mockFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      capturedUrl = input.toString();
      return Response.json({ data: [], next_token: null });
    }) as typeof globalThis.fetch;

    const client = new OuraClient("test-token", mockFetch);
    await client.getDailyCardiovascularAge("2026-03-01", "2026-03-02");
    expect(capturedUrl).toContain("/v2/usercollection/daily_cardiovascular_age");
  });

  it("fetches tags with correct URL", async () => {
    let capturedUrl = "";
    const mockFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      capturedUrl = input.toString();
      return Response.json({ data: [], next_token: null });
    }) as typeof globalThis.fetch;

    const client = new OuraClient("test-token", mockFetch);
    await client.getTags("2026-03-01", "2026-03-02");
    expect(capturedUrl).toContain("/v2/usercollection/tag");
  });

  it("fetches enhanced tags with correct URL", async () => {
    let capturedUrl = "";
    const mockFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      capturedUrl = input.toString();
      return Response.json({ data: [], next_token: null });
    }) as typeof globalThis.fetch;

    const client = new OuraClient("test-token", mockFetch);
    await client.getEnhancedTags("2026-03-01", "2026-03-02");
    expect(capturedUrl).toContain("/v2/usercollection/enhanced_tag");
  });

  it("fetches rest mode periods with correct URL", async () => {
    let capturedUrl = "";
    const mockFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      capturedUrl = input.toString();
      return Response.json({ data: [], next_token: null });
    }) as typeof globalThis.fetch;

    const client = new OuraClient("test-token", mockFetch);
    await client.getRestModePeriods("2026-03-01", "2026-03-02");
    expect(capturedUrl).toContain("/v2/usercollection/rest_mode_period");
  });

  it("fetches sleep time with correct URL", async () => {
    let capturedUrl = "";
    const mockFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      capturedUrl = input.toString();
      return Response.json({ data: [], next_token: null });
    }) as typeof globalThis.fetch;

    const client = new OuraClient("test-token", mockFetch);
    await client.getSleepTime("2026-03-01", "2026-03-02");
    expect(capturedUrl).toContain("/v2/usercollection/sleep_time");
  });
});

// ============================================================
// Activity type mapping tests
// ============================================================

describe("mapOuraActivityType", () => {
  it("maps known activity types", () => {
    expect(mapOuraActivityType("walking")).toBe("walking");
    expect(mapOuraActivityType("running")).toBe("running");
    expect(mapOuraActivityType("cycling")).toBe("cycling");
    expect(mapOuraActivityType("swimming")).toBe("swimming");
    expect(mapOuraActivityType("strength_training")).toBe("strength");
  });

  it("handles case-insensitive input", () => {
    expect(mapOuraActivityType("Walking")).toBe("walking");
    expect(mapOuraActivityType("RUNNING")).toBe("running");
  });

  it("passes through unknown types lowercase", () => {
    expect(mapOuraActivityType("kickboxing")).toBe("kickboxing");
    expect(mapOuraActivityType("CrossFit")).toBe("crossfit");
  });
});
