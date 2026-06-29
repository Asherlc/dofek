import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  confirmPasswordReset,
  fetchConfiguredProviders,
  fetchCurrentUser,
  loginWithPassword,
  logout,
  registerWithPassword,
  requestPasswordReset,
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
    vi.mocked(fetch).mockResolvedValue(mockResponse({ ok: false, status: 401 }));

    const result = await fetchCurrentUser();
    expect(result).toBeNull();
  });

  it("throws server error details when session bootstrap fails", async () => {
    vi.mocked(fetch).mockResolvedValue(
      mockResponse({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
        json: () => Promise.resolve({ error: "Database unavailable" }),
      }),
    );

    await expect(fetchCurrentUser()).rejects.toThrow("Database unavailable");
  });

  it("throws network errors instead of treating them as logged out", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("Failed to fetch"));

    await expect(fetchCurrentUser()).rejects.toThrow("Failed to fetch");
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

    expect(result).toEqual({ redirect: "/dashboard", isNewUser: false });
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
        json: () =>
          Promise.resolve({ session: "sess-1", redirect: "/?newUser=true", isNewUser: true }),
      }),
    );

    const result = await registerWithPassword({
      email: "user@example.com",
      password: "password123",
      name: "User",
      returnTo: "/onboarding",
    });

    expect(result).toEqual({ redirect: "/?newUser=true", isNewUser: true });
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

describe("requestPasswordReset", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("requests a password reset", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse({
        ok: true,
        json: () =>
          Promise.resolve({
            message: "If that email has a password login, we'll send a reset link.",
          }),
      }),
    );

    await expect(requestPasswordReset("user@example.com")).resolves.toEqual({
      message: "If that email has a password login, we'll send a reset link.",
    });

    expect(fetch).toHaveBeenCalledWith("/auth/password-reset/request", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ email: "user@example.com" }),
    });
  });

  it("throws server error message when reset request fails", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: "Invalid password reset request", message: "" }),
      }),
    );

    await expect(requestPasswordReset("user@example.com")).rejects.toThrow(
      "Invalid password reset request",
    );
  });

  it("throws generic message when reset request fails without error body", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 500,
        json: () => Promise.reject(new Error("invalid json")),
      }),
    );

    await expect(requestPasswordReset("user@example.com")).rejects.toThrow("Password reset failed");
  });

  it("throws when reset request response has invalid shape", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse({
        ok: true,
        json: () => Promise.resolve({ message: 123 }),
      }),
    );

    await expect(requestPasswordReset("user@example.com")).rejects.toThrow("Password reset failed");
  });
});

describe("confirmPasswordReset", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("confirms a password reset", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse({
        ok: true,
        json: () => Promise.resolve({ ok: true }),
      }),
    );

    await expect(confirmPasswordReset("token", "new-password123")).resolves.toEqual({ ok: true });

    expect(fetch).toHaveBeenCalledWith("/auth/password-reset/confirm", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ token: "token", password: "new-password123" }),
    });
  });

  it("throws server error message when reset confirmation fails", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ error: "Reset link is invalid or has expired", ok: false }),
      }),
    );

    await expect(confirmPasswordReset("token", "new-password123")).rejects.toThrow(
      "Reset link is invalid or has expired",
    );
  });

  it("throws generic message when reset confirmation fails without error body", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse({
        ok: false,
        status: 500,
        json: () => Promise.reject(new Error("invalid json")),
      }),
    );

    await expect(confirmPasswordReset("token", "new-password123")).rejects.toThrow(
      "Password reset failed",
    );
  });

  it("throws when reset confirmation response has invalid shape", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockResponse({
        ok: true,
        json: () => Promise.resolve({ ok: false }),
      }),
    );

    await expect(confirmPasswordReset("token", "new-password123")).rejects.toThrow(
      "Password reset failed",
    );
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
