import { afterEach, describe, expect, it } from "vitest";
import { FatSecretProvider } from "./provider.ts";

// Unit tests for the FatSecretProvider wiring (validation + auth setup).
// OAuth signing lives in ./signing.test.ts, the API client and 3-legged token
// flow in ./client.test.ts, parsing in ./parsing.test.ts, and end-to-end sync
// in ./provider-sync.integration.test.ts.

describe("FatSecretProvider — validate()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("reports a missing consumer key", () => {
    delete process.env.FATSECRET_CONSUMER_KEY;
    delete process.env.FATSECRET_CONSUMER_SECRET;
    expect(new FatSecretProvider().validate()).toBe("FATSECRET_CONSUMER_KEY is not set");
  });

  it("reports a missing consumer secret when only the key is set", () => {
    process.env.FATSECRET_CONSUMER_KEY = "key";
    delete process.env.FATSECRET_CONSUMER_SECRET;
    expect(new FatSecretProvider().validate()).toBe("FATSECRET_CONSUMER_SECRET is not set");
  });

  it("returns null when both env vars are set", () => {
    process.env.FATSECRET_CONSUMER_KEY = "key";
    process.env.FATSECRET_CONSUMER_SECRET = "secret";
    const provider = new FatSecretProvider();
    expect(provider.id).toBe("fatsecret");
    expect(provider.name).toBe("FatSecret");
    expect(provider.validate()).toBeNull();
  });
});

describe("FatSecretProvider — authSetup()", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns the OAuth config and 3-legged flow callbacks", () => {
    process.env.FATSECRET_CONSUMER_KEY = "key";
    process.env.FATSECRET_CONSUMER_SECRET = "secret";
    delete process.env.OAUTH_REDIRECT_URI;

    const setup = new FatSecretProvider().authSetup();
    expect(setup.oauthConfig.clientId).toBe("key");
    expect(setup.oauthConfig.clientSecret).toBe("secret");
    expect(setup.oauthConfig.authorizeUrl).toContain("fatsecret.com");
    expect(setup.oauthConfig.tokenUrl).toContain("fatsecret.com");
    expect(setup.oauthConfig.scopes).toEqual([]);
    expect(setup.oauthConfig.redirectUri).toContain("dofek");
    expect(setup.oauth1Flow.getRequestToken).toBeTypeOf("function");
    expect(setup.oauth1Flow.exchangeForAccessToken).toBeTypeOf("function");
  });

  it("uses a custom OAUTH_REDIRECT_URI when set", () => {
    process.env.FATSECRET_CONSUMER_KEY = "key";
    process.env.FATSECRET_CONSUMER_SECRET = "secret";
    process.env.OAUTH_REDIRECT_URI = "https://my-app.com/callback";

    const setup = new FatSecretProvider().authSetup();
    expect(setup.oauthConfig.redirectUri).toBe("https://my-app.com/callback");
  });

  it("throws when called without configured credentials", () => {
    delete process.env.FATSECRET_CONSUMER_KEY;
    delete process.env.FATSECRET_CONSUMER_SECRET;
    expect(() => new FatSecretProvider().authSetup()).toThrow(
      "FATSECRET_CONSUMER_KEY and FATSECRET_CONSUMER_SECRET are required",
    );
  });

  it("exposes an exchangeCode that rejects (FatSecret is OAuth 1.0)", async () => {
    process.env.FATSECRET_CONSUMER_KEY = "key";
    process.env.FATSECRET_CONSUMER_SECRET = "secret";
    const setup = new FatSecretProvider().authSetup();
    await expect(setup.exchangeCode("code")).rejects.toThrow("OAuth 1.0");
  });

  it("wires the request-token flow through to the injected fetch", async () => {
    process.env.FATSECRET_CONSUMER_KEY = "key";
    process.env.FATSECRET_CONSUMER_SECRET = "secret";
    const mockFetch: typeof globalThis.fetch = async () =>
      new Response("oauth_token=req-token&oauth_token_secret=req-secret", { status: 200 });

    const setup = new FatSecretProvider(mockFetch).authSetup();
    const result = await setup.oauth1Flow.getRequestToken("http://localhost:9876/callback");
    expect(result.oauthToken).toBe("req-token");
  });
});

describe("FatSecretProvider — constructor", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("accepts a custom fetch implementation", () => {
    process.env.FATSECRET_CONSUMER_KEY = "key";
    process.env.FATSECRET_CONSUMER_SECRET = "secret";
    const customFetch: typeof globalThis.fetch = () => Promise.resolve(new Response());
    expect(new FatSecretProvider(customFetch).id).toBe("fatsecret");
  });
});
