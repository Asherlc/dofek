import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthUserSchema,
  ConfiguredProvidersSchema,
  fetchConfiguredProviders,
  fetchCurrentUser,
} from "./auth";

// Mock expo-secure-store and expo-web-browser so the module loads in Node
vi.mock("expo-secure-store", () => ({
  setItemAsync: vi.fn(),
  getItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock("expo-web-browser", () => ({
  openAuthSessionAsync: vi.fn(),
}));

describe("AuthUserSchema", () => {
  it("parses a valid user", () => {
    const result = AuthUserSchema.parse({
      id: "usr_123",
      name: "Alice",
      email: "alice@example.com",
    });
    expect(result).toEqual({
      id: "usr_123",
      name: "Alice",
      email: "alice@example.com",
    });
  });

  it("accepts null email", () => {
    const result = AuthUserSchema.parse({
      id: "usr_123",
      name: "Alice",
      email: null,
    });
    expect(result.email).toBeNull();
  });

  it("rejects missing fields", () => {
    expect(() => AuthUserSchema.parse({ id: "usr_123" })).toThrow();
  });

  it("rejects wrong types", () => {
    expect(() => AuthUserSchema.parse({ id: 123, name: "Alice", email: null })).toThrow();
  });
});

describe("ConfiguredProvidersSchema", () => {
  it("parses valid providers", () => {
    const result = ConfiguredProvidersSchema.parse({
      identity: ["google", "apple"],
      data: ["strava", "wahoo"],
    });
    expect(result.identity).toEqual(["google", "apple"]);
    expect(result.data).toEqual(["strava", "wahoo"]);
  });

  it("rejects unknown identity providers", () => {
    expect(() =>
      ConfiguredProvidersSchema.parse({
        identity: ["unknown_provider"],
        data: [],
      }),
    ).toThrow();
  });

  it("accepts empty arrays", () => {
    const result = ConfiguredProvidersSchema.parse({
      identity: [],
      data: [],
    });
    expect(result.identity).toEqual([]);
    expect(result.data).toEqual([]);
  });
});

describe("fetchCurrentUser", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns parsed user on success", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "u1", name: "Bob", email: "bob@test.com" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const user = await fetchCurrentUser("https://srv", "tok");
    expect(user).toEqual({ id: "u1", name: "Bob", email: "bob@test.com" });
    expect(fetch).toHaveBeenCalledWith("https://srv/api/auth/me", {
      headers: { Authorization: "Bearer tok" },
    });
  });

  it("returns null on non-ok response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 401 }));

    expect(await fetchCurrentUser("https://srv", "tok")).toBeNull();
  });

  it("returns null on network error", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("network"));

    expect(await fetchCurrentUser("https://srv", "tok")).toBeNull();
  });

  it("returns null when response has wrong shape", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ wrong: "shape" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    expect(await fetchCurrentUser("https://srv", "tok")).toBeNull();
  });
});

describe("fetchConfiguredProviders", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns parsed providers on success", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ identity: ["google"], data: ["strava"] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const providers = await fetchConfiguredProviders("https://srv");
    expect(providers).toEqual({ identity: ["google"], data: ["strava"] });
  });

  it("throws on non-ok response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(null, { status: 500, statusText: "Internal Server Error" }),
    );

    await expect(fetchConfiguredProviders("https://srv")).rejects.toThrow(
      "Failed to fetch providers: 500 Internal Server Error",
    );
  });

  it("throws on invalid response shape", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ identity: "not-an-array" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(fetchConfiguredProviders("https://srv")).rejects.toThrow();
  });
});
