import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCaptureException = vi.hoisted(() => vi.fn());

vi.mock("./telemetry", () => ({
  captureException: mockCaptureException,
}));

import {
  AuthUserSchema,
  ConfiguredProvidersSchema,
  clearSessionToken,
  createProviderHandoffCode,
  fetchConfiguredProviders,
  fetchCurrentUser,
  getOrCreateSessionOwnerNonce,
  getSessionToken,
  isNativeAppleSignInAvailable,
  loginWithPassword,
  logout,
  registerWithPassword,
  requestPasswordReset,
  resetSessionTokenCacheForTests,
  rotateSessionOwnerNonce,
  saveSessionToken,
  startNativeAppleSignIn,
  startOAuthLogin,
} from "./auth";

// Mock expo-secure-store, expo-web-browser, and expo-apple-authentication so the module loads in Node
vi.mock("expo-secure-store", () => ({
  setItemAsync: vi.fn(),
  getItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
  AFTER_FIRST_UNLOCK: "kSecAttrAccessibleAfterFirstUnlock",
}));
vi.mock("expo-web-browser", () => ({
  openAuthSessionAsync: vi.fn(),
}));
vi.mock("expo-crypto", () => ({
  randomUUID: vi.fn(() => "11111111-1111-4111-8111-111111111111"),
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
    mockCaptureException.mockClear();
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

  it("throws server error details when session bootstrap fails", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Database unavailable" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(fetchCurrentUser("https://srv", "tok")).rejects.toThrow("Database unavailable");
  });

  it("throws network errors instead of treating them as logged out", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error("network"));

    await expect(fetchCurrentUser("https://srv", "tok")).rejects.toThrow("network");
  });

  it("throws when response has wrong shape", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ wrong: "shape" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(fetchCurrentUser("https://srv", "tok")).rejects.toThrow(
      "The server returned an invalid session response. Please try again.",
    );
    expect(mockCaptureException.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(mockCaptureException.mock.calls[0]?.[1]).toEqual({
      source: "auth-current-user-schema",
    });
  });

  it("throws a readable error when success response is not JSON", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response("<html></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    );

    await expect(fetchCurrentUser("https://srv", "tok")).rejects.toThrow(
      "The server returned an invalid session response. Please try again.",
    );
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

  it("models user cancellation as a null result without reporting a defect", async () => {
    const cancellationError = Object.assign(new Error("User canceled"), {
      code: "ERR_REQUEST_CANCELED",
    });
    mockSignInAsync.mockRejectedValueOnce(cancellationError);

    await expect(startNativeAppleSignIn("https://srv")).resolves.toBeNull();

    expect(fetch).not.toHaveBeenCalled();
    expect(mockCaptureException).not.toHaveBeenCalledWith(cancellationError, expect.anything());
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

  it("throws when server response omits isNewUser", async () => {
    mockSignInAsync.mockResolvedValueOnce({
      user: "apple-user-123",
      authorizationCode: "native-auth-code",
      identityToken: "native-identity-token",
      fullName: null,
      email: null,
      state: null,
      realUserStatus: 1,
      authorizedScopes: [],
    });

    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ session: "sess-native-123" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(startNativeAppleSignIn("https://srv")).rejects.toThrow(
      "Apple Sign In failed: invalid response",
    );
  });
});

describe("startOAuthLogin", () => {
  beforeEach(() => {
    vi.mocked(WebBrowser.openAuthSessionAsync).mockReset();
  });

  it("returns auth result from successful deep link", async () => {
    vi.mocked(WebBrowser.openAuthSessionAsync).mockResolvedValueOnce({
      type: "success",
      url: "dofek://auth/callback?code=exchange-oauth-1",
    });
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ session: "sess-oauth-1", isNewUser: true }), { status: 200 }),
    );

    const result = await startOAuthLogin("https://srv", "google", false);

    expect(result).toEqual({ session: "sess-oauth-1", isNewUser: true });
    expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalledWith(
      "https://srv/auth/login/google?redirect_scheme=dofek",
      "dofek://auth/callback",
    );
  });

  it("uses data-provider auth path when isDataProvider is true", async () => {
    vi.mocked(WebBrowser.openAuthSessionAsync).mockResolvedValueOnce({
      type: "success",
      url: "dofek://auth/callback?code=exchange-data-1",
    });
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ session: "sess-data-1", isNewUser: false }), { status: 200 }),
    );

    const result = await startOAuthLogin("https://srv", "strava", true);

    expect(result).toEqual({ session: "sess-data-1", isNewUser: false });
    expect(WebBrowser.openAuthSessionAsync).toHaveBeenCalledWith(
      "https://srv/auth/login/data/strava?redirect_scheme=dofek",
      "dofek://auth/callback",
    );
  });

  it("throws when OAuth callback is missing new_user", async () => {
    vi.mocked(WebBrowser.openAuthSessionAsync).mockResolvedValueOnce({
      type: "success",
      url: "dofek://auth/callback?code=exchange-oauth-1",
    });
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ session: "sess-oauth-1" }), { status: 200 }),
    );

    await expect(startOAuthLogin("https://srv", "google", false)).rejects.toThrow(
      "Authentication failed",
    );
  });

  it("preserves an OAuth exchange error response", async () => {
    vi.mocked(WebBrowser.openAuthSessionAsync).mockResolvedValueOnce({
      type: "success",
      url: "dofek://auth/callback?code=exchange-oauth-1",
    });
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Exchange code is invalid or expired" }), {
        status: 400,
      }),
    );

    await expect(startOAuthLogin("https://srv", "google", false)).rejects.toThrow(
      "Exchange code is invalid or expired",
    );
  });

  it("returns null when OAuth is cancelled", async () => {
    vi.mocked(WebBrowser.openAuthSessionAsync).mockResolvedValueOnce({
      type: "cancel",
    });

    await expect(startOAuthLogin("https://srv", "google", false)).resolves.toBeNull();
  });
});

describe("createProviderHandoffCode", () => {
  it("preserves a provider handoff error response", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Session expired" }), { status: 401 }),
    );

    await expect(
      createProviderHandoffCode("https://srv", "strava", "session-token"),
    ).rejects.toThrow("Session expired");
  });

  it("reports malformed JSON responses", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response("not-json", { status: 500 }));

    await expect(
      createProviderHandoffCode("https://srv", "strava", "session-token"),
    ).rejects.toThrow("Provider connection failed");
    expect(mockCaptureException).toHaveBeenCalledWith(expect.any(SyntaxError), {
      source: "provider-handoff-parse",
    });
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
      new Response(
        JSON.stringify({ session: "sess-password-1", isNewUser: false, redirect: "/" }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      ),
    );

    const result = await loginWithPassword("https://srv", "user@example.com", "password123");
    expect(result).toEqual({ session: "sess-password-1", isNewUser: false });
  });

  it("throws when login response omits isNewUser", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ session: "sess-password-1", redirect: "/" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      loginWithPassword("https://srv", "user@example.com", "password123"),
    ).rejects.toThrow("Authentication failed");
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
      new Response(JSON.stringify({ error: "Unable to create an account with these details" }), {
        status: 409,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      registerWithPassword("https://srv", "user@example.com", "password123", "User"),
    ).rejects.toThrow("Unable to create an account with these details");
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

  it("throws when registration response omits isNewUser", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ session: "sess-register-1", redirect: "/?newUser=true" }), {
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

describe("session token storage", () => {
  let SecureStore: typeof import("expo-secure-store");

  beforeEach(async () => {
    SecureStore = await import("expo-secure-store");
    await clearSessionToken();
    vi.clearAllMocks();
    vi.mocked(SecureStore.getItemAsync).mockReset();
    vi.mocked(SecureStore.setItemAsync).mockReset();
    vi.mocked(SecureStore.deleteItemAsync).mockReset();
    resetSessionTokenCacheForTests();
  });

  it("saveSessionToken stores with AFTER_FIRST_UNLOCK accessibility", async () => {
    await saveSessionToken("my-token");
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith("dofek_session_token", "my-token", {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
    });
  });

  it.each(["stale-restored-token", "new-login-token"])(
    "deletes a deferred %s write after cleanup starts",
    async (token) => {
      let resolveWrite: (() => void) | undefined;
      vi.mocked(SecureStore.setItemAsync).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveWrite = resolve;
          }),
      );
      const save = saveSessionToken(token);
      await vi.waitFor(() => expect(SecureStore.setItemAsync).toHaveBeenCalledOnce());

      const clear = clearSessionToken();
      expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();

      resolveWrite?.();
      await save;
      await clear;

      const tokenWriteOrder = vi.mocked(SecureStore.setItemAsync).mock.invocationCallOrder[0];
      const tokenDeleteCall = vi
        .mocked(SecureStore.deleteItemAsync)
        .mock.calls.findIndex(([key]) => key === "dofek_session_token");
      expect(tokenDeleteCall).toBeGreaterThanOrEqual(0);
      expect(
        vi.mocked(SecureStore.deleteItemAsync).mock.invocationCallOrder[tokenDeleteCall],
      ).toBeGreaterThan(tokenWriteOrder ?? 0);
    },
  );

  it("getSessionToken reads from the correct key", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValueOnce("stored-token");
    const token = await getSessionToken();
    expect(SecureStore.getItemAsync).toHaveBeenCalledWith("dofek_session_token");
    expect(token).toBe("stored-token");
  });

  it("getSessionToken returns cached token without hitting SecureStore again", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValueOnce("stored-token");
    await getSessionToken();
    await getSessionToken();

    expect(SecureStore.getItemAsync).toHaveBeenCalledTimes(1);
  });

  it("does not cache a deferred token read that cleanup invalidates", async () => {
    let resolveRead: ((token: string) => void) | undefined;
    vi.mocked(SecureStore.getItemAsync).mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve;
        }),
    );
    const read = getSessionToken();
    await vi.waitFor(() => expect(SecureStore.getItemAsync).toHaveBeenCalledOnce());

    const clear = clearSessionToken();
    resolveRead?.("stale-token");

    await expect(read).resolves.toBeNull();
    await clear;
    vi.mocked(SecureStore.getItemAsync).mockResolvedValueOnce(null);
    await expect(getSessionToken()).resolves.toBeNull();
  });

  it("getSessionToken throws when SecureStore is inaccessible", async () => {
    vi.mocked(SecureStore.getItemAsync).mockRejectedValueOnce(
      new Error("User interaction is not allowed"),
    );

    await expect(getSessionToken()).rejects.toThrow("User interaction is not allowed");
  });

  it("retries SecureStore after a transient accessibility failure without caching null", async () => {
    vi.mocked(SecureStore.getItemAsync)
      .mockRejectedValueOnce(new Error("User interaction is not allowed"))
      .mockResolvedValueOnce("stored-token");

    await expect(getSessionToken()).rejects.toThrow("User interaction is not allowed");
    expect(SecureStore.getItemAsync).toHaveBeenCalledTimes(1);

    await expect(getSessionToken()).resolves.toBe("stored-token");
    expect(SecureStore.getItemAsync).toHaveBeenCalledTimes(2);

    await expect(getSessionToken()).resolves.toBe("stored-token");
    expect(SecureStore.getItemAsync).toHaveBeenCalledTimes(2);
  });

  it("clearSessionToken deletes the correct key", async () => {
    await clearSessionToken();
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith("dofek_session_token");
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith("dofek_session_owner_nonce_v1");
  });

  it("rotates an opaque owner nonce for each adopted session", async () => {
    await expect(rotateSessionOwnerNonce()).resolves.toBe("11111111-1111-4111-8111-111111111111");
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      "dofek_session_owner_nonce_v1",
      "11111111-1111-4111-8111-111111111111",
      expect.any(Object),
    );
  });

  it("restores the persisted owner nonce after an app restart", async () => {
    vi.mocked(SecureStore.getItemAsync).mockResolvedValueOnce(
      "11111111-1111-4111-8111-111111111111",
    );

    await expect(getOrCreateSessionOwnerNonce()).resolves.toBe(
      "11111111-1111-4111-8111-111111111111",
    );
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it("deletes a deferred owner-nonce write after cleanup starts", async () => {
    let resolveWrite: (() => void) | undefined;
    vi.mocked(SecureStore.setItemAsync).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        }),
    );
    const rotate = rotateSessionOwnerNonce();
    await vi.waitFor(() => expect(SecureStore.setItemAsync).toHaveBeenCalledOnce());

    const clear = clearSessionToken();
    expect(SecureStore.deleteItemAsync).not.toHaveBeenCalled();

    resolveWrite?.();
    await rotate;
    await clear;
    expect(SecureStore.deleteItemAsync).toHaveBeenCalledWith("dofek_session_owner_nonce_v1");
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
    const logoutError = new Error("network error");
    vi.mocked(fetch).mockRejectedValueOnce(logoutError);

    await logout("https://srv", "my-token");

    expect(mockCaptureException).toHaveBeenCalledWith(logoutError, { source: "logout" });
  });
});
