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
  mockRegisterProviderWebhook,
  mockIssuePendingEmailSignup,
  mockFindExistingUserId,
  mockIdentityWriteFence,
  mockLockIdentityFence,
  mockWithUserWriteFence,
  mockWithProviderOperationFence,
  mockSaveTokens,
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
  mockRegisterProviderWebhook: vi.fn(),
  mockIssuePendingEmailSignup: vi.fn(),
  mockFindExistingUserId: vi.fn(),
  mockIdentityWriteFence: vi.fn(),
  mockLockIdentityFence: vi.fn(),
  mockWithUserWriteFence: vi.fn(),
  mockWithProviderOperationFence: vi.fn(),
  mockSaveTokens: vi.fn(),
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

vi.mock("dofek/db/provider-operation-fence", () => ({
  withProviderOperationFence: mockWithProviderOperationFence,
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
  saveTokens: mockSaveTokens,
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

const mockDb = { transaction: vi.fn() };
vi.mock("./shared.ts", () => ({
  getDb: () => mockDb,
  getOAuthStateStoreRef: () => mockOauthStateStore,
  getOAuth1SecretStoreRef: () => ({ get: vi.fn(), delete: vi.fn() }),
  oauthSuccessHtml: vi.fn(() => "<html>success</html>"),
  persistProviderConnection: (...args: unknown[]) => mockPersistProviderConnection(...args),
  registerProviderWebhook: (...args: unknown[]) => mockRegisterProviderWebhook(...args),
  sanitizeReturnTo: vi.fn(),
  completeSignupHtml: vi.fn(
    (providerName: string, token: string) => `<html>${providerName}:${token}</html>`,
  ),
  getPendingEmailSignupStoreRef: vi.fn(() => ({
    issue: mockIssuePendingEmailSignup,
  })),
}));

import { captureException } from "dofek/lib/error-reporting";
import { ProviderConnectionError } from "dofek/providers/auth-errors";
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
    vi.resetAllMocks();
    mockDb.transaction.mockImplementation(
      async (operation: (database: typeof mockDb) => Promise<unknown>) => operation(mockDb),
    );
    mockWithProviderOperationFence.mockImplementation(
      async (
        _database: unknown,
        _userId: string,
        _providerId: string,
        operation: (database: typeof mockDb) => Promise<unknown>,
      ) => operation(mockDb),
    );
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

  function useRegistrationReplacement() {
    mockGetAllProviders.mockReturnValue([
      {
        id: "wahoo",
        name: "Garmin",
        pushOnly: true,
        authSetup: () => ({
          oauthConfig: { clientId: "client", tokenUrl: "https://provider.test/token" },
          exchangeCode: mockExchangeCode,
          reconnectStrategy: "replace",
          assertCanConnect: vi.fn(),
          revokeExistingTokens: mockRevokeExistingTokens,
        }),
      },
    ]);
  }

  it.each(["data", "login"])(
    "reports permission confirmation failures safely for %s callbacks",
    async (intent) => {
      useRegistrationReplacement();
      mockOauthStateStore.get.mockResolvedValue({
        providerId: "wahoo",
        intent,
        userId: "user-1",
      });
      mockLoadTokens.mockResolvedValue(null);
      const error = new ProviderConnectionError("Garmin Connect", "permissions", 403);
      mockExchangeCode.mockRejectedValue(error);

      const { req, res } = createMockReqRes({ code: "private-code", state: "private-state" });
      await handleOAuth2Callback(req, res);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.type).toHaveBeenCalledWith("text/plain");
      expect(res.send).toHaveBeenCalledWith(
        "Garmin Connect connection failed while confirming your permissions (HTTP 403). Please contact support if this continues.",
      );
      expect(captureException).toHaveBeenCalledWith(error);
      expect(mockPersistProviderConnection).not.toHaveBeenCalled();
      expect(mockRevokeExistingTokens).not.toHaveBeenCalled();
      expect(res.redirect).not.toHaveBeenCalled();
    },
  );

  it("reports identity confirmation failures and preserves an existing registration", async () => {
    useRegistrationReplacement();
    mockLoadTokens.mockResolvedValue({ accessToken: "old-access", providerAccountId: "account-1" });
    mockExchangeCode.mockRejectedValue(
      new ProviderConnectionError("Garmin Connect", "identity", 502),
    );

    const { req, res } = createMockReqRes({ code: "code", state: "state" });
    await handleOAuth2Callback(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.type).toHaveBeenCalledWith("text/plain");
    expect(res.send).toHaveBeenCalledWith(
      "Garmin Connect connection failed while confirming your identity (HTTP 502). Please contact support if this continues. Your existing connection is still active.",
    );
    expect(mockPersistProviderConnection).not.toHaveBeenCalled();
    expect(mockRevokeExistingTokens).not.toHaveBeenCalled();
    expect(mockDeleteProviderAuthorization).not.toHaveBeenCalled();
  });

  it.each([
    {
      kind: "first connection",
      existing: null,
      status: 500,
      message: "Connection failed — please try again from Garmin",
    },
    {
      kind: "reconnect",
      existing: { accessToken: "old-access", providerAccountId: "account-1" },
      status: 400,
      message:
        "Garmin reconnect failed. Your existing connection is still active. Please try again later.",
    },
  ])(
    "keeps arbitrary upstream error details out of a failed $kind response",
    async ({ existing, status, message }) => {
      useRegistrationReplacement();
      mockLoadTokens.mockResolvedValue(existing);
      mockExchangeCode.mockRejectedValue(
        new Error("Upstream failure: access_token=secret-token <script>private</script>"),
      );

      const { req, res } = createMockReqRes({ code: "code", state: "state" });
      await handleOAuth2Callback(req, res);

      expect(res.status).toHaveBeenCalledWith(status);
      expect(res.type).toHaveBeenCalledWith("text/plain");
      expect(res.send).toHaveBeenCalledWith(message);
      expect(mockRevokeExistingTokens).not.toHaveBeenCalled();
    },
  );

  it("replaces credentials for the same registration without revoking either grant", async () => {
    useRegistrationReplacement();
    mockLoadTokens.mockResolvedValue({ accessToken: "old-access", providerAccountId: "account-1" });
    mockExchangeCode.mockResolvedValue({
      accessToken: "new-access",
      expiresAt: new Date("2027-01-01"),
      providerAccountId: "account-1",
    });

    const { req, res } = createMockReqRes({ code: "code", state: "state" });
    await handleOAuth2Callback(req, res);

    expect(mockPersistProviderConnection).toHaveBeenCalledWith(
      expect.objectContaining({ tokens: expect.objectContaining({ accessToken: "new-access" }) }),
    );
    expect(mockRevokeExistingTokens).not.toHaveBeenCalled();
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining("success"));
  });

  it.each(["persistence", "identity"])(
    "preserves the registration when replacement %s fails",
    async (failure) => {
      useRegistrationReplacement();
      mockLoadTokens.mockResolvedValue({
        accessToken: "old-access",
        providerAccountId: "account-1",
      });
      if (failure === "persistence") {
        mockExchangeCode.mockResolvedValue({
          accessToken: "new-access",
          expiresAt: new Date("2027-01-01"),
          providerAccountId: "account-1",
        });
        mockPersistProviderConnection.mockRejectedValue(new Error("database write failed"));
      } else {
        mockExchangeCode.mockImplementation(
          async (_code, _verifier, onTokensIssued: (tokens: unknown) => void) => {
            onTokensIssued({ accessToken: "new-access", authorizationId: "issued-grant" });
            throw new Error("identity request failed");
          },
        );
      }

      const { req, res } = createMockReqRes({ code: "code", state: "state" });
      await handleOAuth2Callback(req, res);

      expect(mockRevokeExistingTokens).not.toHaveBeenCalled();
      expect(mockDeleteProviderAuthorization).not.toHaveBeenCalled();
      expect(res.send).toHaveBeenCalledWith(expect.stringContaining("existing connection"));
    },
  );

  it("requires disconnecting before replacing a registration with a different provider account", async () => {
    useRegistrationReplacement();
    mockLoadTokens.mockResolvedValue({ accessToken: "old-access", providerAccountId: "account-1" });
    mockExchangeCode.mockResolvedValue({
      accessToken: "new-access",
      expiresAt: new Date("2027-01-01"),
      providerAccountId: "account-2",
    });

    const { req, res } = createMockReqRes({ code: "code", state: "state" });
    await handleOAuth2Callback(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining("Disconnect Garmin first"));
    expect(mockPersistProviderConnection).not.toHaveBeenCalled();
    expect(mockRevokeExistingTokens).not.toHaveBeenCalled();
  });

  it("preserves a first-connect registration when local persistence fails", async () => {
    useRegistrationReplacement();
    mockLoadTokens.mockResolvedValue(null);
    mockExchangeCode.mockResolvedValue({
      accessToken: "new-access",
      expiresAt: new Date("2027-01-01"),
      providerAccountId: "verified-new-account",
    });
    mockPersistProviderConnection.mockRejectedValue(new Error("database write failed"));

    const { req, res } = createMockReqRes({ code: "code", state: "state" });
    await handleOAuth2Callback(req, res);

    expect(mockRevokeExistingTokens).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it("fences push callbacks before remote revocation and commits rotated credentials outside the operation", async () => {
    const transactionDb = { operation: true };
    const existingTokens = { accessToken: "expired-access", refreshToken: "old-refresh" };
    const refreshedTokens = { accessToken: "refreshed-access", refreshToken: "rotated-refresh" };
    const events: string[] = [];
    const operationDb = {
      transaction: vi.fn(
        async (operation: (transaction: typeof transactionDb) => Promise<unknown>) =>
          operation(transactionDb).then(
            (value) => {
              events.push("commit-operation");
              return value;
            },
            (error: unknown) => {
              events.push("rollback-operation");
              throw error;
            },
          ),
      ),
    };
    mockWithProviderOperationFence.mockImplementationOnce(
      async (
        _database: unknown,
        _userId: string,
        _providerId: string,
        operation: (database: typeof operationDb) => Promise<unknown>,
      ) => {
        events.push("provider-fence");
        return operation(operationDb).finally(() => events.push("release-provider-fence"));
      },
    );
    mockGetAllProviders.mockReturnValue([
      {
        id: "wahoo",
        name: "Push provider",
        pushOnly: true,
        authSetup: () => ({
          oauthConfig: { clientId: "client", tokenUrl: "https://provider.test/token" },
          exchangeCode: mockExchangeCode,
          reconnectStrategy: "revoke-then-replace",
          revokeExistingTokens: async (
            _tokens: unknown,
            persist: (tokens: typeof refreshedTokens) => Promise<void>,
          ) => {
            events.push("refresh");
            await persist(refreshedTokens);
            events.push("delete-registration");
            throw new Error("Remote registration deletion failed");
          },
        }),
      },
    ]);
    mockLoadTokens.mockResolvedValue(existingTokens);
    mockSaveTokens.mockImplementation(async () => events.push("commit-refresh"));

    const { req, res } = createMockReqRes({ code: "auth-code", state: "state" });
    await handleOAuth2Callback(req, res);

    expect(events).toEqual([
      "provider-fence",
      "refresh",
      "commit-refresh",
      "delete-registration",
      "rollback-operation",
      "release-provider-fence",
    ]);
    expect(mockWithProviderOperationFence).toHaveBeenCalledWith(
      mockDb,
      "user-1",
      "wahoo",
      expect.any(Function),
    );
    expect(mockWithUserWriteFence).not.toHaveBeenCalled();
    expect(mockLoadTokens).toHaveBeenCalledWith(transactionDb, "wahoo", "user-1");
    expect(mockSaveTokens).toHaveBeenCalledWith(mockDb, "wahoo", refreshedTokens, "user-1");
    expect(mockDeleteProviderAuthorization).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it.each(["exchange", "persistence"])(
    "holds the push provider fence through cleanup after a failed %s",
    async (failure) => {
      const events: string[] = [];
      const operationDb = {
        transaction: vi.fn(async (operation: (transaction: typeof mockDb) => Promise<unknown>) =>
          operation(mockDb).then(
            (value) => {
              events.push("commit-operation");
              return value;
            },
            (error: unknown) => {
              events.push("rollback-operation");
              throw error;
            },
          ),
        ),
      };
      mockWithProviderOperationFence.mockImplementationOnce(
        async (
          _database: unknown,
          _userId: string,
          _providerId: string,
          operation: (database: typeof operationDb) => Promise<unknown>,
        ) => operation(operationDb).finally(() => events.push("release-provider-fence")),
      );
      mockGetAllProviders.mockReturnValue([
        {
          id: "wahoo",
          name: "Push provider",
          pushOnly: true,
          authSetup: () => ({
            oauthConfig: { clientId: "client", tokenUrl: "https://provider.test/token" },
            exchangeCode: mockExchangeCode,
            reconnectStrategy: "revoke-then-replace",
            revokeExistingTokens: mockRevokeExistingTokens,
          }),
        },
      ]);
      if (failure === "exchange") {
        mockLoadTokens.mockResolvedValue({
          accessToken: "old-access",
          refreshToken: "old-refresh",
        });
        mockExchangeCode.mockRejectedValue(new Error("exchange failed"));
        mockRevokeExistingTokens.mockImplementation(async () => events.push("revoke-old"));
        mockDeleteProviderAuthorization.mockImplementation(async () => events.push("delete-old"));
      } else {
        mockLoadTokens.mockResolvedValue(null);
        mockPersistProviderConnection.mockRejectedValue(new Error("persistence failed"));
        mockRevokeExistingTokens.mockImplementation(async () => events.push("revoke-orphan"));
      }

      const { req } = createMockReqRes({ code: "auth-code", state: "state" });
      const { res } = createMockReqRes();
      await handleOAuth2Callback(req, res);

      expect(events).toEqual(
        failure === "exchange"
          ? ["revoke-old", "commit-operation", "delete-old", "release-provider-fence"]
          : ["rollback-operation", "revoke-orphan", "release-provider-fence"],
      );
    },
  );

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
    expect(mockRevokeExistingTokens).toHaveBeenCalledWith(
      { accessToken: "expired-access", refreshToken: "expired-refresh" },
      expect.any(Function),
    );
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

  it("revokes newly issued credentials when durable persistence fails", async () => {
    mockLoadTokens.mockResolvedValue(null);
    mockPersistProviderConnection.mockRejectedValueOnce(new Error("commit failed"));
    const { req, res } = createMockReqRes({
      code: "code-1",
      state: "state-1",
    });

    await handleOAuth2Callback(req, res);

    expect(mockRevokeExistingTokens).toHaveBeenCalledWith(
      {
        accessToken: "new-access",
        refreshToken: "new-refresh",
        expiresAt: new Date("2027-01-01"),
        scopes: "user_read",
      },
      undefined,
    );
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

  it("reports custom cleanup failure while keeping the successfully persisted replacement", async () => {
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
    expect(mockRevokeToken).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Custom revocation failed"),
    );
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining("superseded authorization cleanup failed"),
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
    expect(mockRegisterProviderWebhook).not.toHaveBeenCalled();
  });
});
