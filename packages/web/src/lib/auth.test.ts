import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchConfiguredProviders, fetchCurrentUser, logout } from "./auth.ts";

function mockResponse(props: Partial<Response>): Response {
  return {
    ok: false,
    status: 200,
    statusText: "OK",
    headers: new Headers(),
    redirected: false,
    type: "basic",
    url: "",
    body: null,
    bodyUsed: false,
    clone: vi.fn(),
    arrayBuffer: vi.fn(),
    blob: vi.fn(),
    bytes: vi.fn(),
    formData: vi.fn(),
    json: vi.fn(),
    text: vi.fn(),
    ...props,
  } satisfies Response;
}

describe("fetchCurrentUser", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns user when response is ok", async () => {
    const user = { id: "u1", name: "Alice", email: "alice@example.com" };
    vi.mocked(fetch).mockResolvedValue(
      mockResponse({
        ok: true,
        json: () => Promise.resolve(user),
      }),
    );

    const result = await fetchCurrentUser();
    expect(result).toEqual(user);
    expect(fetch).toHaveBeenCalledWith("/api/auth/me", { credentials: "include" });
  });

  it("returns null when response is not ok", async () => {
    vi.mocked(fetch).mockResolvedValue(mockResponse({ ok: false }));

    const result = await fetchCurrentUser();
    expect(result).toBeNull();
  });

  it("returns user with null email", async () => {
    const user = { id: "u1", name: "Test", email: null };
    vi.mocked(fetch).mockResolvedValue(
      mockResponse({
        ok: true,
        json: () => Promise.resolve(user),
      }),
    );
    const result = await fetchCurrentUser();
    expect(result).toEqual(user);
    expect(result?.email).toBeNull();
  });
});

describe("fetchConfiguredProviders", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns providers when response is ok", async () => {
    const providers = { identity: ["google"], data: ["wahoo"] };
    vi.mocked(fetch).mockResolvedValue(
      mockResponse({
        ok: true,
        json: () => Promise.resolve(providers),
      }),
    );

    const result = await fetchConfiguredProviders();
    expect(result).toEqual(providers);
  });

  it("throws when response is not ok", async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockResponse({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      }),
    );

    await expect(fetchConfiguredProviders()).rejects.toThrow(
      "Failed to fetch providers: 500 Internal Server Error",
    );
  });

  it("includes status code in error message", async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockResponse({
        ok: false,
        status: 404,
        statusText: "Not Found",
      }),
    );
    await expect(fetchConfiguredProviders()).rejects.toThrow("404");
  });
});

describe("logout", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("window", { location: { href: "" } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts to logout endpoint and redirects", async () => {
    vi.mocked(fetch).mockResolvedValue(mockResponse({}));

    await logout();

    expect(fetch).toHaveBeenCalledWith("/auth/logout", {
      method: "POST",
      credentials: "include",
    });
    expect(window.location.href).toBe("/login");
  });
});
