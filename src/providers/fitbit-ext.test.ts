import { afterEach, describe, expect, it } from "vitest";
import { ZodError } from "zod";
import {
  FitbitClient,
  FitbitProvider,
  fitbitOAuthConfig,
  mapFitbitActivityType,
} from "./fitbit/index.ts";

// ============================================================
// Extended Fitbit tests covering:
// - FitbitClient API calls and error handling
// - fitbitOAuthConfig with/without env vars
// - FitbitProvider validate/authSetup
// - Additional mapFitbitActivityType patterns
// ============================================================

describe("FitbitClient — API calls", () => {
  it("getActivities sends correct URL with afterDate and offset", async () => {
    let capturedUrl = "";
    const mockFetch: typeof globalThis.fetch = async (input: RequestInfo | URL) => {
      capturedUrl = input.toString();
      return Response.json({
        activities: [],
        pagination: { next: "", previous: "", limit: 20, offset: 0, sort: "asc" },
      });
    };

    const client = new FitbitClient("test-token", mockFetch);
    await client.getActivities("2026-03-01", 10);

    expect(capturedUrl).toContain("/1/user/-/activities/list.json");
    expect(capturedUrl).toContain("afterDate=2026-03-01");
    expect(capturedUrl).toContain("offset=10");
    expect(capturedUrl).toContain("sort=asc");
    expect(capturedUrl).toContain("limit=20");
  });

  it("getSleepLogs sends correct URL", async () => {
    let capturedUrl = "";
    const mockFetch: typeof globalThis.fetch = async (input: RequestInfo | URL) => {
      capturedUrl = input.toString();
      return Response.json({
        sleep: [],
        pagination: { next: "", previous: "", limit: 20, offset: 0, sort: "asc" },
      });
    };

    const client = new FitbitClient("test-token", mockFetch);
    await client.getSleepLogs("2026-03-01", 5);

    expect(capturedUrl).toContain("/1.2/user/-/sleep/list.json");
    expect(capturedUrl).toContain("afterDate=2026-03-01");
    expect(capturedUrl).toContain("offset=5");
  });

  it("getDailySummary sends correct URL with date", async () => {
    let capturedUrl = "";
    const mockFetch: typeof globalThis.fetch = async (input: RequestInfo | URL) => {
      capturedUrl = input.toString();
      return Response.json({
        summary: {
          steps: 0,
          caloriesOut: 0,
          activeScore: 0,
          activityCalories: 0,
          distances: [],
          fairlyActiveMinutes: 0,
          veryActiveMinutes: 0,
          lightlyActiveMinutes: 0,
          sedentaryMinutes: 0,
        },
      });
    };

    const client = new FitbitClient("test-token", mockFetch);
    await client.getDailySummary("2026-03-15");

    expect(capturedUrl).toContain("/1/user/-/activities/date/2026-03-15.json");
  });

  it("getWeightLogs sends correct URL", async () => {
    let capturedUrl = "";
    const mockFetch: typeof globalThis.fetch = async (input: RequestInfo | URL) => {
      capturedUrl = input.toString();
      return Response.json({ weight: [] });
    };

    const client = new FitbitClient("test-token", mockFetch);
    await client.getWeightLogs("2026-03-01");

    expect(capturedUrl).toContain("/1/user/-/body/log/weight/date/2026-03-01/30d.json");
  });

  it("sends Authorization header with Bearer token", async () => {
    let capturedHeaders: Record<string, string> = {};
    const mockFetch: typeof globalThis.fetch = async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      capturedHeaders = Object.fromEntries(Object.entries(init?.headers ?? {}));
      return Response.json({
        activities: [],
        pagination: { next: "", previous: "", limit: 20, offset: 0, sort: "asc" },
      });
    };

    const client = new FitbitClient("my-secret-token", mockFetch);
    await client.getActivities("2026-03-01");

    expect(capturedHeaders.Authorization).toBe("Bearer my-secret-token");
  });

  it("throws on non-OK response", async () => {
    const mockFetch: typeof globalThis.fetch = async () => {
      return new Response("Unauthorized", { status: 401 });
    };

    const client = new FitbitClient("bad-token", mockFetch);
    await expect(client.getActivities("2026-03-01")).rejects.toThrow("API error 401");
  });

  it("includes response body in error message", async () => {
    const mockFetch: typeof globalThis.fetch = async () => {
      return new Response("Rate limit exceeded", { status: 429 });
    };

    const client = new FitbitClient("token", mockFetch);
    await expect(client.getWeightLogs("2026-03-01")).rejects.toThrow("Rate limit exceeded");
  });

  it("uses default offset of 0 for getActivities", async () => {
    let capturedUrl = "";
    const mockFetch: typeof globalThis.fetch = async (input: RequestInfo | URL) => {
      capturedUrl = input.toString();
      return Response.json({
        activities: [],
        pagination: { next: "", previous: "", limit: 20, offset: 0, sort: "asc" },
      });
    };

    const client = new FitbitClient("test-token", mockFetch);
    await client.getActivities("2026-03-01");

    expect(capturedUrl).toContain("offset=0");
  });
});

describe("fitbitOAuthConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns null when FITBIT_CLIENT_ID is not set", () => {
    delete process.env.FITBIT_CLIENT_ID;
    delete process.env.FITBIT_CLIENT_SECRET;
    expect(fitbitOAuthConfig()).toBeNull();
  });

  it("returns null when FITBIT_CLIENT_SECRET is not set", () => {
    process.env.FITBIT_CLIENT_ID = "test-id";
    delete process.env.FITBIT_CLIENT_SECRET;
    expect(fitbitOAuthConfig()).toBeNull();
  });

  it("returns config when both env vars are set", () => {
    process.env.FITBIT_CLIENT_ID = "test-id";
    process.env.FITBIT_CLIENT_SECRET = "test-secret";
    const config = fitbitOAuthConfig();
    expect(config).not.toBeNull();
    expect(config?.clientId).toBe("test-id");
    expect(config?.clientSecret).toBe("test-secret");
    expect(config?.usePkce).toBe(true);
    expect(config?.scopes).toContain("activity");
    expect(config?.scopes).toContain("sleep");
    expect(config?.scopes).toContain("weight");
    expect(config?.scopes).toContain("heartrate");
    expect(config?.authorizeUrl).toContain("fitbit.com");
    expect(config?.tokenUrl).toContain("fitbit.com");
  });
});

describe("FitbitProvider — validate", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("has correct id and name", () => {
    const provider = new FitbitProvider();
    expect(provider.id).toBe("fitbit");
    expect(provider.name).toBe("Fitbit");
  });

  it("returns error when FITBIT_CLIENT_ID is missing", () => {
    delete process.env.FITBIT_CLIENT_ID;
    delete process.env.FITBIT_CLIENT_SECRET;
    const provider = new FitbitProvider();
    expect(provider.validate()).toContain("FITBIT_CLIENT_ID");
  });

  it("returns error when FITBIT_CLIENT_SECRET is missing", () => {
    process.env.FITBIT_CLIENT_ID = "test-id";
    delete process.env.FITBIT_CLIENT_SECRET;
    const provider = new FitbitProvider();
    expect(provider.validate()).toContain("FITBIT_CLIENT_SECRET");
  });

  it("returns null when both env vars are set", () => {
    process.env.FITBIT_CLIENT_ID = "test-id";
    process.env.FITBIT_CLIENT_SECRET = "test-secret";
    const provider = new FitbitProvider();
    expect(provider.validate()).toBeNull();
  });
});

describe("FitbitProvider — authSetup", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns auth setup with OAuth config", () => {
    process.env.FITBIT_CLIENT_ID = "test-id";
    process.env.FITBIT_CLIENT_SECRET = "test-secret";
    const provider = new FitbitProvider();
    const setup = provider.authSetup();
    expect(setup.oauthConfig.clientId).toBe("test-id");
    expect(setup.exchangeCode).toBeTypeOf("function");
    expect(setup.authUrl).toBeDefined();
    expect(setup.apiBaseUrl).toContain("fitbit.com");
    expect(setup.getUserIdentity).toBeTypeOf("function");
  });

  it("throws when env vars are missing", () => {
    delete process.env.FITBIT_CLIENT_ID;
    delete process.env.FITBIT_CLIENT_SECRET;
    const provider = new FitbitProvider();
    expect(() => provider.authSetup()).toThrow("FITBIT_CLIENT_ID");
  });
});

describe("FitbitClient — Zod runtime validation", () => {
  it("rejects an activity response with invalid shape", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return Response.json({ activities: "not-an-array" });
    };

    const client = new FitbitClient("token", mockFetch);
    await expect(client.getActivities("2026-03-01")).rejects.toThrow(ZodError);
  });

  it("rejects a sleep response with missing pagination", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return Response.json({ sleep: [] });
    };

    const client = new FitbitClient("token", mockFetch);
    await expect(client.getSleepLogs("2026-03-01")).rejects.toThrow(ZodError);
  });

  it("validates and returns a correct weight response", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> => {
      return Response.json({
        weight: [{ logId: 1, weight: 80.0, bmi: 24.0, date: "2026-03-01", time: "08:00:00" }],
      });
    };

    const client = new FitbitClient("token", mockFetch);
    const result = await client.getWeightLogs("2026-03-01");
    expect(result.weight).toHaveLength(1);
    expect(result.weight[0]?.weight).toBe(80.0);
  });
});

describe("mapFitbitActivityType — additional patterns", () => {
  it("maps rowing activities", () => {
    expect(mapFitbitActivityType("Rowing", 15000)).toBe("rowing");
    expect(mapFitbitActivityType("Row Machine", 15000)).toBe("rowing");
  });

  it("maps cycling with Spinning keyword", () => {
    expect(mapFitbitActivityType("Spinning Class", 15000)).toBe("cycling");
  });
});
