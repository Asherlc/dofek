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
  getSavedSessionUser,
  getSessionToken,
  invalidateSessionPersistence,
  isNativeAppleSignInAvailable,
  loginWithPassword,
  logout,
  registerWithPassword,
  requestPasswordReset,
  resetSessionTokenCacheForTests,
  rotateSessionOwnerNonce,
  saveSessionToken,
  saveSessionUser,
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

  it("propagates the original non-cancellation native failure", async () => {
    const original = Object.assign(new Error("native diagnostic marker"), {
      code: "ERR_REQUEST_UNKNOWN",
    });
    mockSignInAsync.mockRejectedValueOnce(original);
    await expect(startNativeAppleSignIn("https://srv")).rejects.toBe(original);
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
  let storage: Map<string, string>;
  const savedUser = { id: "u1", name: "Alice", email: "alice@example.com" };

  beforeEach(async () => {
    SecureStore = await import("expo-secure-store");
    vi.clearAllMocks();
    vi.mocked(SecureStore.getItemAsync).mockReset();
    vi.mocked(SecureStore.setItemAsync).mockReset();
    vi.mocked(SecureStore.deleteItemAsync).mockReset();
    storage = new Map();
    vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => storage.get(key) ?? null);
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      storage.set(key, value);
    });
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      storage.delete(key);
    });
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
      storage.set("dofek_session_token", token);
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

  it("saves and restores only the user for the persisted session token", async () => {
    await saveSessionToken("saved-token");
    await saveSessionUser("saved-token", savedUser);
    resetSessionTokenCacheForTests();

    await expect(getSavedSessionUser("saved-token")).resolves.toEqual(savedUser);
    expect(storage.get("dofek_session_user_v1")).toBe(
      '{"id":"u1","name":"Alice","email":"alice@example.com"}',
    );
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
      "dofek_session_user_v1",
      expect.any(String),
      { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK },
    );
  });

  it("preserves the user while re-saving the same token for accessibility migration", async () => {
    storage.set("dofek_session_token", "saved-token");
    storage.set("dofek_session_user_v1", JSON.stringify(savedUser));

    await saveSessionToken("saved-token");

    expect(storage.get("dofek_session_user_v1")).toBe(JSON.stringify(savedUser));
  });

  it("deletes the previous user before replacing the token", async () => {
    storage.set("dofek_session_token", "old-token");
    storage.set("dofek_session_user_v1", JSON.stringify(savedUser));
    vi.mocked(SecureStore.setItemAsync).mockImplementation(async (key, value) => {
      if (key === "dofek_session_token") {
        expect(storage.has("dofek_session_user_v1")).toBe(false);
      }
      storage.set(key, value);
    });

    await saveSessionToken("new-token");

    expect(storage.get("dofek_session_token")).toBe("new-token");
    expect(storage.has("dofek_session_user_v1")).toBe(false);
  });

  it("keeps the previous token when deleting its user fails", async () => {
    storage.set("dofek_session_token", "old-token");
    storage.set("dofek_session_user_v1", JSON.stringify(savedUser));
    vi.mocked(SecureStore.deleteItemAsync).mockRejectedValueOnce(new Error("keychain failure"));

    await expect(saveSessionToken("new-token")).rejects.toThrow("keychain failure");

    expect(storage.get("dofek_session_token")).toBe("old-token");
  });

  it("keeps the previous token when its saved user cannot be deleted while locked", async () => {
    storage.set("dofek_session_token", "old-token");
    storage.set("dofek_session_user_v1", JSON.stringify(savedUser));
    vi.mocked(SecureStore.deleteItemAsync).mockRejectedValueOnce(
      new Error("User interaction is not allowed"),
    );

    await expect(saveSessionToken("new-token")).rejects.toThrow();

    expect(storage.get("dofek_session_token")).toBe("old-token");
  });

  it("leaves no saved identity when replacement stops after deleting the previous user", async () => {
    storage.set("dofek_session_token", "old-token");
    storage.set("dofek_session_user_v1", JSON.stringify(savedUser));
    vi.mocked(SecureStore.setItemAsync).mockRejectedValueOnce(new Error("token write failed"));

    await expect(saveSessionToken("new-token")).rejects.toThrow("token write failed");
    resetSessionTokenCacheForTests();

    expect(storage.get("dofek_session_token")).toBe("old-token");
    await expect(getSavedSessionUser("old-token")).resolves.toBeNull();
  });

  it("does not restore another token's saved user", async () => {
    storage.set("dofek_session_token", "current-token");
    storage.set("dofek_session_user_v1", JSON.stringify(savedUser));

    await expect(getSavedSessionUser("previous-token")).resolves.toBeNull();
  });

  it("does not overwrite another token's saved user", async () => {
    storage.set("dofek_session_token", "current-token");
    storage.set("dofek_session_user_v1", JSON.stringify(savedUser));

    await saveSessionUser("previous-token", { id: "u2", name: "Bob", email: null });

    expect(storage.get("dofek_session_user_v1")).toBe(JSON.stringify(savedUser));
  });

  it("requires a persisted token before storing or restoring a user", async () => {
    await saveSessionUser("missing-token", savedUser);

    expect(storage.has("dofek_session_user_v1")).toBe(false);
    await expect(getSavedSessionUser("missing-token")).resolves.toBeNull();
  });

  it("requires online identity verification when only a token was saved before a restart", async () => {
    await saveSessionToken("saved-token");
    resetSessionTokenCacheForTests();

    await expect(getSavedSessionUser("saved-token")).resolves.toBeNull();
  });

  it.each(["not-json", '{"id":"u1"}', "null"])(
    "throws for corrupted saved-user data: %s",
    async (rawUser) => {
      storage.set("dofek_session_token", "saved-token");
      storage.set("dofek_session_user_v1", rawUser);

      await expect(getSavedSessionUser("saved-token")).rejects.toThrow();
    },
  );

  it("clears the saved user with the token during logout", async () => {
    storage.set("dofek_session_token", "saved-token");
    storage.set("dofek_session_user_v1", JSON.stringify(savedUser));

    await clearSessionToken();

    expect(storage.has("dofek_session_token")).toBe(false);
    expect(storage.has("dofek_session_user_v1")).toBe(false);
    await expect(getSavedSessionUser("saved-token")).resolves.toBeNull();
  });

  it("surfaces a saved-user deletion failure during logout", async () => {
    storage.set("dofek_session_token", "saved-token");
    storage.set("dofek_session_user_v1", JSON.stringify(savedUser));
    vi.mocked(SecureStore.deleteItemAsync).mockImplementation(async (key) => {
      if (key === "dofek_session_user_v1") {
        throw new Error("User interaction is not allowed");
      }
      storage.delete(key);
    });

    await expect(clearSessionToken()).rejects.toThrow("User interaction is not allowed");
  });

  it.each(["dofek_session_token", "dofek_session_user_v1"])(
    "does not restore a user when cleanup invalidates its %s read",
    async (deferredKey) => {
      storage.set("dofek_session_token", "saved-token");
      storage.set("dofek_session_user_v1", JSON.stringify(savedUser));
      let resolveRead: ((value: string | null) => void) | undefined;
      vi.mocked(SecureStore.getItemAsync).mockImplementation(async (key) => {
        if (key === deferredKey) {
          return new Promise<string | null>((resolve) => {
            resolveRead = resolve;
          });
        }
        return storage.get(key) ?? null;
      });

      const read = getSavedSessionUser("saved-token");
      await vi.waitFor(() => expect(resolveRead).toBeTypeOf("function"));
      invalidateSessionPersistence();
      resolveRead?.(storage.get(deferredKey) ?? null);

      await expect(read).resolves.toBeNull();
    },
  );

  it("does not save a user when cleanup invalidates its token read", async () => {
    storage.set("dofek_session_token", "saved-token");
    let resolveRead: ((value: string | null) => void) | undefined;
    vi.mocked(SecureStore.getItemAsync).mockImplementationOnce(
      () =>
        new Promise<string | null>((resolve) => {
          resolveRead = resolve;
        }),
    );

    const write = saveSessionUser("saved-token", savedUser);
    await vi.waitFor(() => expect(resolveRead).toBeTypeOf("function"));
    invalidateSessionPersistence();
    resolveRead?.("saved-token");
    await write;

    expect(storage.has("dofek_session_user_v1")).toBe(false);
  });

  it("does not run queued saved-user operations after cleanup invalidates them", async () => {
    storage.set("dofek_session_token", "saved-token");
    storage.set("dofek_session_user_v1", JSON.stringify(savedUser));
    let resolveRead: ((value: string | null) => void) | undefined;
    vi.mocked(SecureStore.getItemAsync).mockImplementationOnce(
      () =>
        new Promise<string | null>((resolve) => {
          resolveRead = resolve;
        }),
    );
    const blockingRead = getSessionToken();
    await vi.waitFor(() => expect(resolveRead).toBeTypeOf("function"));
    const queuedRead = getSavedSessionUser("saved-token");
    const queuedWrite = saveSessionUser("saved-token", { id: "u2", name: "Bob", email: null });

    const clear = clearSessionToken();
    resolveRead?.("saved-token");
    await Promise.all([blockingRead, queuedWrite, clear]);

    await expect(queuedRead).resolves.toBeNull();
    expect(storage.has("dofek_session_user_v1")).toBe(false);
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it("deletes an in-flight saved-user write after cleanup starts", async () => {
    storage.set("dofek_session_token", "saved-token");
    let resolveWrite: (() => void) | undefined;
    vi.mocked(SecureStore.setItemAsync).mockImplementationOnce(
      (key, value) =>
        new Promise<void>((resolve) => {
          resolveWrite = () => {
            storage.set(key, value);
            resolve();
          };
        }),
    );
    const write = saveSessionUser("saved-token", savedUser);
    await vi.waitFor(() => expect(resolveWrite).toBeTypeOf("function"));

    const clear = clearSessionToken();
    resolveWrite?.();
    await Promise.all([write, clear]);

    expect(storage.has("dofek_session_user_v1")).toBe(false);
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
