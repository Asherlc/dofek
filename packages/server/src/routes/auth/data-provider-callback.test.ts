import type { Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ──

const {
  mockRevokeToken,
  mockLogger,
  mockLoadTokens,
  mockDeleteTokens,
  mockInvalidateByPrefix,
  mockGetAllProviders,
  mockResolveOrCreateUser,
  mockGetSessionIdFromRequest,
  mockValidateSession,
  mockPersistProviderConnection,
  mockIssuePendingEmailSignup,
} = vi.hoisted(() => ({
  mockRevokeToken: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  mockLoadTokens: vi.fn(),
  mockDeleteTokens: vi.fn(),
  mockInvalidateByPrefix: vi.fn(),
  mockGetAllProviders: vi.fn(),
  mockResolveOrCreateUser: vi.fn(),
  mockGetSessionIdFromRequest: vi.fn(),
  mockValidateSession: vi.fn(),
  mockPersistProviderConnection: vi.fn(),
  mockIssuePendingEmailSignup: vi.fn(),
}));

vi.mock("dofek/auth/oauth", () => ({
  revokeToken: (...args: unknown[]) => mockRevokeToken(...args),
}));

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
}));

vi.mock("../../logger.ts", () => ({ logger: mockLogger }));

vi.mock("dofek/lib/cache", () => ({
  queryCache: { invalidateByPrefix: mockInvalidateByPrefix },
}));

vi.mock("../../auth/account-linking.ts", () => ({
  MissingEmailForSignupError: class extends Error {},
  resolveOrCreateUser: (...args: unknown[]) => mockResolveOrCreateUser(...args),
}));

vi.mock("../../auth/cookies.ts", () => ({
  getSessionIdFromRequest: (...args: unknown[]) => mockGetSessionIdFromRequest(...args),
  isValidMobileScheme: vi.fn(),
  setSessionCookie: vi.fn(),
}));

vi.mock("../../auth/session.ts", () => ({
  createSession: vi.fn(),
  validateSession: (...args: unknown[]) => mockValidateSession(...args),
}));

vi.mock("./slack-oauth.ts", () => ({
  handleSlackCallback: vi.fn(),
}));

vi.mock("dofek/db/tokens", () => ({
  loadTokens: (...args: unknown[]) => mockLoadTokens(...args),
  deleteTokens: (...args: unknown[]) => mockDeleteTokens(...args),
  ensureProvider: vi.fn(),
  saveTokens: vi.fn(),
}));

vi.mock("dofek/providers/registry", () => ({
  getAllProviders: () => mockGetAllProviders(),
}));

vi.mock("../../routers/sync-helpers.ts", () => ({
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
  persistProviderConnection: (...args: unknown[]) => mockPersistProviderConnection(...args),
  sanitizeReturnTo: vi.fn(),
  completeSignupHtml: vi.fn(
    (providerName: string, token: string) => `<html>${providerName}:${token}</html>`,
  ),
  getPendingEmailSignupStoreRef: vi.fn(() => ({
    issue: mockIssuePendingEmailSignup,
  })),
}));

import { MissingEmailForSignupError } from "../../auth/account-linking.ts";
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
          reconnectStrategy: "revoke-then-replace",
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
    mockGetSessionIdFromRequest.mockReturnValue(undefined);
    mockValidateSession.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not attempt a less authoritative fallback when required revocation fails", async () => {
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

    expect(mockRevokeToken).not.toHaveBeenCalled();
    expect(mockExchangeCode).not.toHaveBeenCalled();
    expect(mockDeleteTokens).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith(
      expect.stringContaining("existing connection is still active"),
    );
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

    expect(mockDeleteTokens).toHaveBeenCalledWith(mockDb, "wahoo", "user-1");

    // Exchange proceeded
    expect(mockExchangeCode).toHaveBeenCalled();
  });

  it("explains that the previous authorization was removed when token limits still block exchange", async () => {
    mockLoadTokens.mockResolvedValue({
      accessToken: "expired-access",
      refreshToken: "expired-refresh",
    });

    mockRevokeExistingTokens.mockResolvedValue(undefined);

    // Exchange also fails with the specific Wahoo "too many tokens" error
    mockExchangeCode.mockRejectedValue(new Error("Too many unrevoked access tokens"));

    const { req, res } = createMockReqRes({ code: "auth-code", state: "random-state" });
    await handleOAuth2Callback(req, res);

    // User gets actionable error with deauthorization instructions
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining("orphaned tokens"));
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining("Authorized Apps"));
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining("Settings"));
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining("wahooligan.com/profile"));
    expect(res.send).toHaveBeenCalledWith(
      expect.stringContaining("previous Wahoo authorization was removed"),
    );
  });

  it("preserves an existing connection when exchange fails for a safe reconnect", async () => {
    mockGetAllProviders.mockReturnValue([
      {
        id: "ride-with-gps",
        name: "Ride with GPS",
        authSetup: () => ({
          oauthConfig: {
            clientId: "test-id",
            clientSecret: "test-secret",
            authorizeUrl: "https://ridewithgps.com/oauth/authorize",
            tokenUrl: "https://ridewithgps.com/oauth/token.json",
            redirectUri: "https://dofek.example/callback",
            scopes: ["user"],
            revokeUrl: "https://ridewithgps.com/oauth/revoke",
          },
          exchangeCode: mockExchangeCode,
        }),
      },
    ]);
    mockOauthStateStore.get.mockResolvedValue({
      providerId: "ride-with-gps",
      codeVerifier: undefined,
      intent: "data",
      linkUserId: undefined,
      userId: "user-1",
      returnTo: undefined,
    });
    mockLoadTokens.mockResolvedValue({
      accessToken: "working-access",
      refreshToken: "working-refresh",
    });
    mockExchangeCode.mockRejectedValue(new Error("provider unavailable"));

    const { req, res } = createMockReqRes({ code: "auth-code", state: "random-state" });
    await handleOAuth2Callback(req, res);

    expect(mockExchangeCode).toHaveBeenCalledOnce();
    expect(mockRevokeToken).not.toHaveBeenCalled();
    expect(mockDeleteTokens).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith(
      expect.stringContaining("existing connection is still active"),
    );
  });

  it("clears confirmed revoked credentials when a destructive exchange fails", async () => {
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
            redirectUri: "https://dofek.example/callback",
            scopes: ["user_read"],
          },
          exchangeCode: mockExchangeCode,
          revokeExistingTokens: mockRevokeExistingTokens,
          reconnectStrategy: "revoke-then-replace",
        }),
      },
    ]);
    mockLoadTokens.mockResolvedValue({
      accessToken: "working-access",
      refreshToken: "working-refresh",
    });
    mockRevokeExistingTokens.mockResolvedValue(undefined);
    mockExchangeCode.mockRejectedValue(new Error("token endpoint unavailable"));

    const { req, res } = createMockReqRes({ code: "auth-code", state: "random-state" });
    await handleOAuth2Callback(req, res);

    expect(mockRevokeExistingTokens).toHaveBeenCalledOnce();
    expect(mockDeleteTokens).toHaveBeenCalledWith(mockDb, "wahoo", "user-1");
    expect(mockInvalidateByPrefix).toHaveBeenCalledWith("user-1:sync.providers");
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith(
      expect.stringContaining("previous Wahoo authorization was removed"),
    );
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining("connect Wahoo again"));
  });

  it("retains existing credentials and aborts exchange when required revocation fails", async () => {
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
            redirectUri: "https://dofek.example/callback",
            scopes: ["user_read"],
          },
          exchangeCode: mockExchangeCode,
          revokeExistingTokens: mockRevokeExistingTokens,
          reconnectStrategy: "revoke-then-replace",
        }),
      },
    ]);
    mockLoadTokens.mockResolvedValue({
      accessToken: "working-access",
      refreshToken: "working-refresh",
    });
    mockRevokeExistingTokens.mockRejectedValue(new Error("revocation unavailable"));

    const { req, res } = createMockReqRes({ code: "auth-code", state: "random-state" });
    await handleOAuth2Callback(req, res);

    expect(mockDeleteTokens).not.toHaveBeenCalled();
    expect(mockExchangeCode).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith(
      expect.stringContaining("existing connection is still active"),
    );
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
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining("Authorized Apps"));
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining("Settings"));
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining("wahooligan.com/profile"));

    // Revocation was not attempted (no stored tokens)
    expect(mockRevokeExistingTokens).not.toHaveBeenCalled();
    expect(mockRevokeToken).not.toHaveBeenCalled();
  });

  it("links a mobile data-provider callback using the authenticated OAuth state", async () => {
    const mockGetUserIdentity = vi.fn().mockResolvedValue({
      providerAccountId: "wahoo-account-1",
      email: "wahoo@example.com",
      name: "Wahoo User",
    });
    mockGetAllProviders.mockReturnValue([
      {
        id: "wahoo",
        name: "Wahoo",
        authSetup: () => ({
          oauthConfig: { clientId: "test-id", redirectUri: "https://dofek.example/callback" },
          exchangeCode: mockExchangeCode,
          getUserIdentity: mockGetUserIdentity,
        }),
      },
    ]);

    const { req, res } = createMockReqRes({ code: "auth-code", state: "random-state" });
    await handleOAuth2Callback(req, res);

    expect(mockGetSessionIdFromRequest).toHaveBeenCalledWith(req);
    expect(mockValidateSession).not.toHaveBeenCalled();
    expect(mockResolveOrCreateUser).toHaveBeenCalledWith(
      mockDb,
      "wahoo",
      expect.objectContaining({ providerAccountId: "wahoo-account-1" }),
      "user-1",
    );
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining("success"));
  });

  it("rejects a callback session that differs from the authenticated OAuth state", async () => {
    const mockGetUserIdentity = vi.fn().mockResolvedValue({
      providerAccountId: "wahoo-account-2",
      email: "wahoo@example.com",
      name: "Wahoo User",
    });
    mockGetAllProviders.mockReturnValue([
      {
        id: "wahoo",
        name: "Wahoo",
        authSetup: () => ({
          oauthConfig: { clientId: "test-id", redirectUri: "https://dofek.example/callback" },
          exchangeCode: mockExchangeCode,
          getUserIdentity: mockGetUserIdentity,
        }),
      },
    ]);
    mockGetSessionIdFromRequest.mockReturnValue("callback-session");
    mockValidateSession.mockResolvedValue({
      userId: "different-user",
      expiresAt: new Date("2027-01-01"),
    });

    const { req, res } = createMockReqRes({ code: "auth-code", state: "random-state" });
    await handleOAuth2Callback(req, res);

    expect(mockGetUserIdentity).not.toHaveBeenCalled();
    expect(mockLoadTokens).not.toHaveBeenCalled();
    expect(mockRevokeToken).not.toHaveBeenCalled();
    expect(mockExchangeCode).not.toHaveBeenCalled();
    expect(mockResolveOrCreateUser).not.toHaveBeenCalled();
    expect(mockPersistProviderConnection).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("does not match authenticated OAuth state"),
      expect.anything(),
    );
  });

  it("awaits pending signup issuance and renders the issued token when email is missing", async () => {
    mockOauthStateStore.get.mockResolvedValue({
      providerId: "wahoo",
      codeVerifier: undefined,
      intent: "login",
      linkUserId: undefined,
      userId: undefined,
      returnTo: "/dashboard",
    });
    const mockGetUserIdentity = vi.fn().mockResolvedValue({
      providerAccountId: "wahoo-account-without-email",
      email: null,
      name: "Wahoo User",
    });
    mockGetAllProviders.mockReturnValue([
      {
        id: "wahoo",
        name: "Wahoo",
        authSetup: () => ({
          oauthConfig: { clientId: "test-id", redirectUri: "https://dofek.example/callback" },
          exchangeCode: mockExchangeCode,
          getUserIdentity: mockGetUserIdentity,
        }),
      },
    ]);
    mockResolveOrCreateUser.mockRejectedValue(new MissingEmailForSignupError());
    mockIssuePendingEmailSignup.mockResolvedValue("issued-pending-token");

    const { req, res } = createMockReqRes({ code: "auth-code", state: "random-state" });
    await handleOAuth2Callback(req, res);

    expect(mockIssuePendingEmailSignup).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: "wahoo",
        providerName: "Wahoo",
        returnTo: "/dashboard",
      }),
    );
    expect(res.send).toHaveBeenCalledWith("<html>Wahoo:issued-pending-token</html>");
  });
});
