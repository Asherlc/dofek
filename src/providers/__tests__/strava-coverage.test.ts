import { afterEach, describe, expect, it } from "vitest";
import {
  StravaClient,
  StravaProvider,
  StravaRateLimitError,
  type StravaStreamSet,
  stravaOAuthConfig,
  stravaStreamsToMetricStream,
} from "../strava.ts";

// ============================================================
// Coverage tests for uncovered Strava paths:
// - stravaOAuthConfig() with/without env vars
// - StravaProvider.validate()
// - StravaProvider.authSetup()
// - StravaClient error handling (rate limit, API errors)
// - stravaStreamsToMetricStream with empty time data
// ============================================================

describe("stravaOAuthConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns null when STRAVA_CLIENT_ID is not set", () => {
    delete process.env.STRAVA_CLIENT_ID;
    delete process.env.STRAVA_CLIENT_SECRET;
    expect(stravaOAuthConfig()).toBeNull();
  });

  it("returns null when STRAVA_CLIENT_SECRET is not set", () => {
    process.env.STRAVA_CLIENT_ID = "test-id";
    delete process.env.STRAVA_CLIENT_SECRET;
    expect(stravaOAuthConfig()).toBeNull();
  });

  it("returns config when both env vars are set", () => {
    process.env.STRAVA_CLIENT_ID = "test-id";
    process.env.STRAVA_CLIENT_SECRET = "test-secret";
    const config = stravaOAuthConfig();
    expect(config).not.toBeNull();
    expect(config?.clientId).toBe("test-id");
    expect(config?.clientSecret).toBe("test-secret");
    expect(config?.scopes).toContain("activity:read_all");
    expect(config?.scopeSeparator).toBe(",");
  });

  it("uses custom OAUTH_REDIRECT_URI when set", () => {
    process.env.STRAVA_CLIENT_ID = "test-id";
    process.env.STRAVA_CLIENT_SECRET = "test-secret";
    process.env.OAUTH_REDIRECT_URI = "https://example.com/callback";
    const config = stravaOAuthConfig();
    expect(config?.redirectUri).toBe("https://example.com/callback");
  });

  it("uses default redirect URI when OAUTH_REDIRECT_URI is not set", () => {
    process.env.STRAVA_CLIENT_ID = "test-id";
    process.env.STRAVA_CLIENT_SECRET = "test-secret";
    delete process.env.OAUTH_REDIRECT_URI;
    const config = stravaOAuthConfig();
    expect(config?.redirectUri).toContain("localhost");
  });
});

describe("StravaProvider.validate()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns error when STRAVA_CLIENT_ID is missing", () => {
    delete process.env.STRAVA_CLIENT_ID;
    delete process.env.STRAVA_CLIENT_SECRET;
    const provider = new StravaProvider();
    expect(provider.validate()).toContain("STRAVA_CLIENT_ID");
  });

  it("returns error when STRAVA_CLIENT_SECRET is missing", () => {
    process.env.STRAVA_CLIENT_ID = "test-id";
    delete process.env.STRAVA_CLIENT_SECRET;
    const provider = new StravaProvider();
    expect(provider.validate()).toContain("STRAVA_CLIENT_SECRET");
  });

  it("returns null when both are set", () => {
    process.env.STRAVA_CLIENT_ID = "test-id";
    process.env.STRAVA_CLIENT_SECRET = "test-secret";
    const provider = new StravaProvider();
    expect(provider.validate()).toBeNull();
  });
});

describe("StravaProvider.authSetup()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns auth setup with OAuth config", () => {
    process.env.STRAVA_CLIENT_ID = "test-id";
    process.env.STRAVA_CLIENT_SECRET = "test-secret";
    const provider = new StravaProvider();
    const setup = provider.authSetup();
    expect(setup.oauthConfig.clientId).toBe("test-id");
    expect(setup.exchangeCode).toBeTypeOf("function");
    expect(setup.apiBaseUrl).toContain("strava.com");
  });

  it("throws when env vars are missing", () => {
    delete process.env.STRAVA_CLIENT_ID;
    delete process.env.STRAVA_CLIENT_SECRET;
    const provider = new StravaProvider();
    expect(() => provider.authSetup()).toThrow("STRAVA_CLIENT_ID");
  });
});

describe("StravaClient — error handling", () => {
  it("throws StravaRateLimitError on 429", async () => {
    const mockFetch = (async (): Promise<Response> => {
      return new Response("Rate Limit Exceeded", { status: 429 });
    }) as typeof globalThis.fetch;

    const client = new StravaClient("token", mockFetch);
    await expect(client.getActivities(0)).rejects.toBeInstanceOf(StravaRateLimitError);
  });

  it("throws generic error on non-OK, non-429 response", async () => {
    const mockFetch = (async (): Promise<Response> => {
      return new Response("Server Error", { status: 500 });
    }) as typeof globalThis.fetch;

    const client = new StravaClient("token", mockFetch);
    await expect(client.getActivities(0)).rejects.toThrow("Strava API error (500): Server Error");
  });

  it("shows clean message for HTML error responses instead of dumping HTML", async () => {
    const mockFetch = (async (): Promise<Response> => {
      return new Response("<html><body>Not Found</body></html>", {
        status: 404,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }) as typeof globalThis.fetch;

    const client = new StravaClient("token", mockFetch);
    await expect(client.getActivities(0)).rejects.toThrow(
      "Strava API error (404): (HTML error page)",
    );
  });

  it("includes JSON body for JSON error responses", async () => {
    const mockFetch = (async (): Promise<Response> => {
      return new Response(JSON.stringify({ message: "Not Found", errors: [] }), {
        status: 404,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }) as typeof globalThis.fetch;

    const client = new StravaClient("token", mockFetch);
    await expect(client.getActivities(0)).rejects.toThrow(
      'Strava API error (404): {"message":"Not Found","errors":[]}',
    );
  });

  it("truncates long plain-text error responses", async () => {
    const longText = "x".repeat(300);
    const mockFetch = (async (): Promise<Response> => {
      return new Response(longText, { status: 500 });
    }) as typeof globalThis.fetch;

    const client = new StravaClient("token", mockFetch);
    await expect(client.getActivities(0)).rejects.toThrow(
      `Strava API error (500): ${"x".repeat(200)}…`,
    );
  });
});

describe("StravaRateLimitError", () => {
  it("has correct name and message", () => {
    const error = new StravaRateLimitError("Rate limited");
    expect(error.name).toBe("StravaRateLimitError");
    expect(error.message).toBe("Rate limited");
    expect(error).toBeInstanceOf(Error);
  });
});

describe("stravaStreamsToMetricStream — edge cases", () => {
  it("returns empty array when time data is empty", () => {
    const streams: StravaStreamSet = {
      time: { data: [], series_type: "time", resolution: "high", original_size: 0 },
      heartrate: { data: [], series_type: "time", resolution: "high", original_size: 0 },
    };
    const result = stravaStreamsToMetricStream(
      streams,
      "strava",
      "act-id",
      new Date("2026-03-01T08:00:00Z"),
    );
    expect(result).toHaveLength(0);
  });
});
