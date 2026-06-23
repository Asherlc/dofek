import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AuthUserSchema,
  ConfiguredProvidersSchema,
  fetchConfiguredProviders,
  fetchCurrentUser,
  isNativeAppleSignInAvailable,
  loginWithPassword,
  logout,
  registerWithPassword,
  requestPasswordReset,
  startNativeAppleSignIn,
  startOAuthLogin,
} from "./auth";

// Mock expo-secure-store, expo-web-browser, and expo-apple-authentication so the module loads in Node
vi.mock("expo-secure-store", () => ({
  setItemAsync: vi.fn(),
  getItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock("expo-web-browser", () => ({
  openAuthSessionAsync: vi.fn(),
}));
const { mockIsAvailableAsync, mockSignInAsync } = vi.hoisted(() => ({
  mockIsAvailableAsync: vi.fn(),
  mockSignInAsync: vi.fn(),
}));
vi.mock("expo-apple-authentication", () => ({
  isAvailableAsync: mockIsAvailableAsync,
  signInAsync: mockSignInAsync,
  AppleAuthenticationScope: { FULL_NAME: 0, EMAIL: 1 },
  AppleAuthenticationButtonType: { SIGN_IN: 0 },
  AppleAuthenticationButtonStyle: { WHITE: 0 },
}));
vi.mock("react-native", () => ({
  Platform: { OS: "ios" },
}));

import * as WebBrowser from "expo-web-browser";

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

describe("isNativeAppleSignInAvailable", () => {
  beforeEach(() => {
    mockIsAvailableAsync.mockReset();
  });

  it("returns true on iOS when expo-apple-authentication reports availability", async () => {
    mockIsAvailableAsync.mockResolvedValueOnce(true);
    await expect(isNativeAppleSignInAvailable()).resolves.toBe(true);
  });

  it("returns false when expo-apple-authentication reports unavailability", async () => {
    mockIsAvailableAsync.mockResolvedValueOnce(false);
    await expect(isNativeAppleSignInAvailable()).resolves.toBe(false);
  });
});

describe("startNativeAppleSignIn", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
    mockSignInAsync.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns auth result on successful native sign-in", async () => {
    mockSignInAsync.mockResolvedValueOnce({
      user: "apple-user-123",
      authorizationCode: "native-auth-code",
      identityToken: "native-identity-token",
      fullName: { givenName: "Alice", familyName: "Smith" },
      email: "alice@icloud.com",
      state: null,
      realUserStatus: 1,
      authorizedScopes: [],
    });

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ session: "sess-native-123", isNewUser: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await startNativeAppleSignIn("https://srv");
    expect(result).toEqual({ session: "sess-native-123", isNewUser: true });

    expect(fetch).toHaveBeenCalledWith("https://srv/auth/apple/native", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        authorizationCode: "native-auth-code",
        identityToken: "native-identity-token",
        givenName: "Alice",
        familyName: "Smith",
      }),
    });
  });

  it("returns null when authorizationCode is missing", async () => {
    mockSignInAsync.mockResolvedValueOnce({
      user: "apple-user-123",
      authorizationCode: null,
      identityToken: null,
      fullName: null,
      email: null,
      state: null,
      realUserStatus: 1,
      authorizedScopes: [],
    });

    const token = await startNativeAppleSignIn("https://srv");
    expect(token).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("throws when server returns an error", async () => {
    mockSignInAsync.mockResolvedValueOnce({
      user: "apple-user-123",
      authorizationCode: "code",
      identityToken: "token",
      fullName: null,
      email: null,
      state: null,
      realUserStatus: 1,
      authorizedScopes: [],
    });

    vi.mocked(fetch).mockResolvedValueOnce(new Response("Apple Sign In failed", { status: 500 }));

    await expect(startNativeAppleSignIn("https://srv")).rejects.toThrow("Apple Sign In failed");
  });
});

describe("startOAuthLogin", () => {
  beforeEach(() => {
    vi.mocked(WebBrowser.openAuthSessionAsync).mockReset();
  });

  it("returns auth result from successful deep link", async () => {
    vi.mocked(WebBrowser.openAuthSessionAsync).mockResolvedValueOnce({
      type: "success",
      url: "dofek://auth/callback?session=sess-oauth-1&new_user=true",
    });

    const result = await startOAuthLogin("https://srv", "google", false);

    expect(result).toEqual({ session: "sess-oauth-1", isNewUser: true });
    expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalledWith(
      "https://srv/auth/login/google?redirect_scheme=dofek",
      "dofek://auth/callback",
    );
  });

  it("returns null when OAuth is cancelled", async () => {
    vi.mocked(WebBrowser.openAuthSessionAsync).mockResolvedValueOnce({
      type: "cancel",
    });

    await expect(startOAuthLogin("https://srv", "google", false)).resolves.toBeNull();
  });
});

describe("loginWithPassword", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns auth result on success", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ session: "sess-password-1", redirect: "/" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const result = await loginWithPassword("https://srv", "user@example.com", "password123");
    expect(result).toEqual({ session: "sess-password-1", isNewUser: false });
  });

  it("throws server error message when login fails", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Invalid email or password", redirect: "/" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(loginWithPassword("https://srv", "user@example.com", "wrong")).rejects.toThrow(
      "Invalid email or password",
    );
  });

  it("throws generic message when login fails without error body", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("not json", {
        status: 500,
        headers: { "content-type": "text/plain" },
      }),
    );

    await expect(
      loginWithPassword("https://srv", "user@example.com", "password123"),
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

  it("returns auth result on success", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(
        JSON.stringify({ session: "sess-register-1", redirect: "/?newUser=true", isNewUser: true }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    const result = await registerWithPassword(
      "https://srv",
      "user@example.com",
      "password123",
      "User",
    );
    expect(result).toEqual({ session: "sess-register-1", isNewUser: true });
  });

  it("throws server error message when registration fails", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "An account with this email already exists" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      registerWithPassword("https://srv", "user@example.com", "password123", "User"),
    ).rejects.toThrow("An account with this email already exists");
  });

  it("throws generic message when registration response is invalid", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ redirect: "/" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      registerWithPassword("https://srv", "user@example.com", "password123", "User"),
    ).rejects.toThrow("Authentication failed");
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
      new Response(
        JSON.stringify({
          message: "If that email has a password login, we'll send a reset link.",
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    await expect(requestPasswordReset("https://server.test", "user@example.com")).resolves.toEqual({
      message: "If that email has a password login, we'll send a reset link.",
    });
  });
});

describe("logout", () => {
  let SecureStore: typeof import("expo-secure-store");

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", vi.fn());
    SecureStore = await import("expo-secure-store");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends POST to /auth/logout with Bearer token", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));

    await logout("https://srv", "my-token");

    expect(fetch).toHaveBeenCalledWith("https://srv/auth/logout", {
      method: "POST",
      headers: { Authorization: "Bearer my-token" },
    });
  });

  it("clears the session token from storage", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));

    await logout("https://srv", "my-token");

    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith("dofek_session_token");
  });

  it("clears the session token even when fetch fails", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("network error"));

    await logout("https://srv", "my-token");

    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith("dofek_session_token");
  });

  it("reports fetch errors to Sentry", async () => {
    const Sentry = await import("@sentry/react-native");
    vi.mocked(fetch).mockRejectedValueOnce(new Error("network error"));

    await logout("https://srv", "my-token");

    expect(Sentry.captureException).toHaveBeenCalled();
  });
});
