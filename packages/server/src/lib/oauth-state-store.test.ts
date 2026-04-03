import { describe, expect, it, vi } from "vitest";
import {
  InMemoryOAuth1SecretStore,
  InMemoryOAuthStateStore,
  type OAuth1SecretEntry,
  type OAuthStateEntry,
  RedisOAuth1SecretStore,
  RedisOAuthStateStore,
} from "./oauth-state-store.ts";

// ── OAuthStateStore ──

const sampleState: OAuthStateEntry = {
  providerId: "wahoo",
  codeVerifier: "pkce-verifier",
  intent: "data",
  userId: "user-1",
  mobileScheme: "dofek",
  returnTo: "/settings",
};

describe("InMemoryOAuthStateStore", () => {
  it("stores, retrieves, and deletes state entries", async () => {
    const store = new InMemoryOAuthStateStore();
    await store.save("state-1", sampleState);
    expect(await store.get("state-1")).toEqual(sampleState);

    await store.delete("state-1");
    expect(await store.get("state-1")).toBeNull();
  });

  it("returns null for missing keys", async () => {
    const store = new InMemoryOAuthStateStore();
    expect(await store.get("missing")).toBeNull();
  });

  it("expires entries after TTL", async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryOAuthStateStore();
      await store.save("state-exp", sampleState, 100);
      vi.advanceTimersByTime(101);
      expect(await store.get("state-exp")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stores entries without optional fields", async () => {
    const store = new InMemoryOAuthStateStore();
    const minimal: OAuthStateEntry = { providerId: "strava", intent: "data", userId: "user-2" };
    await store.save("state-min", minimal);
    expect(await store.get("state-min")).toEqual(minimal);
  });

  it("checks existence without consuming", async () => {
    const store = new InMemoryOAuthStateStore();
    await store.save("state-check", sampleState);
    expect(await store.has("state-check")).toBe(true);
    expect(await store.has("nonexistent")).toBe(false);
    // Entry should still be retrievable
    expect(await store.get("state-check")).toEqual(sampleState);
  });
});

describe("RedisOAuthStateStore", () => {
  it("saves and retrieves state entries via Redis", async () => {
    const setMethod = vi.fn(async () => "OK");
    const getMethod = vi.fn(async () => JSON.stringify(sampleState));
    const deleteMethod = vi.fn(async () => 1);
    const existsMethod = vi.fn(async () => 1);

    const store = new RedisOAuthStateStore(async () => ({
      set: setMethod,
      get: getMethod,
      del: deleteMethod,
      exists: existsMethod,
    }));

    await store.save("state-redis", sampleState);
    expect(setMethod).toHaveBeenCalledWith(
      "oauth-state:state-redis",
      JSON.stringify(sampleState),
      "PX",
      600_000,
    );

    expect(await store.get("state-redis")).toEqual(sampleState);
  });

  it("returns null when Redis has no entry", async () => {
    const store = new RedisOAuthStateStore(async () => ({
      set: vi.fn(async () => "OK"),
      get: vi.fn(async () => null),
      del: vi.fn(async () => 0),
      exists: vi.fn(async () => 0),
    }));
    expect(await store.get("missing")).toBeNull();
  });

  it("returns null and cleans up on invalid JSON", async () => {
    const deleteMethod = vi.fn(async () => 1);
    const store = new RedisOAuthStateStore(async () => ({
      set: vi.fn(async () => "OK"),
      get: vi.fn(async () => "{bad json"),
      del: deleteMethod,
      exists: vi.fn(async () => 1),
    }));
    expect(await store.get("bad")).toBeNull();
    expect(deleteMethod).toHaveBeenCalledWith("oauth-state:bad");
  });

  it("returns null and cleans up on schema validation failure", async () => {
    const deleteMethod = vi.fn(async () => 1);
    const store = new RedisOAuthStateStore(async () => ({
      set: vi.fn(async () => "OK"),
      get: vi.fn(async () => JSON.stringify({ wrong: "shape" })),
      del: deleteMethod,
      exists: vi.fn(async () => 1),
    }));
    expect(await store.get("bad-schema")).toBeNull();
    expect(deleteMethod).toHaveBeenCalledWith("oauth-state:bad-schema");
  });

  it("checks existence via Redis EXISTS", async () => {
    const existsMethod = vi.fn(async () => 1);
    const store = new RedisOAuthStateStore(async () => ({
      set: vi.fn(async () => "OK"),
      get: vi.fn(async () => null),
      del: vi.fn(async () => 0),
      exists: existsMethod,
    }));
    expect(await store.has("check-key")).toBe(true);
    expect(existsMethod).toHaveBeenCalledWith("oauth-state:check-key");
  });
});

// ── OAuth1SecretStore ──

const sampleSecret: OAuth1SecretEntry = {
  providerId: "fatsecret",
  tokenSecret: "secret-abc",
  userId: "user-1",
};

describe("InMemoryOAuth1SecretStore", () => {
  it("stores, retrieves, and deletes secrets", async () => {
    const store = new InMemoryOAuth1SecretStore();
    await store.save("token-1", sampleSecret);
    expect(await store.get("token-1")).toEqual(sampleSecret);

    await store.delete("token-1");
    expect(await store.get("token-1")).toBeNull();
  });

  it("expires entries after TTL", async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryOAuth1SecretStore();
      await store.save("token-exp", sampleSecret, 100);
      vi.advanceTimersByTime(101);
      expect(await store.get("token-exp")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("RedisOAuth1SecretStore", () => {
  it("saves and retrieves secrets via Redis", async () => {
    const setMethod = vi.fn(async () => "OK");
    const getMethod = vi.fn(async () => JSON.stringify(sampleSecret));
    const deleteMethod = vi.fn(async () => 1);

    const store = new RedisOAuth1SecretStore(async () => ({
      set: setMethod,
      get: getMethod,
      del: deleteMethod,
      exists: vi.fn(async () => 1),
    }));

    await store.save("token-redis", sampleSecret);
    expect(setMethod).toHaveBeenCalledWith(
      "oauth1-secret:token-redis",
      JSON.stringify(sampleSecret),
      "PX",
      600_000,
    );

    expect(await store.get("token-redis")).toEqual(sampleSecret);
  });

  it("returns null when Redis has no entry", async () => {
    const store = new RedisOAuth1SecretStore(async () => ({
      set: vi.fn(async () => "OK"),
      get: vi.fn(async () => null),
      del: vi.fn(async () => 0),
      exists: vi.fn(async () => 0),
    }));
    expect(await store.get("missing")).toBeNull();
  });

  it("returns null and cleans up on invalid data", async () => {
    const deleteMethod = vi.fn(async () => 1);
    const store = new RedisOAuth1SecretStore(async () => ({
      set: vi.fn(async () => "OK"),
      get: vi.fn(async () => JSON.stringify({ wrong: true })),
      del: deleteMethod,
      exists: vi.fn(async () => 0),
    }));
    expect(await store.get("bad")).toBeNull();
    expect(deleteMethod).toHaveBeenCalledWith("oauth1-secret:bad");
  });
});
