import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncRun } from "../sync-run.ts";
import { SyncWindow } from "../sync-window.ts";
import { createMockDatabase } from "../test-helpers.ts";
import { FatSecretProvider } from "./provider.ts";

const mockLoadTokens = vi.fn();
const mockEnsureProvider = vi.fn();

vi.mock("../../db/tokens.ts", () => ({
  loadTokens: (...args: unknown[]) => mockLoadTokens(...args),
  ensureProvider: (...args: unknown[]) => mockEnsureProvider(...args),
}));

vi.mock("../../db/token-user-context.ts", () => ({
  getTokenUserId: () => "00000000-0000-0000-0000-000000000001",
}));

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

describe("FatSecretProvider.sync() — error handling", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env.FATSECRET_CONSUMER_KEY = "key";
    process.env.FATSECRET_CONSUMER_SECRET = "secret";
    mockLoadTokens.mockResolvedValue({
      accessToken: "oauth1-token",
      refreshToken: "oauth1-token-secret",
      expiresAt: new Date("2099-01-01T00:00:00Z"),
      scopes: null,
    });
    mockEnsureProvider.mockResolvedValue(undefined);
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  it("silently skips Zod validation errors on the food_entries path", async () => {
    const { db: mockDb, spies } = createMockDatabase();
    const mockFetch: typeof globalThis.fetch = async () =>
      Response.json({ food_entries: { food_entry: "not-an-array" } });
    const provider = new FatSecretProvider(mockFetch);
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);

    const result = await provider.sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since }) }),
    );

    expect(result.errors).toEqual([]);
    expect(spies.insert).not.toHaveBeenCalled();
  });

  it("records non-Zod API errors", async () => {
    const { db: mockDb, spies } = createMockDatabase();
    const mockFetch: typeof globalThis.fetch = async () =>
      new Response("upstream failed", { status: 500 });
    const provider = new FatSecretProvider(mockFetch);
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);

    const result = await provider.sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since }) }),
    );

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]?.message).toMatch(/^Date \d{4}-\d{2}-\d{2}:/);
    expect(result.errors[0]?.message).toContain("FatSecret API error (500)");
    expect(spies.insert).not.toHaveBeenCalled();
  });

  it("silently skips explicit no-entries API errors", async () => {
    const { db: mockDb } = createMockDatabase();
    const mockFetch: typeof globalThis.fetch = async () =>
      Response.json({ error: { code: 7, message: "No entries found" } }, { status: 400 });
    const provider = new FatSecretProvider(mockFetch);
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);

    const result = await provider.sync(
      new SyncRun({ db: mockDb, window: SyncWindow.fromSince({ since }) }),
    );

    expect(result.errors).toEqual([]);
  });
});
