import * as Sentry from "@sentry/node";
import type { Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Mocks ──

const {
  mockRevokeToken,
  mockLogger,
  mockLoadTokens,
  mockDeleteTokens,
  mockDeleteProviderAuthorization,
  mockInvalidateByPrefix,
  mockGetAllProviders,
  mockResolveOrCreateUser,
  mockGetSessionIdFromRequest,
  mockValidateSession,
  mockPersistProviderConnection,
  mockIssuePendingEmailSignup,
  mockFindExistingUserId,
  mockIdentityWriteFence,
  mockLockIdentityFence,
  mockWithUserWriteFence,
  MockAccountErasureUserFencedError,
} = vi.hoisted(() => ({
  mockRevokeToken: vi.fn(),
  mockLogger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  mockLoadTokens: vi.fn(),
  mockDeleteTokens: vi.fn(),
  mockDeleteProviderAuthorization: vi.fn(),
  mockInvalidateByPrefix: vi.fn(),
  mockGetAllProviders: vi.fn(),
  mockResolveOrCreateUser: vi.fn(),
  mockGetSessionIdFromRequest: vi.fn(),
  mockValidateSession: vi.fn(),
  mockPersistProviderConnection: vi.fn(),
  mockIssuePendingEmailSignup: vi.fn(),
  mockFindExistingUserId: vi.fn(),
  mockIdentityWriteFence: vi.fn(),
  mockLockIdentityFence: vi.fn(),
  mockWithUserWriteFence: vi.fn(),
  MockAccountErasureUserFencedError: class MockAccountErasureUserFencedError extends Error {
    constructor(cause?: unknown) {
      super("Account deletion is active for this user.", { cause });
    }
  },
}));

vi.mock("dofek/auth/oauth", () => ({
  revokeToken: (...args: unknown[]) => mockRevokeToken(...args),
}));

vi.mock("dofek/db/account-erasure", () => ({
  AccountErasureIdentityFencedError: class AccountErasureIdentityFencedError extends Error {},
  AccountErasureUserFencedError: MockAccountErasureUserFencedError,
  lockAndAssertAccountErasureIdentityWriteFence: mockLockIdentityFence,
  withAccountErasureUserAndIdentityWriteFence: mockIdentityWriteFence,
  withAccountErasureUserWriteFence: mockWithUserWriteFence,
}));

vi.mock("dofek/lib/error-reporting", () => ({
  captureException: vi.fn(),
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
  findExistingUserId: (...args: unknown[]) => mockFindExistingUserId(...args),
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

vi.mock("dofek/db/tokens", () => ({
  loadTokens: (...args: unknown[]) => mockLoadTokens(...args),
  deleteTokens: (...args: unknown[]) => mockDeleteTokens(...args),
  deleteProviderAuthorization: (...args: unknown[]) => mockDeleteProviderAuthorization(...args),
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

import { captureException } from "dofek/lib/error-reporting";
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
    mockWithUserWriteFence.mockImplementation(
      async (
        _database: unknown,
        _userId: string,
        operation: (database: typeof mockDb) => Promise<unknown>,
      ) => operation(mockDb),
    );
    mockIdentityWriteFence.mockImplementation(
      async (
        _database: unknown,
        _userId: string,
        _identities: unknown,
        operation: (database: typeof mockDb) => Promise<unknown>,
      ) => operation(mockDb),
    );
    mockLockIdentityFence.mockResolvedValue(undefined);
    mockFindExistingUserId.mockResolvedValue("user-1");

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

    // Set up: Wahoo uses documented deauthorization only after its exact token-limit error.
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
          },
          exchangeCode: mockExchangeCode,
          reconnectStrategy: "deauthorize-on-token-limit",
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

  it("handles callback requests before provider resolution", async () => {
    const bare = createMockReqRes();
    await handleOAuth2Callback(bare.req, bare.res);
    expect(bare.res.send).toHaveBeenCalledWith("OK");

    const denied = createMockReqRes({ error: "access_denied" });
    await handleOAuth2Callback(denied.req, denied.res);
    expect(denied.res.status).toHaveBeenCalledWith(400);
    expect(denied.res.send).toHaveBeenCalledWith("Authorization denied");

    const incomplete = createMockReqRes({ code: "only-code" });
    await handleOAuth2Callback(incomplete.req, incomplete.res);
    expect(incomplete.res.status).toHaveBeenCalledWith(400);
    expect(incomplete.res.send).toHaveBeenCalledWith("Missing code or state parameter");
  });

  it("rejects unknown or unsupported OAuth state entries", async () => {
    mockOauthStateStore.get.mockResolvedValueOnce(null);
    const unknownState = createMockReqRes({ code: "code", state: "expired" });
    await handleOAuth2Callback(unknownState.req, unknownState.res);
    expect(unknownState.res.status).toHaveBeenCalledWith(400);
    expect(unknownState.res.send).toHaveBeenCalledWith(
      expect.stringContaining("Unknown or expired"),
    );

    mockOauthStateStore.get.mockResolvedValueOnce({
      codeVerifier: undefined,
      intent: "data",
      linkUserId: undefined,
      providerId: "unsupported",
      returnTo: undefined,
      userId: "user-1",
    });
    mockGetAllProviders.mockReturnValueOnce([]);
    const unknownProvider = createMockReqRes({ code: "code", state: "state" });
    await handleOAuth2Callback(unknownProvider.req, unknownProvider.res);
    expect(unknownProvider.res.status).toHaveBeenCalledWith(404);
    expect(unknownProvider.res.send).toHaveBeenCalledWith("Unknown provider");

    mockOauthStateStore.get.mockResolvedValueOnce({
      codeVerifier: undefined,
      intent: "data",
      linkUserId: undefined,
      providerId: "unsupported",
      returnTo: undefined,
      userId: "user-1",
    });
    mockGetAllProviders.mockReturnValueOnce([
      { id: "unsupported", name: "Unsupported", authSetup: () => ({}) },
    ]);
    const unsupportedProvider = createMockReqRes({ code: "code", state: "state" });
    await handleOAuth2Callback(unsupportedProvider.req, unsupportedProvider.res);
    expect(unsupportedProvider.res.status).toHaveBeenCalledWith(400);
    expect(unsupportedProvider.res.send).toHaveBeenCalledWith(
      "Provider does not support OAuth code exchange",
    );
  });

  it("exchanges and persists a successful Wahoo reconnect without revocation", async () => {
    const events: string[] = [];
    mockLoadTokens.mockImplementation(async () => {
      events.push("load");
      return {
        accessToken: "valid-access",
        refreshToken: "valid-refresh",
      };
    });
    mockExchangeCode.mockImplementation(async () => {
      events.push("exchange-new-grant");
      return {
        accessToken: "new-access",
        refreshToken: "new-refresh",
        expiresAt: new Date("2027-01-01"),
        scopes: "user_read",
      };
    });
    mockPersistProviderConnection.mockImplementation(async () => {
      events.push("persist-new-tokens");
    });

    const { req, res } = createMockReqRes({ code: "auth-code", state: "random-state" });
    await handleOAuth2Callback(req, res);

    expect(events).toEqual(["load", "exchange-new-grant", "persist-new-tokens"]);
    expect(mockRevokeExistingTokens).not.toHaveBeenCalled();
    expect(mockRevokeToken).not.toHaveBeenCalled();
    expect(mockDeleteTokens).not.toHaveBeenCalled();
    expect(mockInvalidateByPrefix).not.toHaveBeenCalled();
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining("success"));
  });

  it("deauthorizes and removes stored credentials after Wahoo's exact token-limit error", async () => {
    const events: string[] = [];
    mockLoadTokens.mockResolvedValue({
      accessToken: "expired-access",
      refreshToken: "expired-refresh",
    });
    mockExchangeCode.mockImplementation(async () => {
      events.push("exchange-new-grant");
      throw new Error(
        'Token exchange failed (400): {"error":"Too many unrevoked access tokens exist for this app and user."}',
      );
    });
    mockRevokeExistingTokens.mockImplementation(async () => {
      events.push("deauthorize-all-permissions");
    });
    mockDeleteProviderAuthorization.mockImplementation(async () => {
      events.push("delete-provider-authorization");
    });
    mockInvalidateByPrefix.mockImplementation(async () => {
      events.push("invalidate-cache");
    });

    const { req, res } = createMockReqRes({ code: "auth-code", state: "random-state" });
    await handleOAuth2Callback(req, res);

    expect(events).toEqual([
      "exchange-new-grant",
      "deauthorize-all-permissions",
      "delete-provider-authorization",
      "invalidate-cache",
    ]);
    expect(mockRevokeExistingTokens).toHaveBeenCalledWith({
      accessToken: "expired-access",
      refreshToken: "expired-refresh",
    });
    expect(mockDeleteProviderAuthorization).toHaveBeenCalledWith(mockDb, "wahoo", "user-1");
    expect(mockDeleteTokens).not.toHaveBeenCalled();
    expect(mockPersistProviderConnection).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining("authorization reset"));
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining("fresh grant"));
    expect(res.send).toHaveBeenCalledWith(
      expect.stringContaining("previous Wahoo authorization was removed"),
    );
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining("/auth/provider/wahoo"));
    expect(res.send).not.toHaveBeenCalledWith(expect.stringContaining("Authorized Apps"));
  });

  it("preserves the existing Wahoo connection after a generic exchange failure", async () => {
    mockLoadTokens.mockResolvedValue({
      accessToken: "existing-access",
      refreshToken: "existing-refresh",
    });
    mockExchangeCode.mockRejectedValue(new Error("token endpoint unavailable"));

    const { req, res } = createMockReqRes({ code: "auth-code", state: "random-state" });
    await handleOAuth2Callback(req, res);

    expect(mockRevokeExistingTokens).not.toHaveBeenCalled();
    expect(mockDeleteProviderAuthorization).not.toHaveBeenCalled();
    expect(mockDeleteTokens).not.toHaveBeenCalled();
    expect(mockInvalidateByPrefix).not.toHaveBeenCalled();
    expect(mockPersistProviderConnection).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith(
      expect.stringContaining("existing connection is still active"),
    );
  });

  it("rejects a known-user callback before exchanging remote credentials when erasure is active", async () => {
    mockWithUserWriteFence.mockRejectedValueOnce(new Error("Account erasure is active"));
    const { req, res } = createMockReqRes({ code: "code-1", state: "state-1" });

    await handleOAuth2Callback(req, res);

    expect(mockWithUserWriteFence).toHaveBeenCalledWith(mockDb, "user-1", expect.any(Function));
    expect(mockExchangeCode).not.toHaveBeenCalled();
    expect(mockPersistProviderConnection).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it("revokes newly issued credentials when durable persistence fails", async () => {
    mockLoadTokens.mockResolvedValue(null);
    mockPersistProviderConnection.mockRejectedValueOnce(new Error("commit failed"));
    const { req, res } = createMockReqRes({
      code: "code-1",
      state: "state-1",
    });

    await handleOAuth2Callback(req, res);

    expect(mockRevokeExistingTokens).toHaveBeenCalledWith({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresAt: new Date("2027-01-01"),
      scopes: "user_read",
    });
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it("preserves local credentials when token-limit deauthorization fails", async () => {
    mockLoadTokens.mockResolvedValue({
      accessToken: "existing-access",
      refreshToken: "existing-refresh",
    });
    mockExchangeCode.mockRejectedValue(new Error("Too many unrevoked access tokens"));
    mockRevokeExistingTokens.mockRejectedValue(new Error("Wahoo deauthorization unavailable"));

    const { req, res } = createMockReqRes({ code: "auth-code", state: "random-state" });
    await handleOAuth2Callback(req, res);

    expect(mockRevokeExistingTokens).toHaveBeenCalledOnce();
    expect(mockDeleteProviderAuthorization).not.toHaveBeenCalled();
    expect(mockDeleteTokens).not.toHaveBeenCalled();
    expect(mockInvalidateByPrefix).not.toHaveBeenCalled();
    expect(mockPersistProviderConnection).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Wahoo deauthorization unavailable" }),
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith(
      expect.stringContaining("existing connection is still active"),
    );
  });

  it("preserves an existing connection when exchange fails for a safe reconnect", async () => {
    const transactionEvents: string[] = [];
    mockWithUserWriteFence.mockImplementationOnce(
      async (
        _database: unknown,
        _userId: string,
        operation: (database: typeof mockDb) => Promise<unknown>,
      ) => {
        try {
          const result = await operation(mockDb);
          transactionEvents.push("commit");
          return result;
        } catch (error: unknown) {
          transactionEvents.push("rollback");
          throw error;
        }
      },
    );
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
    mockExchangeCode.mockImplementation(async () => {
      transactionEvents.push("exchange-failed");
      throw new Error("provider unavailable");
    });

    const { req, res } = createMockReqRes({ code: "auth-code", state: "random-state" });
    await handleOAuth2Callback(req, res);

    expect(mockExchangeCode).toHaveBeenCalledOnce();
    expect(mockRevokeToken).not.toHaveBeenCalled();
    expect(mockDeleteTokens).not.toHaveBeenCalled();
    expect(transactionEvents).toEqual(["exchange-failed", "rollback"]);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith(
      expect.stringContaining("existing connection is still active"),
    );
  });

  it("revokes only present superseded tokens after a safe replacement succeeds", async () => {
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
      refreshToken: null,
    });
    mockRevokeToken.mockResolvedValue(undefined);

    const { req, res } = createMockReqRes({ code: "auth-code", state: "random-state" });
    await handleOAuth2Callback(req, res);

    expect(mockPersistProviderConnection).toHaveBeenCalledOnce();
    expect(mockRevokeToken).toHaveBeenCalledOnce();
    expect(mockRevokeToken).toHaveBeenCalledWith(
      expect.objectContaining({ revokeUrl: "https://ridewithgps.com/oauth/revoke" }),
      "working-access",
    );
    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining("success"));
  });

  it("keeps a safe replacement active when one superseded token cannot be revoked", async () => {
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
    mockRevokeToken
      .mockRejectedValueOnce(new Error("revocation endpoint unavailable"))
      .mockResolvedValueOnce(undefined);

    const { req, res } = createMockReqRes({ code: "auth-code", state: "random-state" });
    await handleOAuth2Callback(req, res);

    expect(mockPersistProviderConnection).toHaveBeenCalledOnce();
    expect(mockRevokeToken).toHaveBeenCalledTimes(2);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("access token revocation failed: revocation endpoint unavailable"),
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("superseded authorization cleanup failed"),
    );
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining("success"));
  });

  it("falls back to standard revocation after safe custom cleanup fails", async () => {
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
          revokeExistingTokens: mockRevokeExistingTokens,
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
    mockRevokeExistingTokens.mockRejectedValue(new Error("custom cleanup unavailable"));
    mockRevokeToken.mockResolvedValue(undefined);

    const { req, res } = createMockReqRes({ code: "auth-code", state: "random-state" });
    await handleOAuth2Callback(req, res);

    expect(mockPersistProviderConnection).toHaveBeenCalledOnce();
    expect(mockRevokeExistingTokens).toHaveBeenCalledOnce();
    expect(mockRevokeToken).toHaveBeenCalledTimes(2);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Custom revocation failed"),
    );
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining("success"));
  });

  it("uses successful safe custom cleanup without a standard revocation endpoint", async () => {
    mockGetAllProviders.mockReturnValue([
      {
        id: "custom-provider",
        name: "Custom Provider",
        authSetup: () => ({
          oauthConfig: {
            clientId: "test-id",
            clientSecret: "test-secret",
            authorizeUrl: "https://custom.example/authorize",
            tokenUrl: "https://custom.example/token",
            redirectUri: "https://dofek.example/callback",
            scopes: ["user"],
          },
          exchangeCode: mockExchangeCode,
          revokeExistingTokens: mockRevokeExistingTokens,
        }),
      },
    ]);
    mockOauthStateStore.get.mockResolvedValue({
      providerId: "custom-provider",
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
    mockRevokeExistingTokens.mockResolvedValue(undefined);

    const { req, res } = createMockReqRes({ code: "auth-code", state: "random-state" });
    await handleOAuth2Callback(req, res);

    expect(mockPersistProviderConnection).toHaveBeenCalledOnce();
    expect(mockRevokeExistingTokens).toHaveBeenCalledOnce();
    expect(mockRevokeToken).not.toHaveBeenCalled();
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining("success"));
  });

  it("rejects a destructive strategy without a pre-exchange revocation handler", async () => {
    mockGetAllProviders.mockReturnValue([
      {
        id: "misconfigured-provider",
        name: "Misconfigured Provider",
        authSetup: () => ({
          oauthConfig: {
            clientId: "test-id",
            clientSecret: "test-secret",
            authorizeUrl: "https://misconfigured.example/authorize",
            tokenUrl: "https://misconfigured.example/token",
            redirectUri: "https://dofek.example/callback",
            scopes: ["user"],
            revokeUrl: "https://misconfigured.example/revoke",
          },
          exchangeCode: mockExchangeCode,
          reconnectStrategy: "revoke-then-replace",
        }),
      },
    ]);
    mockOauthStateStore.get.mockResolvedValue({
      providerId: "misconfigured-provider",
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

    const { req, res } = createMockReqRes({ code: "auth-code", state: "random-state" });
    await handleOAuth2Callback(req, res);

    expect(mockExchangeCode).not.toHaveBeenCalled();
    expect(mockDeleteTokens).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("pre-exchange revocation but has no revocation handler"),
      expect.anything(),
    );
  });

  it("rejects a fenced user without emitting the user or database error to telemetry", async () => {
    const sensitiveUserId = "10000000-0000-4000-8000-000000001994";
    mockOauthStateStore.get.mockResolvedValue({
      providerId: "wahoo",
      codeVerifier: undefined,
      intent: "data",
      linkUserId: undefined,
      userId: sensitiveUserId,
      returnTo: undefined,
    });
    mockWithUserWriteFence.mockRejectedValueOnce(
      new MockAccountErasureUserFencedError(
        new Error(`Account erasure is active for user ${sensitiveUserId}`),
      ),
    );

    const { req, res } = createMockReqRes({ code: "auth-code", state: "random-state" });
    await handleOAuth2Callback(req, res);

    expect(mockExchangeCode).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.send).toHaveBeenCalledWith("Account deletion is active for this user.");
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(
      JSON.stringify([
        ...mockLogger.info.mock.calls,
        ...mockLogger.warn.mock.calls,
        ...mockLogger.error.mock.calls,
      ]),
    ).not.toContain(sensitiveUserId);
  });

  it("does not load data-connection tokens for an account-link callback", async () => {
    mockOauthStateStore.get.mockResolvedValue({
      providerId: "ride-with-gps",
      codeVerifier: undefined,
      intent: "link",
      linkUserId: "user-1",
      userId: undefined,
      returnTo: undefined,
    });
    const mockGetUserIdentity = vi.fn().mockResolvedValue({
      providerAccountId: "rwgps-account-1",
      email: "rwgps@example.com",
      name: "Ride with GPS User",
    });
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
          getUserIdentity: mockGetUserIdentity,
        }),
      },
    ]);

    const { req, res } = createMockReqRes({ code: "auth-code", state: "random-state" });
    await handleOAuth2Callback(req, res);

    expect(mockLoadTokens).not.toHaveBeenCalled();
    expect(mockRevokeToken).not.toHaveBeenCalled();
    expect(mockResolveOrCreateUser).toHaveBeenCalledWith(
      mockDb,
      "ride-with-gps",
      expect.objectContaining({ providerAccountId: "rwgps-account-1" }),
      "user-1",
    );
    expect(res.redirect).toHaveBeenCalledWith("/settings");
  });

  it("clears confirmed revoked credentials when a destructive exchange fails", async () => {
    const transactionEvents: string[] = [];
    mockWithUserWriteFence.mockImplementationOnce(
      async (
        _database: unknown,
        _userId: string,
        operation: (database: typeof mockDb) => Promise<unknown>,
      ) => {
        try {
          const result = await operation(mockDb);
          transactionEvents.push("commit");
          return result;
        } catch (error: unknown) {
          transactionEvents.push("rollback");
          throw error;
        }
      },
    );
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
    mockDeleteProviderAuthorization.mockImplementation(async () => {
      transactionEvents.push("delete");
    });
    mockExchangeCode.mockImplementation(async () => {
      transactionEvents.push("exchange-failed");
      throw new Error("token endpoint unavailable");
    });

    const { req, res } = createMockReqRes({ code: "auth-code", state: "random-state" });
    await handleOAuth2Callback(req, res);

    expect(mockRevokeExistingTokens).toHaveBeenCalledOnce();
    expect(mockDeleteProviderAuthorization).toHaveBeenCalledWith(mockDb, "wahoo", "user-1");
    expect(mockDeleteTokens).not.toHaveBeenCalled();
    expect(mockInvalidateByPrefix).toHaveBeenCalledWith("user-1:sync.providers");
    expect(transactionEvents).toEqual(["exchange-failed", "commit", "delete"]);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith(
      expect.stringContaining("previous Wahoo authorization was removed"),
    );
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining("connect Wahoo again"));
  });

  it("reports a stale revoked credential when local deletion fails", async () => {
    mockLoadTokens.mockResolvedValue({
      accessToken: "working-access",
      refreshToken: "working-refresh",
    });
    mockExchangeCode.mockRejectedValue(new Error("Too many unrevoked access tokens"));
    mockRevokeExistingTokens.mockResolvedValue(undefined);
    mockDeleteProviderAuthorization.mockRejectedValue(new Error("database unavailable"));

    const { req, res } = createMockReqRes({ code: "auth-code", state: "random-state" });
    await handleOAuth2Callback(req, res);

    expect(mockRevokeExistingTokens).toHaveBeenCalledOnce();
    expect(mockExchangeCode).toHaveBeenCalledOnce();
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining(
        "wahoo authorization was revoked but its stored credential could not be deleted",
      ),
      expect.objectContaining({
        err: expect.any(Error),
        providerId: "wahoo",
        userId: "user-1",
      }),
    );
    expect(captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("stale revoked credential remains stored"),
        cause: expect.objectContaining({ message: "database unavailable" }),
      }),
    );
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.send).toHaveBeenCalledWith(
      expect.stringContaining("previous Wahoo authorization was removed"),
    );
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
