import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchConfiguredProviders, fetchCurrentUser } from "./auth.ts";

describe("fetchCurrentUser", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls /api/auth/me with credentials and returns user", async () => {
    const user = { id: "u1", name: "Test", email: "test@example.com" };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(user));
    const result = await fetchCurrentUser();
    expect(fetchSpy).toHaveBeenCalledWith("/api/auth/me", { credentials: "include" });
    expect(result).toEqual(user);
  });

  it("returns null on non-OK response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("Unauthorized", { status: 401 }));
    const result = await fetchCurrentUser();
    expect(result).toBeNull();
  });
});

describe("fetchConfiguredProviders", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls /api/auth/providers and returns result", async () => {
    const providers = { identity: ["google"], data: ["strava"] };
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(providers));
    const result = await fetchConfiguredProviders();
    expect(fetchSpy).toHaveBeenCalledWith("/api/auth/providers");
    expect(result).toEqual(providers);
  });

  it("throws on non-OK response", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("Server Error", { status: 500, statusText: "Internal Server Error" }),
    );
    await expect(fetchConfiguredProviders()).rejects.toThrow(
      "Failed to fetch providers: 500 Internal Server Error",
    );
  });
});

