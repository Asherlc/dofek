import { afterEach, describe, expect, it } from "vitest";
import {
  OuraClient,
  type OuraDailyActivity,
  type OuraDailyReadiness,
  OuraProvider,
  type OuraSleepDocument,
  ouraOAuthConfig,
  parseOuraDailyMetrics,
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

const sampleReadiness: OuraDailyReadiness = {
  id: "readiness-abc123",
  day: "2026-03-01",
  score: 82,
  temperature_deviation: -0.15,
  temperature_trend_deviation: 0.05,
  contributors: {
    resting_heart_rate: 85,
    hrv_balance: 78,
    body_temperature: 90,
    recovery_index: 72,
    sleep_balance: 80,
    previous_night: 88,
    previous_day_activity: 75,
    activity_balance: 82,
  },
};

const sampleActivity: OuraDailyActivity = {
  id: "activity-abc123",
  day: "2026-03-01",
  steps: 9500,
  active_calories: 450,
  equivalent_walking_distance: 8200,
  high_activity_time: 2700, // 45 min in seconds
  medium_activity_time: 1800, // 30 min in seconds
  low_activity_time: 7200, // 120 min in seconds
  resting_time: 50400,
  sedentary_time: 28800,
  total_calories: 2300,
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

  describe("parseOuraDailyMetrics", () => {
    it("maps daily readiness and activity fields", () => {
      const result = parseOuraDailyMetrics(sampleReadiness, sampleActivity);

      expect(result.date).toBe("2026-03-01");
      expect(result.steps).toBe(9500);
      expect(result.activeEnergyKcal).toBe(450);
      expect(result.hrv).toBe(78);
      expect(result.restingHr).toBe(85);
      expect(result.exerciseMinutes).toBe(75);
      expect(result.skinTempC).toBe(-0.15);
    });

    it("handles null readiness", () => {
      const result = parseOuraDailyMetrics(null, sampleActivity);

      expect(result.steps).toBe(9500);
      expect(result.activeEnergyKcal).toBe(450);
      expect(result.hrv).toBeUndefined();
      expect(result.restingHr).toBeUndefined();
      expect(result.skinTempC).toBeUndefined();
    });

    it("handles null activity", () => {
      const result = parseOuraDailyMetrics(sampleReadiness, null);

      expect(result.steps).toBeUndefined();
      expect(result.activeEnergyKcal).toBeUndefined();
      expect(result.exerciseMinutes).toBeUndefined();
      expect(result.hrv).toBe(78);
      expect(result.restingHr).toBe(85);
    });

    it("handles null contributors in readiness", () => {
      const noContributors: OuraDailyReadiness = {
        ...sampleReadiness,
        contributors: {
          resting_heart_rate: null,
          hrv_balance: null,
          body_temperature: null,
          recovery_index: null,
          sleep_balance: null,
          previous_night: null,
          previous_day_activity: null,
          activity_balance: null,
        },
      };

      const result = parseOuraDailyMetrics(noContributors, sampleActivity);
      expect(result.hrv).toBeUndefined();
      expect(result.restingHr).toBeUndefined();
    });

    it("uses activity day when readiness is null", () => {
      const result = parseOuraDailyMetrics(null, sampleActivity);
      expect(result.date).toBe("2026-03-01");
    });

    it("returns empty date when both are null", () => {
      const result = parseOuraDailyMetrics(null, null);
      expect(result.date).toBe("");
    });

    it("rounds exercise minutes from seconds", () => {
      const activity: OuraDailyActivity = {
        ...sampleActivity,
        high_activity_time: 100, // 1.67 min
        medium_activity_time: 100, // 1.67 min
      };
      const result = parseOuraDailyMetrics(null, activity);
      expect(result.exerciseMinutes).toBe(3); // Math.round(200/60)
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

  it("uses custom OAUTH_REDIRECT_URI when set", () => {
    process.env.OURA_CLIENT_ID = "test-id";
    process.env.OURA_CLIENT_SECRET = "test-secret";
    process.env.OAUTH_REDIRECT_URI = "https://example.com/callback";
    const config = ouraOAuthConfig();
    expect(config?.redirectUri).toBe("https://example.com/callback");
  });

  it("uses default redirect URI when not set", () => {
    process.env.OURA_CLIENT_ID = "test-id";
    process.env.OURA_CLIENT_SECRET = "test-secret";
    delete process.env.OAUTH_REDIRECT_URI;
    const config = ouraOAuthConfig();
    expect(config?.redirectUri).toContain("localhost");
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

  it("returns null when personal access token is set", () => {
    delete process.env.OURA_CLIENT_ID;
    delete process.env.OURA_CLIENT_SECRET;
    process.env.OURA_PERSONAL_ACCESS_TOKEN = "test-pat";
    const provider = new OuraProvider();
    expect(provider.validate()).toBeNull();
  });

  it("returns error when OURA_CLIENT_ID is missing", () => {
    delete process.env.OURA_CLIENT_ID;
    delete process.env.OURA_CLIENT_SECRET;
    delete process.env.OURA_PERSONAL_ACCESS_TOKEN;
    const provider = new OuraProvider();
    expect(provider.validate()).toContain("OURA_CLIENT_ID");
  });

  it("returns error when OURA_CLIENT_SECRET is missing", () => {
    process.env.OURA_CLIENT_ID = "test-id";
    delete process.env.OURA_CLIENT_SECRET;
    delete process.env.OURA_PERSONAL_ACCESS_TOKEN;
    const provider = new OuraProvider();
    expect(provider.validate()).toContain("OURA_CLIENT_SECRET");
  });

  it("returns null when both OAuth vars are set", () => {
    process.env.OURA_CLIENT_ID = "test-id";
    process.env.OURA_CLIENT_SECRET = "test-secret";
    delete process.env.OURA_PERSONAL_ACCESS_TOKEN;
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

  it("throws on non-OK response for readiness", async () => {
    const mockFetch = (async (): Promise<Response> => {
      return new Response("Server Error", { status: 500 });
    }) as typeof globalThis.fetch;

    const client = new OuraClient("token", mockFetch);
    await expect(client.getDailyReadiness("2026-03-01", "2026-03-02")).rejects.toThrow(
      "Oura API error (500)",
    );
  });

  it("throws on non-OK response for activity", async () => {
    const mockFetch = (async (): Promise<Response> => {
      return new Response("Rate Limited", { status: 429 });
    }) as typeof globalThis.fetch;

    const client = new OuraClient("token", mockFetch);
    await expect(client.getDailyActivity("2026-03-01", "2026-03-02")).rejects.toThrow(
      "Oura API error (429)",
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

  it("fetches readiness data successfully", async () => {
    const mockFetch = (async (): Promise<Response> => {
      return Response.json({ data: [sampleReadiness], next_token: null });
    }) as typeof globalThis.fetch;

    const client = new OuraClient("test-token", mockFetch);
    const result = await client.getDailyReadiness("2026-03-01", "2026-03-02");

    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.score).toBe(82);
  });

  it("passes next_token for readiness pagination", async () => {
    let capturedUrl = "";
    const mockFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      capturedUrl = input.toString();
      return Response.json({ data: [], next_token: null });
    }) as typeof globalThis.fetch;

    const client = new OuraClient("test-token", mockFetch);
    await client.getDailyReadiness("2026-03-01", "2026-03-02", "nextpage");

    expect(capturedUrl).toContain("next_token=nextpage");
  });

  it("fetches activity data successfully", async () => {
    const mockFetch = (async (): Promise<Response> => {
      return Response.json({ data: [sampleActivity], next_token: null });
    }) as typeof globalThis.fetch;

    const client = new OuraClient("test-token", mockFetch);
    const result = await client.getDailyActivity("2026-03-01", "2026-03-02");

    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.steps).toBe(9500);
  });

  it("passes next_token for activity pagination", async () => {
    let capturedUrl = "";
    const mockFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      capturedUrl = input.toString();
      return Response.json({ data: [], next_token: null });
    }) as typeof globalThis.fetch;

    const client = new OuraClient("test-token", mockFetch);
    await client.getDailyActivity("2026-03-01", "2026-03-02", "actpage");

    expect(capturedUrl).toContain("next_token=actpage");
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
});
