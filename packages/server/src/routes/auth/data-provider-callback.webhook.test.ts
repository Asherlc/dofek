import * as Sentry from "@sentry/node";
import type { Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockExchangeCode,
  mockGetAllProviders,
  mockLoadTokens,
  mockPersistProviderConnection,
  mockRegisterProviderWebhook,
  mockWithUserWriteFence,
  mockRevokeToken,
  mockDeleteProviderAuthorization,
} = vi.hoisted(() => ({
  mockExchangeCode: vi.fn(),
  mockGetAllProviders: vi.fn(),
  mockLoadTokens: vi.fn(),
  mockPersistProviderConnection: vi.fn(),
  mockRegisterProviderWebhook: vi.fn(),
  mockWithUserWriteFence: vi.fn(),
  mockRevokeToken: vi.fn(),
  mockDeleteProviderAuthorization: vi.fn(),
}));

vi.mock("@sentry/node", () => ({ captureException: vi.fn() }));
vi.mock("dofek/auth/oauth", () => ({
  revokeToken: (...args: unknown[]) => mockRevokeToken(...args),
}));
vi.mock("dofek/db/account-erasure", () => ({
  AccountErasureIdentityFencedError: class extends Error {},
  AccountErasureUserFencedError: class extends Error {},
  withAccountErasureUserAndIdentityWriteFence: vi.fn(async (_db, _user, _ids, operation) =>
    operation({}),
  ),
  withAccountErasureUserWriteFence: (...args: unknown[]) => mockWithUserWriteFence(...args),
}));
vi.mock("dofek/lib/error-reporting", () => ({ captureException: vi.fn() }));
vi.mock("../../logger.ts", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("dofek/lib/cache", () => ({ queryCache: { invalidateByPrefix: vi.fn() } }));
vi.mock("../../auth/account-linking.ts", () => ({
  MissingEmailForSignupError: class extends Error {},
  findExistingUserId: vi.fn().mockResolvedValue("user-1"),
  resolveOrCreateUser: vi.fn().mockResolvedValue({ userId: "user-1", isNewUser: true }),
}));
vi.mock("../../auth/cookies.ts", () => ({
  getSessionIdFromRequest: vi.fn(),
  isValidMobileScheme: vi.fn(),
  setSessionCookie: vi.fn(),
}));
vi.mock("../../auth/session.ts", () => ({ createSession: vi.fn(), validateSession: vi.fn() }));
vi.mock("dofek/db/tokens", () => ({
  loadTokens: (...args: unknown[]) => mockLoadTokens(...args),
  deleteTokens: vi.fn(),
  deleteProviderAuthorization: (...args: unknown[]) => mockDeleteProviderAuthorization(...args),
  ensureProvider: vi.fn(),
  saveTokens: vi.fn(),
}));
vi.mock("dofek/providers/registry", () => ({ getAllProviders: () => mockGetAllProviders() }));
vi.mock("../../routers/sync-helpers.ts", () => ({ ensureProvidersRegistered: vi.fn() }));

const mockOauthStateStore = { get: vi.fn(), has: vi.fn(), delete: vi.fn() };
const mockDb = {};
vi.mock("./shared.ts", () => ({
  getDb: () => mockDb,
  getOAuthStateStoreRef: () => mockOauthStateStore,
  getOAuth1SecretStoreRef: () => ({ get: vi.fn(), delete: vi.fn() }),
  oauthSuccessHtml: vi.fn(() => "<html>success</html>"),
  persistProviderConnection: (...args: unknown[]) => mockPersistProviderConnection(...args),
  registerProviderWebhook: (...args: unknown[]) => mockRegisterProviderWebhook(...args),
  sanitizeReturnTo: vi.fn(),
  completeSignupHtml: vi.fn(),
  getPendingEmailSignupStoreRef: vi.fn(() => ({ issue: vi.fn() })),
}));

import { handleOAuth2Callback } from "./data-provider-callback.ts";

function mockOf<T extends object>(partial: Partial<T>): T {
  return Object.assign(Object.create(null), partial);
}
function createMockReqRes(query: Record<string, string> = {}) {
  const req = mockOf<Request>({ query, get: vi.fn(() => "dofek.asherlc.com") });
  const res = mockOf<Response>({
    status: vi.fn().mockReturnThis(),
    send: vi.fn(),
    type: vi.fn().mockReturnThis(),
    redirect: vi.fn(),
  });
  return { req, res };
}

describe("handleOAuth2Callback — webhook registration", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockWithUserWriteFence.mockImplementation(async (_db, _user, operation) => operation(mockDb));
    mockOauthStateStore.get.mockResolvedValue({
      providerId: "strava",
      codeVerifier: undefined,
      intent: "data",
      linkUserId: undefined,
      userId: "user-1",
      returnTo: undefined,
    });
    mockOauthStateStore.has.mockResolvedValue(true);
    mockGetAllProviders.mockReturnValue([
      {
        id: "strava",
        name: "Strava",
        authSetup: () => ({
          oauthConfig: {
            clientId: "id",
            clientSecret: "secret",
            authorizeUrl: "https://strava.example/authorize",
            tokenUrl: "https://strava.example/token",
            redirectUri: "https://dofek.example/callback",
            scopes: ["read"],
          },
          exchangeCode: mockExchangeCode,
        }),
      },
    ]);
    mockExchangeCode.mockResolvedValue({
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: new Date("2027-01-01"),
      scopes: "read",
    });
    mockLoadTokens.mockResolvedValue(null);
  });
  afterEach(() => vi.restoreAllMocks());

  it("registers a webhook after its connection transaction commits", async () => {
    const events: string[] = [];
    mockWithUserWriteFence.mockImplementationOnce(async (_db, _user, operation) => {
      const result = await operation(mockDb);
      events.push("commit");
      return result;
    });
    mockPersistProviderConnection.mockImplementationOnce(async () => events.push("persist"));
    mockRegisterProviderWebhook.mockImplementationOnce(async () => events.push("register"));
    const { req, res } = createMockReqRes({ code: "auth-code", state: "strava-state" });
    await handleOAuth2Callback(req, res);
    expect(events).toEqual(["persist", "commit", "register"]);
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining("success"));
  });

  it("removes the committed connection before revoking after webhook failure", async () => {
    const events: string[] = [];
    mockWithUserWriteFence
      .mockImplementationOnce(async (_db, _user, operation) => {
        const result = await operation(mockDb);
        events.push("commit");
        return result;
      })
      .mockImplementationOnce(async (_db, _user, operation) => operation(mockDb));
    mockGetAllProviders.mockReturnValueOnce([
      {
        id: "strava",
        name: "Strava",
        authSetup: () => ({
          oauthConfig: {},
          exchangeCode: mockExchangeCode,
          revokeExistingTokens: async () => events.push("revoke"),
        }),
      },
    ]);
    mockPersistProviderConnection.mockImplementationOnce(async () => events.push("persist"));
    mockRegisterProviderWebhook.mockImplementationOnce(async () => {
      events.push("register");
      throw new Error("webhook validation failed");
    });
    mockDeleteProviderAuthorization.mockImplementationOnce(async () => events.push("delete"));
    const { req, res } = createMockReqRes({ code: "auth-code", state: "strava-state" });
    await handleOAuth2Callback(req, res);
    expect(events).toEqual(["persist", "commit", "register", "delete", "revoke"]);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it("preserves the connection when webhook cleanup fails", async () => {
    mockWithUserWriteFence
      .mockImplementationOnce(async (_db, _user, operation) => operation(mockDb))
      .mockRejectedValueOnce(new Error("cleanup unavailable"));
    mockRegisterProviderWebhook.mockRejectedValueOnce(new Error("webhook validation failed"));
    const { req, res } = createMockReqRes({ code: "auth-code", state: "strava-state" });
    await handleOAuth2Callback(req, res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.send).toHaveBeenCalledWith(
      expect.stringContaining("webhook registration and connection cleanup both failed"),
    );
    expect(mockRevokeToken).not.toHaveBeenCalled();
    expect(Sentry.captureException).toHaveBeenCalled();
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
  });

  it("exchanges and persists a successful reconnect without revocation", async () => {
    const events: string[] = [];
    mockLoadTokens.mockImplementation(async () => {
      events.push("load");
      return { accessToken: "valid-access", refreshToken: "valid-refresh" };
    });
    mockExchangeCode.mockImplementation(async () => {
      events.push("exchange-new-grant");
      return {
        accessToken: "new-access",
        refreshToken: "new-refresh",
        expiresAt: new Date("2027-01-01"),
        scopes: "read",
      };
    });
    mockPersistProviderConnection.mockImplementation(async () => events.push("persist-new-tokens"));
    const { req, res } = createMockReqRes({ code: "auth-code", state: "random-state" });
    await handleOAuth2Callback(req, res);
    expect(events).toEqual(["exchange-new-grant", "persist-new-tokens"]);
    expect(mockRevokeToken).not.toHaveBeenCalled();
    expect(res.send).toHaveBeenCalledWith(expect.stringContaining("success"));
  });

  it("rejects a callback when the account write fence is active", async () => {
    mockWithUserWriteFence.mockRejectedValueOnce(new Error("Account erasure is active"));
    const { req, res } = createMockReqRes({ code: "code-1", state: "state-1" });
    await handleOAuth2Callback(req, res);
    expect(mockWithUserWriteFence).toHaveBeenCalledWith(mockDb, "user-1", expect.any(Function));
    expect(mockExchangeCode).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
