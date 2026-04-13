import type { Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ──

const { mockRevokeToken, mockLogger, mockLoadTokens, mockGetAllProviders } = vi.hoisted(() => ({
  mockRevokeToken: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  mockLoadTokens: vi.fn(),
  mockGetAllProviders: vi.fn(),
}));

vi.mock("dofek/auth/oauth", () => ({
  revokeToken: (...args: unknown[]) => mockRevokeToken(...args),
}));

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
}));

vi.mock("../../logger.ts", () => ({ logger: mockLogger }));

vi.mock("../../lib/cache.ts", () => ({
  queryCache: { invalidateByPrefix: vi.fn() },
}));

vi.mock("../../auth/account-linking.ts", () => ({
  MissingEmailForSignupError: class extends Error {},
  resolveOrCreateUser: vi.fn(),
}));

vi.mock("../../auth/cookies.ts", () => ({
  getSessionIdFromRequest: vi.fn(),
  isValidMobileScheme: vi.fn(),
  setSessionCookie: vi.fn(),
}));

vi.mock("../../auth/session.ts", () => ({
  createSession: vi.fn(),
  validateSession: vi.fn(),
}));

vi.mock("./slack-oauth.ts", () => ({
  handleSlackCallback: vi.fn(),
}));

vi.mock("dofek/db/tokens", () => ({
  loadTokens: (...args: unknown[]) => mockLoadTokens(...args),
  ensureProvider: vi.fn(),
  saveTokens: vi.fn(),
}));

vi.mock("dofek/providers/registry", () => ({
  getAllProviders: () => mockGetAllProviders(),
}));

vi.mock("../../routers/sync.ts", () => ({
  ensureProvidersRegistered: vi.fn(),
}));

const mockOauthStateStore = {
  get: vi.fn(),
  has: vi.fn(),
  delete: vi.fn(),
};

const mockDb = {};
vi.mock("./shared.ts", () => ({
  getDb: () => mockDb,
  getOAuthStateStoreRef: () => mockOauthStateStore,
  getOAuth1SecretStoreRef: () => ({ get: vi.fn(), delete: vi.fn() }),
  oauthSuccessHtml: vi.fn(() => "<html>success</html>"),
  persistProviderConnection: vi.fn(),
  sanitizeReturnTo: vi.fn(),
  completeSignupHtml: vi.fn(),
  storePendingEmailSignup: vi.fn(),
}));

import { handleOAuth2Callback } from "./data-provider-callback.ts";

/** Type-safe partial mock helper — avoids banned `as` assertions. */
function mockOf<T extends object>(partial: Partial<T>): T {
  const result: T = partial;
  return result;
}

function createMockReqRes(query: Record<string, string> = {}) {
  const req = mockOf<Request>({
    query,
    get: vi.fn(() => "dofek.asherlc.com"),
  });

  const res = mockOf<Response>({
    status: vi.fn().mockReturnThis(),
    send: vi.fn(),
    type: vi.fn().mockReturnThis(),
    redirect: vi.fn(),
  });

  return { req, res };
}

describe("handleOAuth2Callback — revocation fallback", () => {
  const mockExchangeCode = vi.fn();
  const mockRevokeExistingTokens = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    // Set up: state store returns a valid entry
    mockOauthStateStore.get.mockResolvedValue({
      providerId: "wahoo",
      codeVerifier: undefined,
      intent: "data",
      linkUserId: undefined,
      userId: "user-1",
      returnTo: undefined,
    });
    mockOauthStateStore.has.mockResolvedValue(true);

    // Set up: provider registry returns a provider with revokeExistingTokens + revokeUrl
    mockGetAllProviders.mockReturnValue([
      {
        id: "wahoo",
        name: "Wahoo",
        authSetup: () => ({
          oauthConfig: {
            clientId: "test-id",
            clientSecret: "test-secret",
            authorizeUrl: "https://api.wahooligan.com/oauth/authorize",
            tokenUrl: "https://api.wahooligan.com/oauth/token",
            redirectUri: "https://dofek.asherlc.com/callback",
            scopes: ["user_read"],
            revokeUrl: "https://api.wahooligan.com/oauth/revoke",
          },
          exchangeCode: mockExchangeCode,
          revokeExistingTokens: mockRevokeExistingTokens,
        }),
      },
    ]);

    // Set up: exchange returns valid tokens
    mockExchangeCode.mockResolvedValue({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresAt: new Date("2027-01-01"),
      scopes: "user_read",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back to standard OAuth revocation when custom revocation fails", async () => {
    // Existing tokens in the database
    mockLoadTokens.mockResolvedValue({
      accessToken: "expired-access",
      refreshToken: "expired-refresh",
    });

    // Custom revocation throws (e.g. expired bearer token)
    mockRevokeExistingTokens.mockRejectedValue(new Error("401 Unauthorized"));

    const { req, res } = createMockReqRes({ code: "auth-code", state: "random-state" });
    await handleOAuth2Callback(req, res);

    // Custom revocation was attempted and failed
    expect(mockRevokeExistingTokens).toHaveBeenCalledOnce();

    // Standard OAuth revocation was called as fallback for both tokens
    expect(mockRevokeToken).toHaveBeenCalledTimes(2);
    expect(mockRevokeToken).toHaveBeenCalledWith(
      expect.objectContaining({ revokeUrl: "https://api.wahooligan.com/oauth/revoke" }),
      "expired-access",
    );
    expect(mockRevokeToken).toHaveBeenCalledWith(
      expect.objectContaining({ revokeUrl: "https://api.wahooligan.com/oauth/revoke" }),
      "expired-refresh",
    );

    // Exchange still proceeded
    expect(mockExchangeCode).toHaveBeenCalledWith("auth-code", undefined);

    // Warning was logged
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Custom token revocation failed for wahoo"),
    );

    // Success response was sent
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining("success"));
  });

  it("skips standard revocation when custom revocation succeeds", async () => {
    mockLoadTokens.mockResolvedValue({
      accessToken: "valid-access",
      refreshToken: "valid-refresh",
    });

    // Custom revocation succeeds
    mockRevokeExistingTokens.mockResolvedValue(undefined);

    const { req, res } = createMockReqRes({ code: "auth-code", state: "random-state" });
    await handleOAuth2Callback(req, res);

    // Custom revocation succeeded
    expect(mockRevokeExistingTokens).toHaveBeenCalledOnce();

    // Standard OAuth revocation was NOT called (custom succeeded)
    expect(mockRevokeToken).not.toHaveBeenCalled();

    // Exchange proceeded
    expect(mockExchangeCode).toHaveBeenCalled();
  });

  it("includes revocation context in logged error when exchange fails", async () => {
    mockLoadTokens.mockResolvedValue({
      accessToken: "expired-access",
      refreshToken: "expired-refresh",
    });

    // Both revocation methods fail
    mockRevokeExistingTokens.mockRejectedValue(new Error("401 Unauthorized"));
    mockRevokeToken.mockRejectedValue(new Error("Token revocation failed (503): Service error"));

    // Exchange also fails with the specific Wahoo "too many tokens" error
    mockExchangeCode.mockRejectedValue(new Error("Too many unrevoked access tokens"));

    const { req, res } = createMockReqRes({ code: "auth-code", state: "random-state" });
    await handleOAuth2Callback(req, res);

    // User gets actionable error with deauthorization instructions
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining("orphaned tokens"));
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining("cloud.wahoo.com/settings"));

    // The final logged error includes both the exchange error and the revocation context
    const allErrorMessages: string[] = mockLogger.error.mock.calls.map((call: unknown[]) =>
      String(call[0]),
    );
    const callbackError = allErrorMessages.find((message) =>
      message.includes("OAuth callback failed"),
    );
    expect(callbackError).toContain("Too many unrevoked access tokens");
    expect(callbackError).toContain("prior revocation");
  });

  it("shows deauthorization instructions when exchange fails with orphaned tokens and no stored tokens", async () => {
    // No stored tokens — orphaned tokens only exist on Wahoo's side
    mockLoadTokens.mockResolvedValue(null);

    // Exchange fails with the specific Wahoo "too many tokens" error
    mockExchangeCode.mockRejectedValue(
      new Error(
        'Token exchange failed (400): {"error":"Too many unrevoked access tokens exist for this app and user."}',
      ),
    );

    const { req, res } = createMockReqRes({ code: "auth-code", state: "random-state" });
    await handleOAuth2Callback(req, res);

    // User gets actionable instructions instead of generic error
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining("orphaned tokens"));
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining("cloud.wahoo.com/settings"));

    // Revocation was not attempted (no stored tokens)
    expect(mockRevokeExistingTokens).not.toHaveBeenCalled();
    expect(mockRevokeToken).not.toHaveBeenCalled();
  });
});
