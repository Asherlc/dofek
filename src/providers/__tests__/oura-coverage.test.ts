import { afterEach, describe, expect, it } from "vitest";
import { OuraClient, OuraProvider, ouraOAuthConfig } from "../oura.ts";

// ============================================================
// Coverage tests for Oura provider edge cases
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
  });

  it("uses custom OAUTH_REDIRECT_URI when set", () => {
    process.env.OURA_CLIENT_ID = "test-id";
    process.env.OURA_CLIENT_SECRET = "test-secret";
    process.env.OAUTH_REDIRECT_URI = "https://example.com/callback";
    const config = ouraOAuthConfig();
    expect(config?.redirectUri).toBe("https://example.com/callback");
  });
});

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

describe("OuraClient — error handling", () => {
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
});
