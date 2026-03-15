import { afterEach, describe, expect, it } from "vitest";
import {
  type GarminActivitySummary,
  type GarminBodyComposition,
  GarminClient,
  type GarminDailySummary,
  GarminProvider,
  type GarminSleepSummary,
  garminOAuthConfig,
} from "./garmin.ts";

// ============================================================
// Extended coverage tests for the expanded Garmin provider.
// Focuses on paths NOT covered in garmin.test.ts,
// garmin-coverage.test.ts, or garmin-sync.test.ts:
//
// - GarminClient successful responses & query param construction
// - GarminProvider.validate() partial credential cases
// - GarminProvider.authSetup() exchangeCode rejection path
// - GarminProvider.authSetup() automatedLogin flow
// - GarminProvider.authSetup() internal-only mode dummy config
// - GarminClient sends correct Authorization header
// ============================================================

describe("GarminClient — successful API calls", () => {
  it("getActivities sends correct query params and returns parsed data", async () => {
    const activities: GarminActivitySummary[] = [
      {
        activityId: 111,
        activityName: "Run",
        activityType: "RUNNING",
        startTimeInSeconds: 1700000000,
        startTimeOffsetInSeconds: 0,
        durationInSeconds: 1800,
        distanceInMeters: 5000,
      },
    ];

    let capturedUrl = "";
    const mockFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      capturedUrl = input.toString();
      const headers = init?.headers as Record<string, string> | undefined;
      expect(headers?.Authorization).toBe("Bearer test-token-123");
      return Response.json(activities);
    }) as typeof globalThis.fetch;

    const client = new GarminClient("test-token-123", mockFetch);
    const result = await client.getActivities(1000, 2000);

    expect(result).toHaveLength(1);
    expect(result[0]?.activityId).toBe(111);
    expect(capturedUrl).toContain("uploadStartTimeInSeconds=1000");
    expect(capturedUrl).toContain("uploadEndTimeInSeconds=2000");
    expect(capturedUrl).toContain("/activities");
  });

  it("getSleep sends correct query params and returns parsed data", async () => {
    const sleepData: GarminSleepSummary[] = [
      {
        calendarDate: "2026-03-01",
        startTimeInSeconds: 1772100000,
        startTimeOffsetInSeconds: 0,
        durationInSeconds: 28800,
        deepSleepDurationInSeconds: 5400,
        lightSleepDurationInSeconds: 12600,
        remSleepInSeconds: 6300,
        awakeDurationInSeconds: 4500,
      },
    ];

    let capturedUrl = "";
    const mockFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      capturedUrl = input.toString();
      return Response.json(sleepData);
    }) as typeof globalThis.fetch;

    const client = new GarminClient("test-token-123", mockFetch);
    const result = await client.getSleep(5000, 6000);

    expect(result).toHaveLength(1);
    expect(result[0]?.calendarDate).toBe("2026-03-01");
    expect(capturedUrl).toContain("uploadStartTimeInSeconds=5000");
    expect(capturedUrl).toContain("uploadEndTimeInSeconds=6000");
    expect(capturedUrl).toContain("/sleep");
  });

  it("getDailySummaries sends correct query params", async () => {
    const dailies: GarminDailySummary[] = [
      {
        calendarDate: "2026-03-01",
        startTimeInSeconds: 1772100000,
        startTimeOffsetInSeconds: 0,
        durationInSeconds: 86400,
        steps: 10000,
        distanceInMeters: 8000,
        activeKilocalories: 500,
        bmrKilocalories: 1700,
      },
    ];

    let capturedUrl = "";
    const mockFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      capturedUrl = input.toString();
      return Response.json(dailies);
    }) as typeof globalThis.fetch;

    const client = new GarminClient("test-token-123", mockFetch);
    const result = await client.getDailySummaries(3000, 4000);

    expect(result).toHaveLength(1);
    expect(result[0]?.steps).toBe(10000);
    expect(capturedUrl).toContain("uploadStartTimeInSeconds=3000");
    expect(capturedUrl).toContain("uploadEndTimeInSeconds=4000");
    expect(capturedUrl).toContain("/dailies");
  });

  it("getBodyComposition sends correct query params", async () => {
    const bodyComp: GarminBodyComposition[] = [
      {
        measurementTimeInSeconds: 1772100000,
        weightInGrams: 80000,
        bmi: 24.5,
      },
    ];

    let capturedUrl = "";
    const mockFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      capturedUrl = input.toString();
      return Response.json(bodyComp);
    }) as typeof globalThis.fetch;

    const client = new GarminClient("test-token-123", mockFetch);
    const result = await client.getBodyComposition(7000, 8000);

    expect(result).toHaveLength(1);
    expect(result[0]?.weightInGrams).toBe(80000);
    expect(capturedUrl).toContain("uploadStartTimeInSeconds=7000");
    expect(capturedUrl).toContain("uploadEndTimeInSeconds=8000");
    expect(capturedUrl).toContain("/bodyComposition");
  });

  it("includes error body text in thrown error message", async () => {
    const mockFetch = (async (): Promise<Response> => {
      return new Response("Rate limit exceeded - try again later", { status: 429 });
    }) as typeof globalThis.fetch;

    const client = new GarminClient("token", mockFetch);
    await expect(client.getActivities(0, 1000)).rejects.toThrow(
      "Rate limit exceeded - try again later",
    );
  });
});

describe("GarminProvider.validate() — partial credentials", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns error when only GARMIN_USERNAME is set (no password)", () => {
    delete process.env.GARMIN_CLIENT_ID;
    process.env.GARMIN_USERNAME = "user@test.com";
    delete process.env.GARMIN_PASSWORD;
    const provider = new GarminProvider();
    const result = provider.validate();
    expect(result).not.toBeNull();
    expect(result).toContain("GARMIN_CLIENT_ID");
  });

  it("returns error when only GARMIN_PASSWORD is set (no username)", () => {
    delete process.env.GARMIN_CLIENT_ID;
    delete process.env.GARMIN_USERNAME;
    process.env.GARMIN_PASSWORD = "secret123";
    const provider = new GarminProvider();
    const result = provider.validate();
    expect(result).not.toBeNull();
  });

  it("returns null when both official API and credentials are set", () => {
    process.env.GARMIN_CLIENT_ID = "test-id";
    process.env.GARMIN_USERNAME = "user@test.com";
    process.env.GARMIN_PASSWORD = "pass123";
    const provider = new GarminProvider();
    expect(provider.validate()).toBeNull();
  });
});

describe("GarminProvider.authSetup() — exchangeCode rejection", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("exchangeCode rejects when GARMIN_CLIENT_ID is not set", async () => {
    delete process.env.GARMIN_CLIENT_ID;
    const provider = new GarminProvider();
    const setup = provider.authSetup();
    await expect(setup.exchangeCode("some-code", "some-verifier")).rejects.toThrow(
      "GARMIN_CLIENT_ID is required for OAuth flow",
    );
  });

  it("uses dummy OAuth config when GARMIN_CLIENT_ID is missing", () => {
    delete process.env.GARMIN_CLIENT_ID;
    const provider = new GarminProvider();
    const setup = provider.authSetup();
    expect(setup.oauthConfig.clientId).toBe("garmin-connect-internal");
    expect(setup.oauthConfig.authorizeUrl).toBe("");
    expect(setup.oauthConfig.tokenUrl).toBe("");
    expect(setup.oauthConfig.redirectUri).toBe("");
    expect(setup.oauthConfig.scopes).toEqual([]);
  });

  it("sets apiBaseUrl to Garmin Health API base", () => {
    process.env.GARMIN_CLIENT_ID = "test-id";
    const provider = new GarminProvider();
    const setup = provider.authSetup();
    expect(setup.apiBaseUrl).toBe("https://apis.garmin.com/wellness-api/rest");
  });

  it("always provides automatedLogin function", () => {
    process.env.GARMIN_CLIENT_ID = "test-id";
    const provider = new GarminProvider();
    const setup = provider.authSetup();
    expect(setup.automatedLogin).toBeTypeOf("function");
  });
});

describe("GarminProvider — provider identity", () => {
  it("has id 'garmin'", () => {
    const provider = new GarminProvider();
    expect(provider.id).toBe("garmin");
  });

  it("has name 'Garmin Connect'", () => {
    const provider = new GarminProvider();
    expect(provider.name).toBe("Garmin Connect");
  });
});

describe("GarminClient — constructor defaults", () => {
  it("accepts custom fetch function", async () => {
    let fetchCalled = false;
    const mockFetch = (async (): Promise<Response> => {
      fetchCalled = true;
      return Response.json([]);
    }) as typeof globalThis.fetch;

    const client = new GarminClient("token", mockFetch);
    await client.getActivities(0, 1000);
    expect(fetchCalled).toBe(true);
  });

  it("builds correct URL with base path for each endpoint", async () => {
    const capturedUrls: string[] = [];
    const mockFetch = (async (input: RequestInfo | URL): Promise<Response> => {
      capturedUrls.push(input.toString());
      return Response.json([]);
    }) as typeof globalThis.fetch;

    const client = new GarminClient("token", mockFetch);

    await client.getActivities(100, 200);
    await client.getSleep(100, 200);
    await client.getDailySummaries(100, 200);
    await client.getBodyComposition(100, 200);

    expect(capturedUrls[0]).toContain("https://apis.garmin.com/wellness-api/rest/activities");
    expect(capturedUrls[1]).toContain("https://apis.garmin.com/wellness-api/rest/sleep");
    expect(capturedUrls[2]).toContain("https://apis.garmin.com/wellness-api/rest/dailies");
    expect(capturedUrls[3]).toContain("https://apis.garmin.com/wellness-api/rest/bodyComposition");
  });
});

describe("GarminClient — error responses include status and body", () => {
  it("includes response body in error for 400 Bad Request", async () => {
    const mockFetch = (async (): Promise<Response> => {
      return new Response("Invalid date range parameter", { status: 400 });
    }) as typeof globalThis.fetch;

    const client = new GarminClient("token", mockFetch);
    await expect(client.getActivities(0, 1000)).rejects.toThrow("Garmin API error (400)");
    await expect(client.getActivities(0, 1000)).rejects.toThrow("Invalid date range parameter");
  });

  it("handles empty error body", async () => {
    const mockFetch = (async (): Promise<Response> => {
      return new Response("", { status: 503 });
    }) as typeof globalThis.fetch;

    const client = new GarminClient("token", mockFetch);
    await expect(client.getDailySummaries(0, 1000)).rejects.toThrow("Garmin API error (503)");
  });
});

describe("garminOAuthConfig — edge cases", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("sets authorizeUrl to Garmin Connect OAuth2 authorize endpoint", () => {
    process.env.GARMIN_CLIENT_ID = "test-id";
    const config = garminOAuthConfig();
    expect(config?.authorizeUrl).toBe("https://connect.garmin.com/oauth2/authorize");
  });

  it("sets tokenUrl to Garmin diauth token endpoint", () => {
    process.env.GARMIN_CLIENT_ID = "test-id";
    const config = garminOAuthConfig();
    expect(config?.tokenUrl).toBe("https://diauth.garmin.com/di-oauth2-service/oauth/token");
  });

  it("enables PKCE", () => {
    process.env.GARMIN_CLIENT_ID = "test-id";
    const config = garminOAuthConfig();
    expect(config?.usePkce).toBe(true);
  });

  it("returns empty scopes array", () => {
    process.env.GARMIN_CLIENT_ID = "test-id";
    const config = garminOAuthConfig();
    expect(config?.scopes).toEqual([]);
  });
});
