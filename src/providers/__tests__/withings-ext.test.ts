import { afterEach, describe, expect, it } from "vitest";
import {
  WithingsClient,
  WithingsProvider,
  exchangeWithingsCode,
  parseMeasureGroup,
  refreshWithingsToken,
  withingsOAuthConfig,
  type WithingsMeasureGroup,
} from "../withings.ts";

// ============================================================
// Extended Withings tests covering:
// - WithingsClient API calls and error handling
// - withingsOAuthConfig with/without env vars
// - exchangeWithingsCode and refreshWithingsToken
// - WithingsProvider validate/authSetup
// - parseMeasureGroup skin temp (type 73)
// ============================================================

describe("parseMeasureGroup — skin temperature (type 73)", () => {
  it("parses skin temperature measurement", () => {
    const group: WithingsMeasureGroup = {
      grpid: 4001,
      date: 1709510400,
      category: 1,
      measures: [{ type: 73, value: 3350, unit: -2 }], // 33.50 C
    };

    const result = parseMeasureGroup(group);
    expect(result.temperatureC).toBeCloseTo(33.5);
  });
});

describe("parseMeasureGroup — unknown measure types", () => {
  it("ignores unknown measure types", () => {
    const group: WithingsMeasureGroup = {
      grpid: 5001,
      date: 1709510400,
      category: 1,
      measures: [{ type: 999, value: 100, unit: 0 }],
    };

    const result = parseMeasureGroup(group);
    expect(result.weightKg).toBeUndefined();
    expect(result.bodyFatPct).toBeUndefined();
    expect(result.systolicBp).toBeUndefined();
    expect(result.temperatureC).toBeUndefined();
  });
});

describe("parseMeasureGroup — fat_free_mass and fat_mass (types 5, 8)", () => {
  it("does not map fat_free_mass (type 5) or fat_mass (type 8) to any field", () => {
    const group: WithingsMeasureGroup = {
      grpid: 6001,
      date: 1709510400,
      category: 1,
      measures: [
        { type: 5, value: 57000, unit: -3 }, // fat free mass
        { type: 8, value: 15000, unit: -3 }, // fat mass
      ],
    };

    const result = parseMeasureGroup(group);
    // These types are in the getMeas request but not mapped to fields
    expect(result.weightKg).toBeUndefined();
    expect(result.muscleMassKg).toBeUndefined();
  });
});

describe("WithingsClient — API calls", () => {
  it("getMeas sends correct POST request with params", async () => {
    let capturedUrl = "";
    let capturedBody = "";
    let capturedHeaders: Record<string, string> = {};

    const mockFetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedUrl = input.toString();
      capturedBody = init?.body as string;
      capturedHeaders = Object.fromEntries(
        Object.entries(init?.headers ?? {}),
      ) as Record<string, string>;
      return Response.json({
        status: 0,
        body: { measuregrps: [], more: 0, offset: 0 },
      });
    }) as typeof globalThis.fetch;

    const client = new WithingsClient("test-token", mockFetch);
    const result = await client.getMeas(1000, 2000, 5);

    expect(capturedUrl).toContain("/measure");
    expect(capturedHeaders.Authorization).toBe("Bearer test-token");
    expect(capturedHeaders["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(capturedBody).toContain("action=getmeas");
    expect(capturedBody).toContain("startdate=1000");
    expect(capturedBody).toContain("enddate=2000");
    expect(capturedBody).toContain("offset=5");
    expect(capturedBody).toContain("category=1");
    expect(result.measuregrps).toHaveLength(0);
  });

  it("throws on non-OK HTTP response", async () => {
    const mockFetch = (async (): Promise<Response> => {
      return new Response("Server Error", { status: 500 });
    }) as typeof globalThis.fetch;

    const client = new WithingsClient("bad-token", mockFetch);
    await expect(client.getMeas(0, 1000)).rejects.toThrow("Withings API error (500)");
  });

  it("throws on non-zero status in response body", async () => {
    const mockFetch = (async (): Promise<Response> => {
      return Response.json({ status: 401, body: {} });
    }) as typeof globalThis.fetch;

    const client = new WithingsClient("expired-token", mockFetch);
    await expect(client.getMeas(0, 1000)).rejects.toThrow("Withings API error (status 401)");
  });

  it("uses default offset of 0", async () => {
    let capturedBody = "";
    const mockFetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedBody = init?.body as string;
      return Response.json({
        status: 0,
        body: { measuregrps: [], more: 0, offset: 0 },
      });
    }) as typeof globalThis.fetch;

    const client = new WithingsClient("test-token", mockFetch);
    await client.getMeas(1000, 2000);

    expect(capturedBody).toContain("offset=0");
  });
});

describe("withingsOAuthConfig", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns null when WITHINGS_CLIENT_ID is not set", () => {
    delete process.env.WITHINGS_CLIENT_ID;
    delete process.env.WITHINGS_CLIENT_SECRET;
    expect(withingsOAuthConfig()).toBeNull();
  });

  it("returns null when WITHINGS_CLIENT_SECRET is not set", () => {
    process.env.WITHINGS_CLIENT_ID = "test-id";
    delete process.env.WITHINGS_CLIENT_SECRET;
    expect(withingsOAuthConfig()).toBeNull();
  });

  it("returns config when both env vars are set", () => {
    process.env.WITHINGS_CLIENT_ID = "test-id";
    process.env.WITHINGS_CLIENT_SECRET = "test-secret";
    const config = withingsOAuthConfig();
    expect(config).not.toBeNull();
    expect(config?.clientId).toBe("test-id");
    expect(config?.clientSecret).toBe("test-secret");
    expect(config?.scopes).toContain("user.metrics");
    expect(config?.authorizeUrl).toContain("account.withings.com");
    expect(config?.tokenUrl).toContain("wbsapi.withings.net");
  });
});

describe("exchangeWithingsCode", () => {
  it("sends action=requesttoken with authorization_code grant", async () => {
    let capturedBody = "";
    const mockFetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedBody = init?.body as string;
      return Response.json({
        status: 0,
        body: {
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 10800,
          scope: "user.metrics",
        },
      });
    }) as typeof globalThis.fetch;

    const config = {
      clientId: "test-id",
      clientSecret: "test-secret",
      authorizeUrl: "https://account.withings.com/oauth2_user/authorize2",
      tokenUrl: "https://wbsapi.withings.net/v2/oauth2",
      redirectUri: "https://example.com/callback",
      scopes: ["user.metrics"],
    };

    const result = await exchangeWithingsCode(config, "auth-code", mockFetch);

    expect(capturedBody).toContain("action=requesttoken");
    expect(capturedBody).toContain("grant_type=authorization_code");
    expect(capturedBody).toContain("code=auth-code");
    expect(capturedBody).toContain("redirect_uri=");
    expect(capturedBody).toContain("client_id=test-id");
    expect(capturedBody).toContain("client_secret=test-secret");
    expect(result.accessToken).toBe("new-access");
    expect(result.refreshToken).toBe("new-refresh");
  });

  it("throws on non-OK HTTP response", async () => {
    const mockFetch = (async (): Promise<Response> => {
      return new Response("Bad Request", { status: 400 });
    }) as typeof globalThis.fetch;

    const config = {
      clientId: "test-id",
      clientSecret: "test-secret",
      authorizeUrl: "",
      tokenUrl: "https://wbsapi.withings.net/v2/oauth2",
      redirectUri: "",
      scopes: [],
    };

    await expect(exchangeWithingsCode(config, "bad-code", mockFetch)).rejects.toThrow(
      "Withings token request failed",
    );
  });

  it("throws on non-zero status in response", async () => {
    const mockFetch = (async (): Promise<Response> => {
      return Response.json({ status: 293, body: {} });
    }) as typeof globalThis.fetch;

    const config = {
      clientId: "test-id",
      clientSecret: "test-secret",
      authorizeUrl: "",
      tokenUrl: "https://wbsapi.withings.net/v2/oauth2",
      redirectUri: "",
      scopes: [],
    };

    await expect(exchangeWithingsCode(config, "code", mockFetch)).rejects.toThrow(
      "Withings token error (status 293)",
    );
  });
});

describe("refreshWithingsToken", () => {
  it("sends action=requesttoken with refresh_token grant", async () => {
    let capturedBody = "";
    const mockFetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedBody = init?.body as string;
      return Response.json({
        status: 0,
        body: {
          access_token: "refreshed-access",
          refresh_token: "refreshed-refresh",
          expires_in: 10800,
          scope: "user.metrics",
        },
      });
    }) as typeof globalThis.fetch;

    const config = {
      clientId: "test-id",
      clientSecret: "test-secret",
      authorizeUrl: "",
      tokenUrl: "https://wbsapi.withings.net/v2/oauth2",
      redirectUri: "",
      scopes: [],
    };

    const result = await refreshWithingsToken(config, "old-refresh", mockFetch);

    expect(capturedBody).toContain("action=requesttoken");
    expect(capturedBody).toContain("grant_type=refresh_token");
    expect(capturedBody).toContain("refresh_token=old-refresh");
    expect(result.accessToken).toBe("refreshed-access");
    expect(result.refreshToken).toBe("refreshed-refresh");
  });

  it("handles missing expires_in by defaulting to 10800", async () => {
    const mockFetch = (async (): Promise<Response> => {
      return Response.json({
        status: 0,
        body: {
          access_token: "access",
          refresh_token: "refresh",
        },
      });
    }) as typeof globalThis.fetch;

    const config = {
      clientId: "test-id",
      clientSecret: "test-secret",
      authorizeUrl: "",
      tokenUrl: "https://wbsapi.withings.net/v2/oauth2",
      redirectUri: "",
      scopes: [],
    };

    const before = Date.now();
    const result = await refreshWithingsToken(config, "ref", mockFetch);
    const after = Date.now();

    // Default expiry should be roughly 3 hours from now
    const expectedMin = before + 10800 * 1000;
    const expectedMax = after + 10800 * 1000;
    expect(result.expiresAt.getTime()).toBeGreaterThanOrEqual(expectedMin);
    expect(result.expiresAt.getTime()).toBeLessThanOrEqual(expectedMax);
  });

  it("handles config without clientSecret", async () => {
    let capturedBody = "";
    const mockFetch = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      capturedBody = init?.body as string;
      return Response.json({
        status: 0,
        body: {
          access_token: "access",
          refresh_token: "refresh",
          expires_in: 3600,
        },
      });
    }) as typeof globalThis.fetch;

    const config = {
      clientId: "test-id",
      authorizeUrl: "",
      tokenUrl: "https://wbsapi.withings.net/v2/oauth2",
      redirectUri: "",
      scopes: [],
    };

    await refreshWithingsToken(config, "ref", mockFetch);
    expect(capturedBody).not.toContain("client_secret");
  });
});

describe("WithingsProvider — validate and properties", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("has correct id and name", () => {
    const provider = new WithingsProvider();
    expect(provider.id).toBe("withings");
    expect(provider.name).toBe("Withings");
  });

  it("returns error when WITHINGS_CLIENT_ID is missing", () => {
    delete process.env.WITHINGS_CLIENT_ID;
    delete process.env.WITHINGS_CLIENT_SECRET;
    const provider = new WithingsProvider();
    expect(provider.validate()).toContain("WITHINGS_CLIENT_ID");
  });

  it("returns error when WITHINGS_CLIENT_SECRET is missing", () => {
    process.env.WITHINGS_CLIENT_ID = "test-id";
    delete process.env.WITHINGS_CLIENT_SECRET;
    const provider = new WithingsProvider();
    expect(provider.validate()).toContain("WITHINGS_CLIENT_SECRET");
  });

  it("returns null when both env vars are set", () => {
    process.env.WITHINGS_CLIENT_ID = "test-id";
    process.env.WITHINGS_CLIENT_SECRET = "test-secret";
    const provider = new WithingsProvider();
    expect(provider.validate()).toBeNull();
  });
});

describe("WithingsProvider — authSetup", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns auth setup with correct config", () => {
    process.env.WITHINGS_CLIENT_ID = "test-id";
    process.env.WITHINGS_CLIENT_SECRET = "test-secret";
    const provider = new WithingsProvider();
    const setup = provider.authSetup();
    expect(setup.oauthConfig.clientId).toBe("test-id");
    expect(setup.exchangeCode).toBeTypeOf("function");
    expect(setup.apiBaseUrl).toContain("wbsapi.withings.net");
  });

  it("throws when env vars are missing", () => {
    delete process.env.WITHINGS_CLIENT_ID;
    delete process.env.WITHINGS_CLIENT_SECRET;
    const provider = new WithingsProvider();
    expect(() => provider.authSetup()).toThrow("WITHINGS_CLIENT_ID");
  });
});
