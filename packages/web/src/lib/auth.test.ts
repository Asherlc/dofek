import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchConfiguredProviders,
  fetchCurrentUser,
  loginWithPassword,
  logout,
  registerWithPassword,
} from "./auth.ts";

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

describe("loginWithPassword", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    vi.stubGlobal("window", { location: { href: "" } });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts credentials and returns redirect path", async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockResponse({
        ok: true,
        json: () => Promise.resolve({ session: "sess-1", redirect: "/dashboard" }),
      }),
    );

    const result = await loginWithPassword({
      email: "user@example.com",
      password: "password123",
      returnTo: "/dashboard",
    });

    expect(result).toEqual({ redirect: "/dashboard" });
    expect(fetch).toHaveBeenCalledWith("/auth/login/password", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      credentials: "include",
      body: JSON.stringify({
        email: "user@example.com",
        password: "password123",
        return_to: "/dashboard",
      }),
    });
  });

  it("throws server error message when login fails", async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockResponse({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: "Invalid email or password", redirect: "/" }),
      }),
    );

    await expect(
      loginWithPassword({ email: "user@example.com", password: "wrong-password" }),
    ).rejects.toThrow("Invalid email or password");
  });

  it("throws generic message when login fails without error body", async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockResponse({
        ok: false,
        status: 500,
        json: () => Promise.reject(new Error("invalid json")),
      }),
    );

    await expect(
      loginWithPassword({ email: "user@example.com", password: "password123" }),
    ).rejects.toThrow("Authentication failed");
  });

  it("throws when login response has invalid shape", async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockResponse({
        ok: true,
        json: () => Promise.resolve({ redirect: 123 }),
      }),
    );

    await expect(
      loginWithPassword({ email: "user@example.com", password: "password123" }),
    ).rejects.toThrow("Authentication failed");
  });
});

describe("registerWithPassword", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts registration details and returns redirect path", async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockResponse({
        ok: true,
        json: () => Promise.resolve({ session: "sess-1", redirect: "/onboarding" }),
      }),
    );

    const result = await registerWithPassword({
      email: "user@example.com",
      password: "password123",
      name: "User",
      returnTo: "/onboarding",
    });

    expect(result).toEqual({ redirect: "/onboarding" });
    expect(fetch).toHaveBeenCalledWith("/auth/register", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      credentials: "include",
      body: JSON.stringify({
        email: "user@example.com",
        password: "password123",
        name: "User",
        return_to: "/onboarding",
      }),
    });
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
