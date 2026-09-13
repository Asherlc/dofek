import * as Sentry from "@sentry/node";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  pending: {
    providerId: "strava",
    providerName: "Strava",
    identity: { providerAccountId: "account-1", email: null, name: "Runner" },
    tokens: {
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAt: new Date("2027-01-01"),
      scopes: "read",
    },
  },
  complete: vi.fn(),
  deleteAuthorization: vi.fn(),
  registerWebhook: vi.fn(),
  revoke: vi.fn(),
}));

vi.mock("dofek/db/account-erasure", () => ({
  AccountErasureIdentityFencedError: class extends Error {},
  AccountErasureUserFencedError: class extends Error {},
  withAccountErasureUserAndIdentityWriteFence: vi.fn(async (_db, _user, _ids, operation) =>
    operation({}),
  ),
  withAccountErasureUserWriteFence: vi.fn(async (_db, _user, operation) => operation({})),
}));
vi.mock("dofek/lib/error-reporting", () => ({ captureException: vi.fn() }));
vi.mock("@sentry/node", () => ({ captureException: vi.fn() }));
vi.mock("../../auth/account-linking.ts", () => ({
  findExistingUserId: vi.fn().mockResolvedValue("user-1"),
  resolveOrCreateUser: vi.fn().mockResolvedValue({ userId: "user-1", isNewUser: true }),
}));
vi.mock("../../auth/cookies.ts", () => ({
  isValidMobileScheme: vi.fn().mockReturnValue(false),
  setSessionCookie: vi.fn(),
}));
vi.mock("../../auth/session.ts", () => ({
  createSession: vi.fn().mockResolvedValue({ sessionId: "session-1", expiresAt: new Date() }),
}));
vi.mock("../../auth/provider-credential-revocation.ts", () => ({
  revokeProviderCredentials: (...args: unknown[]) => state.revoke(...args),
}));
vi.mock("dofek/db/tokens", () => ({
  deleteProviderAuthorization: (...args: unknown[]) => state.deleteAuthorization(...args),
}));
vi.mock("dofek/providers/registry", () => ({
  getAllProviders: vi.fn(() => [
    {
      id: "strava",
      name: "Strava",
      authSetup: () => ({
        oauthConfig: { revokeUrl: "https://strava.example/deauthorize" },
        revokeExistingTokens: vi.fn(),
      }),
    },
  ]),
}));
vi.mock("./shared.ts", () => ({
  getDb: vi.fn(() => ({})),
  getPendingEmailSignupStoreRef: vi.fn(() => ({
    get: vi.fn(async () => state.pending),
    claim: vi.fn(async (token: string) =>
      state.pending ? { token, claimId: "claim-1", entry: state.pending } : null,
    ),
    complete: (...args: unknown[]) => state.complete(...args),
    release: vi.fn(),
    renew: vi.fn(),
  })),
  registerProviderWebhook: (...args: unknown[]) => state.registerWebhook(...args),
  completeSignupHtml: vi.fn(),
  getMobileAuthExchangeStoreRef: vi.fn(),
  getPostLoginRedirect: vi.fn(() => "/"),
  persistProviderConnection: vi.fn(),
}));

import { handleCompleteSignup } from "./complete-signup.ts";

function mockOf<T extends object>(partial: Partial<T>): T {
  const result: T = partial;
  return result;
}

function request() {
  return mockOf<Request>({
    body: { token: "signup-token", email: "runner@example.com" },
    get: vi.fn(),
  });
}

function response() {
  const result = mockOf<Response>({
    status: vi.fn(),
    type: vi.fn(),
    send: vi.fn(),
    redirect: vi.fn(),
  });
  result.status.mockReturnValue(result);
  result.type.mockReturnValue(result);
  return result;
}

describe("handleCompleteSignup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.deleteAuthorization.mockResolvedValue(undefined);
    state.registerWebhook.mockRejectedValue(new Error("validation failed"));
    state.revoke.mockResolvedValue(undefined);
    state.complete.mockResolvedValue(undefined);
  });

  it("revokes credentials before consuming a claim after webhook failure", async () => {
    const events: string[] = [];
    state.deleteAuthorization.mockImplementation(async () => events.push("delete"));
    state.revoke.mockImplementation(async () => events.push("revoke"));
    state.complete.mockImplementation(async () => events.push("complete"));
    const res = response();

    await handleCompleteSignup(request(), res);

    expect(events).toEqual(["delete", "revoke", "complete"]);
    expect(res.send).toHaveBeenCalledWith(
      expect.stringContaining("Restart the provider connection"),
    );
  });

  it("reports cleanup failure without revoking credentials", async () => {
    const cleanupError = new Error("cleanup unavailable");
    state.deleteAuthorization.mockRejectedValueOnce(cleanupError);
    const res = response();

    await handleCompleteSignup(request(), res);

    expect(state.revoke).not.toHaveBeenCalled();
    expect(res.send).toHaveBeenCalledWith("Signup failed — please try again");
    expect(Sentry.captureException).toHaveBeenCalledWith(cleanupError, expect.anything());
  });

  it("retains the claim when credential revocation fails", async () => {
    state.revoke.mockRejectedValueOnce(new Error("revocation unavailable"));
    const res = response();

    await handleCompleteSignup(request(), res);

    expect(state.complete).not.toHaveBeenCalled();
    expect(res.send).toHaveBeenCalledWith("Signup failed — please try again");
  });

  it("uses the normal signup response when webhook registration succeeds", async () => {
    state.registerWebhook.mockResolvedValueOnce(undefined);
    const res = response();

    await handleCompleteSignup(request(), res);

    expect(state.revoke).not.toHaveBeenCalled();
    expect(state.complete).toHaveBeenCalledOnce();
    expect(res.redirect).toHaveBeenCalledWith("/");
  });
});
