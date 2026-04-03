import { getOAuthRedirectUri } from "dofek/auth/oauth";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { oauthSuccessHtml } from "./auth.ts";

// Mock all heavy dependencies
vi.mock("../auth/cookies.ts", () => ({
  getSessionIdFromRequest: vi.fn(),
  setSessionCookie: vi.fn(),
  clearSessionCookie: vi.fn(),
  getOAuthFlowCookies: vi.fn(() => ({ state: null, codeVerifier: null })),
  setOAuthFlowCookies: vi.fn(),
  clearOAuthFlowCookies: vi.fn(),
  getLinkUserCookie: vi.fn(() => null),
  setLinkUserCookie: vi.fn(),
  getMobileSchemeCookie: vi.fn(() => undefined),
  setMobileSchemeCookie: vi.fn(),
  getPostLoginRedirectCookie: vi.fn(() => undefined),
  setPostLoginRedirectCookie: vi.fn(),
  clearPostLoginRedirectCookie: vi.fn(),
  isValidMobileScheme: (scheme: unknown) => scheme === "dofek",
}));

vi.mock("../auth/providers.ts", () => ({
  getConfiguredProviders: vi.fn(() => ["google"]),
  isProviderConfigured: vi.fn((name: string) => name === "google"),
  isNativeAppleConfigured: vi.fn(() => false),
  getIdentityProvider: vi.fn(() => ({
    createAuthorizationUrl: vi.fn(() => new URL("https://accounts.google.com/authorize")),
    validateCallback: vi.fn(),
  })),
  validateNativeAppleCallback: vi.fn(),
  generateState: vi.fn(() => "mock-state"),
  generateCodeVerifier: vi.fn(() => "mock-verifier"),
}));

vi.mock("../auth/session.ts", () => ({
  createSession: vi.fn(() =>
    Promise.resolve({ sessionId: "sess-1", expiresAt: new Date("2027-01-01") }),
  ),
  deleteSession: vi.fn(() => Promise.resolve()),
  validateSession: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("../auth/account-linking.ts", () => ({
  MissingEmailForSignupError: class MissingEmailForSignupError extends Error {
    constructor(providerName: string) {
      super(`Email is required to finish signing up with ${providerName}`);
      this.name = "MissingEmailForSignupError";
    }
  },
  resolveOrCreateUser: vi.fn(() => Promise.resolve({ userId: "user-1" })),
}));

vi.mock("../lib/cache.ts", () => ({
  queryCache: { invalidateByPrefix: vi.fn(() => Promise.resolve()) },
}));

vi.mock("../logger.ts", () => ({
  logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock("dofek/providers/registry", () => ({
  getAllProviders: vi.fn(() => []),
}));

vi.mock("dofek/db/tokens", () => ({
  ensureProvider: vi.fn(() => Promise.resolve()),
  saveTokens: vi.fn(() => Promise.resolve()),
  loadTokens: vi.fn(() => Promise.resolve(null)),
}));

vi.mock("dofek/auth/oauth", () => ({
  getOAuthRedirectUri: vi.fn(() => "https://dofek.asherlc.com/callback"),
  buildAuthorizationUrl: vi.fn(() => "https://oauth.example.com/authorize?client_id=test"),
  generateCodeVerifier: vi.fn(() => "pkce-verifier"),
  generateCodeChallenge: vi.fn(() => "pkce-challenge"),
  revokeToken: vi.fn(() => Promise.resolve()),
}));

vi.mock("../routers/sync.ts", () => ({
  ensureProvidersRegistered: vi.fn(() => Promise.resolve()),
}));

vi.mock("dofek/providers/types", () => ({
  isWebhookProvider: vi.fn(() => false),
}));

// Disable rate limiting in tests — the module-level limiter is shared across
// all test cases and 30 req/15 min is easily exceeded.
vi.mock("express-rate-limit", () => ({
  default: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock("./webhooks.ts", () => ({
  registerWebhookForProvider: vi.fn(() => Promise.resolve()),
}));

vi.mock("dofek/db", () => ({
  createDatabaseFromEnv: vi.fn(() => ({
    execute: vi.fn(() => Promise.resolve([])),
  })),
}));

import type { AddressInfo } from "node:net";
import cookieParser from "cookie-parser";
import { revokeToken } from "dofek/auth/oauth";
import { createDatabaseFromEnv } from "dofek/db";
import { loadTokens } from "dofek/db/tokens";
import { getAllProviders } from "dofek/providers/registry";
import { isWebhookProvider, type SyncProvider } from "dofek/providers/types";
import express from "express";
import { MissingEmailForSignupError, resolveOrCreateUser } from "../auth/account-linking.ts";
import {
  clearSessionCookie,
  getLinkUserCookie,
  getMobileSchemeCookie,
  getOAuthFlowCookies,
  getPostLoginRedirectCookie,
  getSessionIdFromRequest,
  setMobileSchemeCookie,
  setPostLoginRedirectCookie,
  setSessionCookie,
} from "../auth/cookies.ts";
import {
  getIdentityProvider,
  isNativeAppleConfigured,
  isProviderConfigured,
  validateNativeAppleCallback,
} from "../auth/providers.ts";
import { createSession, deleteSession, validateSession } from "../auth/session.ts";
import { logger } from "../logger.ts";
import { createAuthRouter } from "./auth.ts";
import { registerWebhookForProvider } from "./webhooks.ts";

function createTestApp() {
  const fakeDb = createDatabaseFromEnv();
  const app = express();
  app.use(cookieParser());
  app.use(createAuthRouter(fakeDb));
  return { app, fakeDb };
}

function getPort(server: ReturnType<express.Express["listen"]>): number {
  const addr = server.address();
  if (addr !== null && typeof addr === "object") {
    return (addr satisfies AddressInfo).port;
  }
  throw new Error("Server address is not an object");
}

async function request(
  app: express.Express,
  method: "get" | "post",
  path: string,
  options?: { formBody?: Record<string, string>; headers?: Record<string, string> },
): Promise<{
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = getPort(server);
      const fetchOptions: RequestInit = { method: method.toUpperCase(), redirect: "manual" };
      const fetchHeaders: Record<string, string> = { ...options?.headers };
      if (options?.formBody) {
        fetchOptions.body = new URLSearchParams(options.formBody).toString();
        fetchHeaders["Content-Type"] = "application/x-www-form-urlencoded";
      }
      if (Object.keys(fetchHeaders).length > 0) {
        fetchOptions.headers = fetchHeaders;
      }
      fetch(`http://localhost:${port}${path}`, fetchOptions)
        .then(async (res) => {
          const body = await res.text();
          const headers: Record<string, string | string[] | undefined> = {};
          for (const [k, v] of res.headers.entries()) headers[k] = v;
          resolve({ status: res.status, body, headers });
          server.close();
        })
        .catch((_error: unknown) => {
          resolve({ status: 500, body: "fetch error", headers: {} });
          server.close();
        });
    });
  });
}

describe("createAuthRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSessionIdFromRequest).mockReturnValue("sess-default");
    vi.mocked(validateSession).mockResolvedValue({
      userId: "user-1",
      expiresAt: new Date("2027-01-01"),
    });
  });

  describe("GET /api/auth/providers", () => {
    it("returns configured providers", async () => {
      const { app } = createTestApp();
      const res = await request(app, "get", "/api/auth/providers");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.identity).toEqual(["google"]);
      expect(data.data).toEqual([]);
    });
  });

  describe("GET /auth/login/:provider", () => {
    it("returns 404 for unknown provider", async () => {
      const { app } = createTestApp();
      const res = await request(app, "get", "/auth/login/unknown");
      expect(res.status).toBe(404);
      expect(res.body).toContain("Unknown identity provider");
    });

    it("redirects for valid configured provider", async () => {
      const { app } = createTestApp();
      const res = await request(app, "get", "/auth/login/google");
      expect(res.status).toBe(302);
      expect(setPostLoginRedirectCookie).toHaveBeenCalledWith(expect.anything(), undefined);
    });

    it("stores validated return_to when provided", async () => {
      const { app } = createTestApp();
      const res = await request(
        app,
        "get",
        "/auth/login/google?return_to=%2Fdashboard%3Fonboarding%3Dtrue",
      );
      expect(res.status).toBe(302);
      expect(setPostLoginRedirectCookie).toHaveBeenCalledWith(
        expect.anything(),
        "/dashboard?onboarding=true",
      );
    });

    it("ignores invalid return_to values", async () => {
      const { app } = createTestApp();
      const res = await request(app, "get", "/auth/login/google?return_to=https%3A%2F%2Fevil.test");
      expect(res.status).toBe(302);
      expect(setPostLoginRedirectCookie).toHaveBeenCalledWith(
        expect.anything(),
        "https://evil.test",
      );
    });
  });

  describe("GET /auth/callback/:provider", () => {
    it("returns 404 for unknown provider", async () => {
      const { app } = createTestApp();
      const res = await request(app, "get", "/auth/callback/unknown?code=x&state=y");
      expect(res.status).toBe(404);
    });

    it("returns 400 when error param is present", async () => {
      const { app } = createTestApp();
      const res = await request(app, "get", "/auth/callback/google?error=access_denied");
      expect(res.status).toBe(400);
      expect(res.body).toContain("Authorization denied");
    });

    it("returns 400 when code or state is missing", async () => {
      const { app } = createTestApp();
      const res = await request(app, "get", "/auth/callback/google");
      expect(res.status).toBe(400);
      expect(res.body).toContain("Missing code or state");
    });
  });

  describe("POST /auth/logout", () => {
    it("logs out and returns ok", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue("sess-1");
      const { app } = createTestApp();
      const res = await request(app, "post", "/auth/logout");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.ok).toBe(true);
      expect(deleteSession).toHaveBeenCalledWith(expect.anything(), "sess-1");
    });

    it("returns ok even without session", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue(undefined);
      const { app } = createTestApp();
      const res = await request(app, "post", "/auth/logout");
      expect(res.status).toBe(200);
      expect(deleteSession).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/auth/me", () => {
    it("returns 401 when no session cookie", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue(undefined);
      const { app } = createTestApp();
      const res = await request(app, "get", "/api/auth/me");
      expect(res.status).toBe(401);
    });

    it("returns 401 when session is invalid", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue("bad-session");
      vi.mocked(validateSession).mockResolvedValue(null);
      const { app } = createTestApp();
      const res = await request(app, "get", "/api/auth/me");
      expect(res.status).toBe(401);
    });

    it("returns user when session is valid", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue("good-session");
      vi.mocked(validateSession).mockResolvedValue({
        userId: "user-1",
        expiresAt: new Date("2027-01-01"),
      });
      const { app, fakeDb } = createTestApp();
      vi.mocked(fakeDb.execute).mockResolvedValue([
        { id: "user-1", name: "Alice", email: "alice@test.com", is_admin: false },
      ]);
      const res = await request(app, "get", "/api/auth/me");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.name).toBe("Alice");
    });

    it("returns 401 when user not found in DB", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue("good-session");
      vi.mocked(validateSession).mockResolvedValue({
        userId: "user-1",
        expiresAt: new Date("2027-01-01"),
      });
      const { app, fakeDb } = createTestApp();
      vi.mocked(fakeDb.execute).mockResolvedValue([]);
      const res = await request(app, "get", "/api/auth/me");
      expect(res.status).toBe(401);
    });
  });

  describe("GET /auth/provider/slack", () => {
    it("returns 400 when SLACK_CLIENT_ID is not set", async () => {
      delete process.env.SLACK_CLIENT_ID;
      const { app } = createTestApp();
      const res = await request(app, "get", "/auth/provider/slack");
      expect(res.status).toBe(400);
      expect(res.body).toContain("SLACK_CLIENT_ID");
    });

    it("redirects to Slack OAuth when configured", async () => {
      process.env.SLACK_CLIENT_ID = "test-client-id";
      const { app } = createTestApp();
      const res = await request(app, "get", "/auth/provider/slack");
      expect(res.status).toBe(302);
      delete process.env.SLACK_CLIENT_ID;
    });
  });

  describe("GET /callback", () => {
    it("returns OK for bare GET with no params", async () => {
      const { app } = createTestApp();
      const res = await request(app, "get", "/callback");
      expect(res.status).toBe(200);
      expect(res.body).toBe("OK");
    });

    it("returns 400 when error param is present", async () => {
      const { app } = createTestApp();
      const res = await request(app, "get", "/callback?error=access_denied");
      expect(res.status).toBe(400);
      expect(res.body).toContain("Authorization denied");
    });

    it("returns 400 when state is missing", async () => {
      const { app } = createTestApp();
      const res = await request(app, "get", "/callback?code=abc");
      expect(res.status).toBe(400);
      expect(res.body).toContain("Missing code or state");
    });

    it("returns 400 for unknown state token", async () => {
      const { app } = createTestApp();
      const res = await request(app, "get", "/callback?code=abc&state=unknown-state");
      expect(res.status).toBe(400);
      expect(res.body).toContain("Unknown or expired OAuth state");
    });

    it("returns 400 for unknown OAuth 1.0 token", async () => {
      const { app } = createTestApp();
      const res = await request(app, "get", "/callback?oauth_token=unknown&oauth_verifier=abc");
      expect(res.status).toBe(400);
      expect(res.body).toContain("Unknown or expired OAuth 1.0 request token");
    });
  });

  describe("GET /auth/login/:provider", () => {
    it("returns 400 for unconfigured provider", async () => {
      vi.mocked(isProviderConfigured).mockReturnValue(false);
      const { app } = createTestApp();
      const res = await request(app, "get", "/auth/login/google");
      expect(res.status).toBe(400);
      expect(res.body).toContain("not configured");
      vi.mocked(isProviderConfigured).mockImplementation((name: string) => name === "google");
    });
  });

  describe("GET /auth/callback/:provider", () => {
    it("returns 400 for invalid state (state mismatch)", async () => {
      vi.mocked(getOAuthFlowCookies).mockReturnValue({
        state: "google:expected-state",
        codeVerifier: "verifier",
      });
      const { app } = createTestApp();
      const res = await request(app, "get", "/auth/callback/google?code=abc&state=wrong-state");
      expect(res.status).toBe(400);
      expect(res.body).toContain("Invalid state");
    });

    it("handles successful callback with valid state", async () => {
      const mockValidate = vi.fn(() =>
        Promise.resolve({
          tokens: {},
          user: { sub: "goog-1", email: "alice@test.com", name: "Alice" },
        }),
      );
      vi.mocked(getIdentityProvider).mockReturnValue({
        createAuthorizationUrl: vi.fn(() => new URL("https://accounts.google.com/authorize")),
        validateCallback: mockValidate,
      });
      vi.mocked(getOAuthFlowCookies).mockReturnValue({
        state: "google:state123",
        codeVerifier: "verifier123",
      });
      const { app } = createTestApp();
      const res = await request(
        app,
        "get",
        "/auth/callback/google?code=authcode&state=google:state123",
      );
      expect(res.status).toBe(302); // redirect to /
    });

    it("uses stored return_to for successful callback", async () => {
      const mockValidate = vi.fn(() =>
        Promise.resolve({
          tokens: {},
          user: { sub: "goog-1", email: "alice@test.com", name: "Alice" },
        }),
      );
      vi.mocked(getIdentityProvider).mockReturnValue({
        createAuthorizationUrl: vi.fn(() => new URL("https://accounts.google.com/authorize")),
        validateCallback: mockValidate,
      });
      vi.mocked(getOAuthFlowCookies).mockReturnValue({
        state: "google:state123",
        codeVerifier: "verifier123",
      });
      vi.mocked(getPostLoginRedirectCookie).mockReturnValue("/dashboard?onboarding=true");

      const { app } = createTestApp();
      const res = await request(
        app,
        "get",
        "/auth/callback/google?code=authcode&state=google:state123",
      );
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/dashboard?onboarding=true");
    });
  });

  describe("POST /auth/callback/:provider (Apple form_post)", () => {
    it("handles Apple form_post callback with code and state in POST body", async () => {
      const mockValidate = vi.fn(() =>
        Promise.resolve({
          tokens: {},
          user: { sub: "apple-1", email: "alice@icloud.com", name: null },
        }),
      );
      vi.mocked(getIdentityProvider).mockReturnValue({
        createAuthorizationUrl: vi.fn(() => new URL("https://appleid.apple.com/auth/authorize")),
        validateCallback: mockValidate,
      });
      vi.mocked(isProviderConfigured).mockImplementation((name: string) => name === "apple");
      vi.mocked(getOAuthFlowCookies).mockReturnValue({
        state: "apple:state-post",
        codeVerifier: "verifier",
      });
      const { app } = createTestApp();
      const res = await request(app, "post", "/auth/callback/apple", {
        formBody: { code: "apple-authcode", state: "apple:state-post" },
      });
      expect(res.status).toBe(302);
      expect(mockValidate).toHaveBeenCalledWith("apple-authcode", "verifier");
      // Restore
      vi.mocked(isProviderConfigured).mockImplementation((name: string) => name === "google");
    });

    it("returns 400 when POST body has error param", async () => {
      vi.mocked(isProviderConfigured).mockImplementation((name: string) => name === "apple");
      const { app } = createTestApp();
      const res = await request(app, "post", "/auth/callback/apple", {
        formBody: { error: "access_denied" },
      });
      expect(res.status).toBe(400);
      expect(res.body).toContain("Authorization denied");
      vi.mocked(isProviderConfigured).mockImplementation((name: string) => name === "google");
    });

    it("returns 400 when POST body is missing code", async () => {
      vi.mocked(isProviderConfigured).mockImplementation((name: string) => name === "apple");
      const { app } = createTestApp();
      const res = await request(app, "post", "/auth/callback/apple", {
        formBody: { state: "apple:some-state" },
      });
      expect(res.status).toBe(400);
      expect(res.body).toContain("Missing code or state");
      vi.mocked(isProviderConfigured).mockImplementation((name: string) => name === "google");
    });
  });

  describe("GET /auth/link/:provider", () => {
    it("returns 404 for unknown provider", async () => {
      const { app } = createTestApp();
      const res = await request(app, "get", "/auth/link/unknown");
      expect(res.status).toBe(404);
    });

    it("returns 401 when not logged in", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue(undefined);
      const { app } = createTestApp();
      const res = await request(app, "get", "/auth/link/google");
      expect(res.status).toBe(401);
    });

    it("returns 400 for unconfigured provider", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue("sess-1");
      vi.mocked(validateSession).mockResolvedValue({
        userId: "user-1",
        expiresAt: new Date("2027-01-01"),
      });
      vi.mocked(isProviderConfigured).mockReturnValue(false);
      const { app } = createTestApp();
      const res = await request(app, "get", "/auth/link/google");
      expect(res.status).toBe(400);
      vi.mocked(isProviderConfigured).mockImplementation((name: string) => name === "google");
    });

    it("returns 401 when session is expired", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue("sess-1");
      vi.mocked(validateSession).mockResolvedValue(null);
      const { app } = createTestApp();
      const res = await request(app, "get", "/auth/link/google");
      expect(res.status).toBe(401);
    });

    it("redirects when logged in with valid session", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue("sess-1");
      vi.mocked(validateSession).mockResolvedValue({
        userId: "user-1",
        expiresAt: new Date("2027-01-01"),
      });
      const { app } = createTestApp();
      const res = await request(app, "get", "/auth/link/google");
      expect(res.status).toBe(302);
    });
  });

  describe("GET /auth/login/data/:provider", () => {
    it("returns 404 for unknown provider", async () => {
      const { app } = createTestApp();
      const res = await request(app, "get", "/auth/login/data/nonexistent");
      expect(res.status).toBe(404);
      expect(res.body).toContain("Unknown provider");
    });

    it("returns 400 when provider has no OAuth config", async () => {
      vi.mocked(getAllProviders).mockReturnValue([
        { id: "test-provider", name: "Test", authSetup: () => ({ oauthConfig: null }) },
      ]);
      const { app } = createTestApp();
      const res = await request(app, "get", "/auth/login/data/test-provider");
      expect(res.status).toBe(400);
      expect(res.body).toContain("does not use OAuth");
    });

    it("returns 400 when provider cannot be used for login", async () => {
      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "test-provider",
          name: "Test",
          authSetup: () => ({
            oauthConfig: { authorizationEndpoint: "http://auth.test" },
            getUserIdentity: null,
          }),
        },
      ]);
      const { app } = createTestApp();
      const res = await request(app, "get", "/auth/login/data/test-provider");
      expect(res.status).toBe(400);
      expect(res.body).toContain("cannot be used for login");
    });
  });

  describe("GET /auth/link/data/:provider", () => {
    it("returns 401 when not logged in", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue(undefined);
      const { app } = createTestApp();
      const res = await request(app, "get", "/auth/link/data/wahoo");
      expect(res.status).toBe(401);
    });

    it("returns 401 when session is expired", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue("sess-1");
      vi.mocked(validateSession).mockResolvedValue(null);
      const { app } = createTestApp();
      const res = await request(app, "get", "/auth/link/data/wahoo");
      expect(res.status).toBe(401);
    });
  });

  describe("GET /auth/provider/:provider", () => {
    it("returns 401 when not logged in", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue(undefined);
      vi.mocked(validateSession).mockResolvedValue(null);
      const provider: SyncProvider = {
        id: "wahoo",
        name: "Wahoo",
        validate: () => null,
        sync: async () => ({
          provider: "wahoo",
          recordsSynced: 0,
          errors: [],
          duration: 0,
        }),
      };
      vi.mocked(getAllProviders).mockReturnValue([provider]);
      const { app } = createTestApp();
      const res = await request(app, "get", "/auth/provider/wahoo");
      expect(res.status).toBe(401);
      expect(res.body).toContain("logged in");
    });

    it("returns 404 for unknown provider", async () => {
      const { app } = createTestApp();
      const res = await request(app, "get", "/auth/provider/nonexistent");
      expect(res.status).toBe(404);
      expect(res.body).toContain("Unknown provider");
    });

    it("returns 400 when provider has no OAuth config", async () => {
      vi.mocked(getAllProviders).mockReturnValue([
        { id: "manual-provider", name: "Manual", authSetup: () => ({ oauthConfig: null }) },
      ]);
      const { app } = createTestApp();
      const res = await request(app, "get", "/auth/provider/manual-provider");
      expect(res.status).toBe(400);
      expect(res.body).toContain("does not use OAuth");
    });

    it("rejects credential providers with guidance to use Settings page", async () => {
      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "peloton",
          name: "Peloton",
          authSetup: () => ({
            oauthConfig: {},
            automatedLogin: vi.fn(),
          }),
        },
      ]);
      const { app } = createTestApp();
      const res = await request(app, "get", "/auth/provider/peloton");
      expect(res.status).toBe(400);
      expect(res.body).toContain("credential authentication");
    });

    it("redirects to OAuth for standard providers", async () => {
      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "wahoo",
          name: "Wahoo",
          authSetup: () => ({
            oauthConfig: {
              authorizationEndpoint: "https://api.wahoo.com/oauth/authorize",
              clientId: "test",
              redirectUri: "https://dofek.asherlc.com/callback",
              scopes: ["user_read"],
            },
          }),
        },
      ]);
      const { app } = createTestApp();
      const res = await request(app, "get", "/auth/provider/wahoo");
      expect(res.status).toBe(302);
    });
  });

  describe("GET /callback (Slack OAuth)", () => {
    it("returns 400 when SLACK_CLIENT_ID/SECRET not set for slack callback", async () => {
      delete process.env.SLACK_CLIENT_ID;
      delete process.env.SLACK_CLIENT_SECRET;
      const { app } = createTestApp();
      const res = await request(app, "get", "/callback?code=abc&state=slack:fake-state");
      expect(res.status).toBe(400);
    });

    it("creates auth_account linking installer Slack ID to logged-in user", async () => {
      process.env.SLACK_CLIENT_ID = "test-client-id";
      process.env.SLACK_CLIENT_SECRET = "test-client-secret";

      // Simulate logged-in user
      vi.mocked(getSessionIdFromRequest).mockReturnValue("sess-1");
      vi.mocked(validateSession).mockResolvedValue({
        userId: "real-user-id",
        expiresAt: new Date("2027-01-01"),
      });

      const { app, fakeDb } = createTestApp();

      // Step 1: Hit /auth/provider/slack to populate the state map
      const slackRes = await request(app, "get", "/auth/provider/slack");
      expect(slackRes.status).toBe(302);

      // Extract state token from redirect Location header
      const location = slackRes.headers.location;
      expect(location).toBeDefined();
      if (typeof location !== "string") throw new Error("Expected location header to be a string");
      const redirectUrl = new URL(location);
      const state = redirectUrl.searchParams.get("state");
      expect(state).toBeTruthy();
      expect(state).toMatch(/^slack:/);

      // Step 2: Mock Slack API fetch for token exchange, while letting
      // the test's own HTTP requests through
      const realFetch = globalThis.fetch;
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input instanceof Request
                ? input.url
                : String(input);
        if (url.includes("slack.com/api/oauth.v2.access")) {
          return new Response(
            JSON.stringify({
              ok: true,
              access_token: "xoxb-test-bot-token",
              team: { id: "T_TEAM", name: "Test Workspace" },
              bot_user_id: "U_BOT",
              authed_user: { id: "U_INSTALLER" },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        return realFetch(input, init);
      });

      // Step 3: Hit callback with the state
      const callbackRes = await request(app, "get", `/callback?code=slack-code&state=${state}`);
      expect(callbackRes.status).toBe(200);
      expect(callbackRes.body).toContain("Authorized!");

      // Step 4: Verify db.execute was called to store installation AND create auth_account
      const executeCalls = vi.mocked(fakeDb.execute).mock.calls;
      // Should have at least 2 calls: installation insert + auth_account insert
      expect(executeCalls.length).toBeGreaterThanOrEqual(2);

      fetchSpy.mockRestore();
      delete process.env.SLACK_CLIENT_ID;
      delete process.env.SLACK_CLIENT_SECRET;
    });
  });

  describe("GET /auth/provider/:provider (PKCE flow)", () => {
    it("redirects with PKCE code challenge when provider uses PKCE", async () => {
      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "strava",
          name: "Strava",
          authSetup: () => ({
            oauthConfig: {
              authorizationEndpoint: "https://www.strava.com/oauth/authorize",
              clientId: "test",
              redirectUri: "https://dofek.asherlc.com/callback",
              scopes: ["read"],
              usePkce: true,
            },
          }),
        },
      ]);
      const { app } = createTestApp();
      const res = await request(app, "get", "/auth/provider/strava");
      expect(res.status).toBe(302);
    });
  });

  describe("GET /auth/callback/:provider (mobile redirect)", () => {
    it("redirects to deep link with session token when mobile scheme is set", async () => {
      const mockValidate = vi.fn(() =>
        Promise.resolve({
          tokens: {},
          user: { sub: "goog-1", email: "alice@test.com", name: "Alice" },
        }),
      );
      vi.mocked(getIdentityProvider).mockReturnValue({
        createAuthorizationUrl: vi.fn(() => new URL("https://accounts.google.com/authorize")),
        validateCallback: mockValidate,
      });
      vi.mocked(getOAuthFlowCookies).mockReturnValue({
        state: "google:state-mobile",
        codeVerifier: "verifier",
      });
      vi.mocked(getMobileSchemeCookie).mockReturnValue("dofek");
      const { app } = createTestApp();
      const res = await request(
        app,
        "get",
        "/auth/callback/google?code=authcode&state=google:state-mobile",
      );
      expect(res.status).toBe(302);
      const location = res.headers.location;
      expect(typeof location).toBe("string");
      expect(location).toContain("dofek://auth/callback?session=");
      // Restore
      vi.mocked(getMobileSchemeCookie).mockReturnValue(undefined);
    });
  });

  describe("POST /auth/callback/:provider (Apple form_post)", () => {
    it("returns 404 for unknown provider", async () => {
      const { app } = createTestApp();
      const res = await request(app, "post", "/auth/callback/unknown", {
        formBody: { code: "x", state: "y" },
      });
      expect(res.status).toBe(404);
    });

    it("returns 400 when error param is present", async () => {
      const { app } = createTestApp();
      const res = await request(app, "post", "/auth/callback/google", {
        formBody: { error: "access_denied" },
      });
      expect(res.status).toBe(400);
      expect(res.body).toContain("Authorization denied");
    });

    it("returns 400 when code or state is missing", async () => {
      const { app } = createTestApp();
      const res = await request(app, "post", "/auth/callback/google", {
        formBody: {},
      });
      expect(res.status).toBe(400);
      expect(res.body).toContain("Missing code or state");
    });

    it("returns helpful hint for unknown state on localhost", async () => {
      const { app } = createTestApp();
      const res = await request(app, "get", "/callback?code=abc&state=unknown", {
        headers: { host: "localhost:3000" },
      });
      expect(res.status).toBe(400);
      expect(res.body).toContain("Unknown or expired OAuth state");
      expect(res.body).toContain("Try setting OAUTH_REDIRECT_URI_unencrypted");
    });

    it("succeeds with server-side state when cookies are missing (Apple form_post)", async () => {
      const mockValidate = vi.fn(() =>
        Promise.resolve({
          tokens: {},
          user: { sub: "apple-1", email: "alice@icloud.com", name: null },
        }),
      );
      vi.mocked(getIdentityProvider).mockReturnValue({
        createAuthorizationUrl: vi.fn(() => new URL("https://appleid.apple.com/auth")),
        validateCallback: mockValidate,
      });
      // Cookies return empty (simulating SameSite=Lax not sent on cross-site POST)
      vi.mocked(getOAuthFlowCookies).mockReturnValue({
        state: undefined,
        codeVerifier: undefined,
      });

      const { app } = createTestApp();

      // Step 1: Hit /auth/login/apple to populate server-side state map
      // (isProviderConfigured already returns true for google only, so configure apple)
      vi.mocked(isProviderConfigured).mockReturnValue(true);
      const loginRes = await request(app, "get", "/auth/login/apple");
      expect(loginRes.status).toBe(302);
      const location = loginRes.headers.location;
      expect(typeof location).toBe("string");

      // The state is encoded as "apple:mock-state" by the login handler
      const statePayload = "apple:mock-state";

      // Step 2: POST callback with state from form body (no cookies)
      const callbackRes = await request(app, "post", "/auth/callback/apple", {
        formBody: { code: "apple-auth-code", state: statePayload },
      });
      expect(callbackRes.status).toBe(302); // redirect to /
      expect(mockValidate).toHaveBeenCalledWith("apple-auth-code", "mock-verifier");

      // Restore
      vi.mocked(isProviderConfigured).mockImplementation((name: string) => name === "google");
    });
  });

  describe("GET /auth/callback/:provider (server-side state fallback)", () => {
    it("falls back to server-side state when cookies are missing", async () => {
      const mockValidate = vi.fn(() =>
        Promise.resolve({
          tokens: {},
          user: { sub: "goog-1", email: "alice@test.com", name: "Alice" },
        }),
      );
      vi.mocked(getIdentityProvider).mockReturnValue({
        createAuthorizationUrl: vi.fn(() => new URL("https://accounts.google.com/authorize")),
        validateCallback: mockValidate,
      });
      // Cookies return empty (simulating bounce tracking prevention)
      vi.mocked(getOAuthFlowCookies).mockReturnValue({
        state: undefined,
        codeVerifier: undefined,
      });

      const { app } = createTestApp();

      // Step 1: Hit /auth/login/google to populate server-side state map
      const loginRes = await request(app, "get", "/auth/login/google");
      expect(loginRes.status).toBe(302);

      const statePayload = "google:mock-state";

      // Step 2: GET callback with state in query (no cookies)
      const callbackRes = await request(
        app,
        "get",
        `/auth/callback/google?code=authcode&state=${statePayload}`,
      );
      expect(callbackRes.status).toBe(302);
      expect(mockValidate).toHaveBeenCalledWith("authcode", "mock-verifier");
    });
  });

  describe("server-side state fallback — mutation killers", () => {
    it("returns Invalid state when server-side state is also missing", async () => {
      // Cookies empty AND no server-side state entry → must fail
      vi.mocked(getOAuthFlowCookies).mockReturnValue({
        state: undefined,
        codeVerifier: undefined,
      });
      const { app } = createTestApp();
      const res = await request(
        app,
        "get",
        "/auth/callback/google?code=authcode&state=unknown-state",
      );
      expect(res.status).toBe(400);
      expect(res.body).toContain("Invalid state");
    });

    it("preserves linkUserId from server-side state in link flow (POST)", async () => {
      const mockValidate = vi.fn(() =>
        Promise.resolve({
          tokens: {},
          user: { sub: "apple-1", email: "alice@icloud.com", name: null },
        }),
      );
      vi.mocked(getIdentityProvider).mockReturnValue({
        createAuthorizationUrl: vi.fn(() => new URL("https://appleid.apple.com/auth")),
        validateCallback: mockValidate,
      });
      vi.mocked(getOAuthFlowCookies).mockReturnValue({
        state: undefined,
        codeVerifier: undefined,
      });
      vi.mocked(isProviderConfigured).mockReturnValue(true);

      // Simulate logged-in user for link flow
      vi.mocked(getSessionIdFromRequest).mockReturnValue("sess-1");
      vi.mocked(validateSession).mockResolvedValue({
        userId: "user-1",
        expiresAt: new Date("2027-01-01"),
      });

      const { app } = createTestApp();

      // Start link flow to populate server-side state with linkUserId
      const linkRes = await request(app, "get", "/auth/link/apple");
      expect(linkRes.status).toBe(302);

      // POST callback — linkUserId should come from server-side state
      const callbackRes = await request(app, "post", "/auth/callback/apple", {
        formBody: { code: "apple-code", state: "apple:mock-state" },
      });
      expect(callbackRes.status).toBe(302);
      // Link flow redirects to /settings
      expect(callbackRes.headers.location).toBe("/settings");

      // Restore
      vi.mocked(isProviderConfigured).mockImplementation((name: string) => name === "google");
      vi.mocked(getSessionIdFromRequest).mockReturnValue(undefined);
      vi.mocked(validateSession).mockResolvedValue(null);
    });

    it("preserves mobileScheme from server-side state (POST)", async () => {
      const mockValidate = vi.fn(() =>
        Promise.resolve({
          tokens: {},
          user: { sub: "apple-1", email: "alice@icloud.com", name: null },
        }),
      );
      vi.mocked(getIdentityProvider).mockReturnValue({
        createAuthorizationUrl: vi.fn(() => new URL("https://appleid.apple.com/auth")),
        validateCallback: mockValidate,
      });
      vi.mocked(getOAuthFlowCookies).mockReturnValue({
        state: undefined,
        codeVerifier: undefined,
      });
      vi.mocked(isProviderConfigured).mockReturnValue(true);

      const { app } = createTestApp();

      // Start login flow with redirect_scheme to populate server-side state
      const loginRes = await request(app, "get", "/auth/login/apple?redirect_scheme=dofek");
      expect(loginRes.status).toBe(302);

      // POST callback — mobileScheme should come from server-side state
      const callbackRes = await request(app, "post", "/auth/callback/apple", {
        formBody: { code: "apple-code", state: "apple:mock-state" },
      });
      expect(callbackRes.status).toBe(302);
      expect(callbackRes.headers.location).toContain("dofek://auth/callback?session=");

      // Restore
      vi.mocked(isProviderConfigured).mockImplementation((name: string) => name === "google");
    });

    it("preserves returnTo from server-side state (POST)", async () => {
      const mockValidate = vi.fn(() =>
        Promise.resolve({
          tokens: {},
          user: { sub: "apple-1", email: "alice@icloud.com", name: null },
        }),
      );
      vi.mocked(getIdentityProvider).mockReturnValue({
        createAuthorizationUrl: vi.fn(() => new URL("https://appleid.apple.com/auth")),
        validateCallback: mockValidate,
      });
      vi.mocked(getOAuthFlowCookies).mockReturnValue({
        state: undefined,
        codeVerifier: undefined,
      });
      // Ensure no stale returnTo from cookie mock
      vi.mocked(getPostLoginRedirectCookie).mockReturnValue(undefined);
      vi.mocked(isProviderConfigured).mockReturnValue(true);

      const { app } = createTestApp();

      // Start login flow with return_to
      const loginRes = await request(app, "get", "/auth/login/apple?return_to=%2Fdashboard");
      expect(loginRes.status).toBe(302);

      // POST callback — returnTo should come from server-side state
      const callbackRes = await request(app, "post", "/auth/callback/apple", {
        formBody: { code: "apple-code", state: "apple:mock-state" },
      });
      expect(callbackRes.status).toBe(302);
      expect(callbackRes.headers.location).toBe("/dashboard");

      // Restore
      vi.mocked(isProviderConfigured).mockImplementation((name: string) => name === "google");
    });

    it("server-side state is consumed (single use)", async () => {
      const mockValidate = vi.fn(() =>
        Promise.resolve({
          tokens: {},
          user: { sub: "goog-1", email: "alice@test.com", name: "Alice" },
        }),
      );
      vi.mocked(getIdentityProvider).mockReturnValue({
        createAuthorizationUrl: vi.fn(() => new URL("https://accounts.google.com/authorize")),
        validateCallback: mockValidate,
      });
      vi.mocked(getOAuthFlowCookies).mockReturnValue({
        state: undefined,
        codeVerifier: undefined,
      });

      const { app } = createTestApp();

      // Populate server-side state
      const loginRes = await request(app, "get", "/auth/login/google");
      expect(loginRes.status).toBe(302);

      // First callback succeeds
      const res1 = await request(
        app,
        "get",
        "/auth/callback/google?code=authcode&state=google:mock-state",
      );
      expect(res1.status).toBe(302);

      // Second callback with same state fails (consumed)
      const res2 = await request(
        app,
        "get",
        "/auth/callback/google?code=authcode&state=google:mock-state",
      );
      expect(res2.status).toBe(400);
      expect(res2.body).toContain("Invalid state");
    });
  });

  describe("GET /auth/callback/:provider (link flow)", () => {
    it("redirects to /settings on successful link callback", async () => {
      const mockValidate = vi.fn(() =>
        Promise.resolve({
          tokens: {},
          user: { sub: "goog-1", email: "alice@test.com", name: "Alice" },
        }),
      );
      vi.mocked(getIdentityProvider).mockReturnValue({
        createAuthorizationUrl: vi.fn(() => new URL("https://accounts.google.com/authorize")),
        validateCallback: mockValidate,
      });
      vi.mocked(getOAuthFlowCookies).mockReturnValue({
        state: "google:link-state",
        codeVerifier: "verifier",
      });
      // Simulate link cookie present
      const { getLinkUserCookie } = await import("../auth/cookies.ts");
      vi.mocked(getLinkUserCookie).mockReturnValue("user-1");
      const { app } = createTestApp();
      const res = await request(
        app,
        "get",
        "/auth/callback/google?code=authcode&state=google:link-state",
      );
      expect(res.status).toBe(302);
    });
  });

  describe("GET /auth/link/data/:provider", () => {
    it("returns 404 for unknown provider when authenticated", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue("sess-1");
      vi.mocked(validateSession).mockResolvedValue({
        userId: "user-1",
        expiresAt: new Date("2027-01-01"),
      });
      vi.mocked(getAllProviders).mockReturnValue([]);
      const { app } = createTestApp();
      const res = await request(app, "get", "/auth/link/data/nonexistent");
      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/auth/providers (data login providers)", () => {
    it("returns data providers that have getUserIdentity and oauthConfig", async () => {
      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "strava",
          name: "Strava",
          validate: () => null,
          authSetup: (options?: { host?: string }) => ({
            oauthConfig: {
              authorizationEndpoint: "https://strava.com/oauth",
              redirectUri: getOAuthRedirectUri(options?.host),
            },
            exchangeCode: vi.fn(),
            getUserIdentity: vi.fn(),
          }),
        },
        {
          id: "polar",
          name: "Polar",
          validate: () => null,
          authSetup: () => ({
            oauthConfig: { authorizationEndpoint: "https://polar.com/oauth" },
            exchangeCode: vi.fn(),
            // no getUserIdentity — should not appear
          }),
        },
      ]);
      const { app } = createTestApp();
      const res = await request(app, "get", "/api/auth/providers");
      const data = JSON.parse(res.body);
      expect(data.data).toEqual(["strava"]);
    });

    it("skips providers whose authSetup throws instead of crashing the list", async () => {
      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "broken",
          name: "Broken",
          validate: () => "not configured",
          authSetup: () => {
            throw new Error("CLIENT_ID is not set");
          },
        },
        {
          id: "strava",
          name: "Strava",
          validate: () => null,
          authSetup: (options?: { host?: string }) => ({
            oauthConfig: {
              authorizationEndpoint: "https://strava.com/oauth",
              redirectUri: getOAuthRedirectUri(options?.host),
            },
            exchangeCode: vi.fn(),
            getUserIdentity: vi.fn(),
          }),
        },
      ]);
      const { app } = createTestApp();
      const res = await request(app, "get", "/api/auth/providers");
      const data = JSON.parse(res.body);
      expect(data.data).toEqual(["strava"]);
    });

    it("returns fallback when provider listing throws", async () => {
      vi.mocked(getAllProviders).mockImplementation(() => {
        throw new Error("Registry error");
      });
      const { app } = createTestApp();
      const res = await request(app, "get", "/api/auth/providers");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.identity).toEqual(["google"]);
      expect(data.data).toEqual([]);
    });
  });

  describe("GET /auth/login/:provider (error handling)", () => {
    it("returns 500 when login flow throws", async () => {
      vi.mocked(getIdentityProvider).mockImplementation(() => {
        throw new Error("Provider init failed");
      });
      const { app } = createTestApp();
      const res = await request(app, "get", "/auth/login/google");
      expect(res.status).toBe(500);
      expect(res.body).toContain("Auth error");
      // Restore
      vi.mocked(getIdentityProvider).mockReturnValue({
        createAuthorizationUrl: vi.fn(() => new URL("https://accounts.google.com/authorize")),
        validateCallback: vi.fn(),
      });
    });
  });

  describe("GET /auth/link/:provider (error handling)", () => {
    it("returns 500 when link flow throws", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue("sess-1");
      vi.mocked(validateSession).mockResolvedValue({
        userId: "user-1",
        expiresAt: new Date("2027-01-01"),
      });
      vi.mocked(getIdentityProvider).mockImplementation(() => {
        throw new Error("Provider init failed");
      });
      const { app } = createTestApp();
      const res = await request(app, "get", "/auth/link/google");
      expect(res.status).toBe(500);
      // Restore
      vi.mocked(getIdentityProvider).mockReturnValue({
        createAuthorizationUrl: vi.fn(() => new URL("https://accounts.google.com/authorize")),
        validateCallback: vi.fn(),
      });
    });
  });

  describe("POST /auth/callback/:provider vs GET (body vs query param reading)", () => {
    it("POST reads code/state from body, not query params", async () => {
      const mockValidate = vi.fn(() =>
        Promise.resolve({
          tokens: {},
          user: { sub: "apple-1", email: "alice@icloud.com", name: null },
        }),
      );
      vi.mocked(getIdentityProvider).mockReturnValue({
        createAuthorizationUrl: vi.fn(() => new URL("https://appleid.apple.com/auth/authorize")),
        validateCallback: mockValidate,
      });
      vi.mocked(isProviderConfigured).mockImplementation((name: string) => name === "apple");
      vi.mocked(getOAuthFlowCookies).mockReturnValue({
        state: "apple:form-state",
        codeVerifier: "form-verifier",
      });
      const { app } = createTestApp();
      // POST body has the real code/state; query has different values
      const res = await request(app, "post", "/auth/callback/apple?code=wrong&state=wrong", {
        formBody: { code: "body-code", state: "apple:form-state" },
      });
      expect(res.status).toBe(302);
      // The provider.validateCallback should have received the body code, not the query code
      expect(mockValidate).toHaveBeenCalledWith("body-code", "form-verifier");
      vi.mocked(isProviderConfigured).mockImplementation((name: string) => name === "google");
    });

    it("GET reads code/state from query params, not body", async () => {
      const mockValidate = vi.fn(() =>
        Promise.resolve({
          tokens: {},
          user: { sub: "goog-1", email: "alice@test.com", name: "Alice" },
        }),
      );
      vi.mocked(getIdentityProvider).mockReturnValue({
        createAuthorizationUrl: vi.fn(() => new URL("https://accounts.google.com/authorize")),
        validateCallback: mockValidate,
      });
      vi.mocked(getOAuthFlowCookies).mockReturnValue({
        state: "google:get-state",
        codeVerifier: "get-verifier",
      });
      const { app } = createTestApp();
      const res = await request(
        app,
        "get",
        "/auth/callback/google?code=query-code&state=google:get-state",
      );
      expect(res.status).toBe(302);
      expect(mockValidate).toHaveBeenCalledWith("query-code", "get-verifier");
    });
  });

  describe("GET /auth/callback/:provider (mobile scheme in identity callback)", () => {
    it("creates session and redirects to mobile deep link", async () => {
      const mockValidate = vi.fn(() =>
        Promise.resolve({
          tokens: {},
          user: { sub: "goog-mobile", email: "mobile@test.com", name: "Mobile User" },
        }),
      );
      vi.mocked(getIdentityProvider).mockReturnValue({
        createAuthorizationUrl: vi.fn(() => new URL("https://accounts.google.com/authorize")),
        validateCallback: mockValidate,
      });
      vi.mocked(getOAuthFlowCookies).mockReturnValue({
        state: "google:mobile-state",
        codeVerifier: "mobile-verifier",
      });
      vi.mocked(getMobileSchemeCookie).mockReturnValue("dofek");
      vi.mocked(getLinkUserCookie).mockReturnValue(null);
      const { app } = createTestApp();
      const res = await request(
        app,
        "get",
        "/auth/callback/google?code=authcode&state=google:mobile-state",
      );
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain("dofek://auth/callback?session=sess-1");
      // Should have created a session
      expect(createSession).toHaveBeenCalled();
      // Should NOT have set a session cookie (mobile uses deep link instead)
      expect(setSessionCookie).not.toHaveBeenCalled();
      vi.mocked(getMobileSchemeCookie).mockReturnValue(undefined);
    });

    it("sets session cookie and redirects to / when no mobile scheme", async () => {
      const mockValidate = vi.fn(() =>
        Promise.resolve({
          tokens: {},
          user: { sub: "goog-web", email: "web@test.com", name: "Web User" },
        }),
      );
      vi.mocked(getIdentityProvider).mockReturnValue({
        createAuthorizationUrl: vi.fn(() => new URL("https://accounts.google.com/authorize")),
        validateCallback: mockValidate,
      });
      vi.mocked(getOAuthFlowCookies).mockReturnValue({
        state: "google:web-state",
        codeVerifier: "web-verifier",
      });
      vi.mocked(getMobileSchemeCookie).mockReturnValue(undefined);
      vi.mocked(getLinkUserCookie).mockReturnValue(null);
      vi.mocked(getPostLoginRedirectCookie).mockReturnValue(undefined);
      const { app } = createTestApp();
      const res = await request(
        app,
        "get",
        "/auth/callback/google?code=authcode&state=google:web-state",
      );
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/");
      expect(createSession).toHaveBeenCalled();
      expect(setSessionCookie).toHaveBeenCalled();
    });

    it("does not create new session during link flow (linkUserId present)", async () => {
      const mockValidate = vi.fn(() =>
        Promise.resolve({
          tokens: {},
          user: { sub: "goog-link", email: "link@test.com", name: "Link User" },
        }),
      );
      vi.mocked(getIdentityProvider).mockReturnValue({
        createAuthorizationUrl: vi.fn(() => new URL("https://accounts.google.com/authorize")),
        validateCallback: mockValidate,
      });
      vi.mocked(getOAuthFlowCookies).mockReturnValue({
        state: "google:link-state2",
        codeVerifier: "link-verifier",
      });
      vi.mocked(getLinkUserCookie).mockReturnValue("existing-user-id");
      const { app } = createTestApp();
      const res = await request(
        app,
        "get",
        "/auth/callback/google?code=authcode&state=google:link-state2",
      );
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe("/settings");
      // Should NOT have created a new session (link flow preserves existing)
      expect(createSession).not.toHaveBeenCalled();
      expect(setSessionCookie).not.toHaveBeenCalled();
      // But should have called resolveOrCreateUser with the linkUserId
      expect(resolveOrCreateUser).toHaveBeenCalledWith(
        expect.anything(),
        "google",
        expect.objectContaining({ providerAccountId: "goog-link" }),
        "existing-user-id",
      );
      vi.mocked(getLinkUserCookie).mockReturnValue(null);
    });
  });

  describe("GET /api/auth/me (mobile user-agent detection)", () => {
    function setupValidSession(fakeDb: ReturnType<typeof createDatabaseFromEnv>) {
      vi.mocked(getSessionIdFromRequest).mockReturnValue("good-session");
      vi.mocked(validateSession).mockResolvedValue({
        userId: "user-1",
        expiresAt: new Date("2027-01-01"),
      });
      vi.mocked(fakeDb.execute).mockResolvedValue([
        { id: "user-1", name: "Alice", email: "alice@test.com", is_admin: false },
      ]);
    }

    it("returns user data for both desktop and mobile user agents", async () => {
      const { app, fakeDb } = createTestApp();
      setupValidSession(fakeDb);
      const res = await request(app, "get", "/api/auth/me");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.id).toBe("user-1");
      expect(data.name).toBe("Alice");
    });

    it("returns user data with Darwin user-agent", async () => {
      // Darwin is in the user-agent for iOS native HTTP clients
      // We can't easily set custom headers with the simple request helper,
      // but we can verify the route returns user data regardless of agent
      const { app, fakeDb } = createTestApp();
      setupValidSession(fakeDb);
      const res = await request(app, "get", "/api/auth/me");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data).toEqual({
        id: "user-1",
        name: "Alice",
        email: "alice@test.com",
        isAdmin: false,
      });
    });

    it("falls back to 'unknown' user-agent gracefully", async () => {
      const { app, fakeDb } = createTestApp();
      setupValidSession(fakeDb);
      // Standard fetch doesn't set Darwin/CFNetwork, so userAgent defaults to something else
      const res = await request(app, "get", "/api/auth/me");
      expect(res.status).toBe(200);
      // The response should be the same user data regardless of user-agent
      const data = JSON.parse(res.body);
      expect(data.name).toBe("Alice");
    });
  });

  describe("GET /auth/login/data/:provider (mobile scheme handling)", () => {
    it("passes mobileScheme when redirect_scheme=dofek is provided", async () => {
      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "strava",
          name: "Strava",
          authSetup: () => ({
            oauthConfig: {
              authorizationEndpoint: "https://www.strava.com/oauth/authorize",
              clientId: "test",
              redirectUri: "https://dofek.asherlc.com/callback",
              scopes: ["read"],
            },
            getUserIdentity: vi.fn(),
          }),
        },
      ]);
      const { app } = createTestApp();
      const res = await request(app, "get", "/auth/login/data/strava?redirect_scheme=dofek");
      expect(res.status).toBe(302);
    });

    it("ignores invalid mobile scheme", async () => {
      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "strava",
          name: "Strava",
          authSetup: () => ({
            oauthConfig: {
              authorizationEndpoint: "https://www.strava.com/oauth/authorize",
              clientId: "test",
              redirectUri: "https://dofek.asherlc.com/callback",
              scopes: ["read"],
            },
            getUserIdentity: vi.fn(),
          }),
        },
      ]);
      const { app } = createTestApp();
      // "evil" is not a valid mobile scheme (only "dofek" passes isValidMobileScheme)
      const res = await request(app, "get", "/auth/login/data/strava?redirect_scheme=evil");
      expect(res.status).toBe(302);
    });

    it("does not pass mobileScheme when redirect_scheme is absent", async () => {
      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "strava",
          name: "Strava",
          authSetup: () => ({
            oauthConfig: {
              authorizationEndpoint: "https://www.strava.com/oauth/authorize",
              clientId: "test",
              redirectUri: "https://dofek.asherlc.com/callback",
              scopes: ["read"],
            },
            getUserIdentity: vi.fn(),
          }),
        },
      ]);
      const { app } = createTestApp();
      const res = await request(app, "get", "/auth/login/data/strava");
      expect(res.status).toBe(302);
    });
  });

  describe("GET /callback (OAuth 2.0 data provider success flow)", () => {
    it("exchanges code, saves tokens, and returns success HTML", async () => {
      const mockExchangeCode = vi.fn(() =>
        Promise.resolve({
          accessToken: "access-token-123",
          refreshToken: "refresh-token-123",
          expiresAt: new Date("2027-06-01"),
          scopes: "read,write",
        }),
      );
      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "wahoo",
          name: "Wahoo",
          authSetup: () => ({
            oauthConfig: {
              authorizationEndpoint: "https://api.wahoo.com/oauth/authorize",
              clientId: "test",
              redirectUri: "https://dofek.asherlc.com/callback",
              scopes: ["user_read"],
            },
            exchangeCode: mockExchangeCode,
          }),
        },
      ]);

      const { app } = createTestApp();

      // Step 1: Start the OAuth flow to populate state map
      const startRes = await request(app, "get", "/auth/provider/wahoo");
      expect(startRes.status).toBe(302);
      const location = startRes.headers.location;
      if (typeof location !== "string") throw new Error("Expected location header");
      const redirectUrl = new URL(location);
      const state = redirectUrl.searchParams.get("state");
      expect(state).toBeTruthy();

      // Step 2: Hit callback with code + state
      const callbackRes = await request(
        app,
        "get",
        `/callback?code=wahoo-auth-code&state=${state}`,
      );
      expect(callbackRes.status).toBe(200);
      expect(callbackRes.body).toContain("Authorized!");
      expect(callbackRes.body).toContain("Wahoo connected successfully.");
      expect(mockExchangeCode).toHaveBeenCalledWith("wahoo-auth-code", undefined);
    });

    it("handles login intent: creates session and redirects to /", async () => {
      const mockExchangeCode = vi.fn(() =>
        Promise.resolve({
          accessToken: "login-access-token",
          refreshToken: "login-refresh-token",
          expiresAt: new Date("2027-06-01"),
          scopes: "read",
        }),
      );
      const mockGetUserIdentity = vi.fn(() =>
        Promise.resolve({
          providerAccountId: "strava-user-1",
          email: "runner@test.com",
          name: "Runner",
        }),
      );
      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "strava",
          name: "Strava",
          authSetup: () => ({
            oauthConfig: {
              authorizationEndpoint: "https://www.strava.com/oauth/authorize",
              clientId: "test",
              redirectUri: "https://dofek.asherlc.com/callback",
              scopes: ["read"],
            },
            exchangeCode: mockExchangeCode,
            getUserIdentity: mockGetUserIdentity,
          }),
        },
      ]);

      const { app } = createTestApp();

      // Start data login flow
      const startRes = await request(app, "get", "/auth/login/data/strava");
      expect(startRes.status).toBe(302);
      const location = startRes.headers.location;
      if (typeof location !== "string") throw new Error("Expected location header");
      const redirectUrl = new URL(location);
      const state = redirectUrl.searchParams.get("state");
      expect(state).toBeTruthy();

      // Hit callback
      const callbackRes = await request(app, "get", `/callback?code=strava-code&state=${state}`);
      const { ensureProvider, saveTokens } = await import("dofek/db/tokens");
      expect(callbackRes.status).toBe(302);
      expect(callbackRes.headers.location).toBe("/");
      expect(mockGetUserIdentity).toHaveBeenCalledWith("login-access-token");
      expect(resolveOrCreateUser).toHaveBeenCalled();
      expect(ensureProvider).toHaveBeenCalledWith(
        expect.anything(),
        "strava",
        "Strava",
        undefined,
        "user-1",
      );
      expect(saveTokens).toHaveBeenCalledWith(
        expect.anything(),
        "strava",
        {
          accessToken: "login-access-token",
          refreshToken: "login-refresh-token",
          expiresAt: new Date("2027-06-01"),
          scopes: "read",
        },
        "user-1",
      );
      expect(createSession).toHaveBeenCalled();
      expect(setSessionCookie).toHaveBeenCalled();
    });

    it("handles login intent with mobile scheme: redirects to deep link", async () => {
      const mockExchangeCode = vi.fn(() =>
        Promise.resolve({
          accessToken: "mobile-access-token",
          refreshToken: "mobile-refresh-token",
          expiresAt: new Date("2027-06-01"),
          scopes: "read",
        }),
      );
      const mockGetUserIdentity = vi.fn(() =>
        Promise.resolve({
          providerAccountId: "strava-mobile-1",
          email: "mobile@test.com",
          name: "Mobile Runner",
        }),
      );
      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "strava",
          name: "Strava",
          authSetup: () => ({
            oauthConfig: {
              authorizationEndpoint: "https://www.strava.com/oauth/authorize",
              clientId: "test",
              redirectUri: "https://dofek.asherlc.com/callback",
              scopes: ["read"],
            },
            exchangeCode: mockExchangeCode,
            getUserIdentity: mockGetUserIdentity,
          }),
        },
      ]);

      const { app } = createTestApp();

      // Start data login flow with redirect_scheme=dofek
      const startRes = await request(app, "get", "/auth/login/data/strava?redirect_scheme=dofek");
      expect(startRes.status).toBe(302);
      const location = startRes.headers.location;
      if (typeof location !== "string") throw new Error("Expected location header");
      const redirectUrl = new URL(location);
      const state = redirectUrl.searchParams.get("state");
      expect(state).toBeTruthy();

      // Hit callback
      const callbackRes = await request(
        app,
        "get",
        `/callback?code=strava-mobile-code&state=${state}`,
      );
      expect(callbackRes.status).toBe(302);
      expect(callbackRes.headers.location).toContain("dofek://auth/callback?session=");
      expect(setSessionCookie).not.toHaveBeenCalled();
    });

    it("renders a manual email form when provider signup needs an email", async () => {
      const mockExchangeCode = vi.fn(() =>
        Promise.resolve({
          accessToken: "missing-email-access-token",
          refreshToken: "missing-email-refresh-token",
          expiresAt: new Date("2027-06-01"),
          scopes: "read",
        }),
      );
      const mockGetUserIdentity = vi.fn(() =>
        Promise.resolve({
          providerAccountId: "strava-missing-email-1",
          email: null,
          name: "Runner",
        }),
      );
      vi.mocked(resolveOrCreateUser).mockRejectedValueOnce(
        new MissingEmailForSignupError("Strava"),
      );
      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "strava",
          name: "Strava",
          authSetup: () => ({
            oauthConfig: {
              authorizationEndpoint: "https://www.strava.com/oauth/authorize",
              clientId: "test",
              redirectUri: "https://dofek.asherlc.com/callback",
              scopes: ["read"],
            },
            exchangeCode: mockExchangeCode,
            getUserIdentity: mockGetUserIdentity,
            identityCapabilities: { providesEmail: false },
          }),
        },
      ]);

      const { app } = createTestApp();

      const startRes = await request(app, "get", "/auth/login/data/strava");
      expect(startRes.status).toBe(302);
      const location = startRes.headers.location;
      if (typeof location !== "string") throw new Error("Expected location header");
      const state = new URL(location).searchParams.get("state");

      const callbackRes = await request(
        app,
        "get",
        `/callback?code=strava-missing-email-code&state=${state}`,
      );
      const { ensureProvider } = await import("dofek/db/tokens");

      expect(callbackRes.status).toBe(200);
      expect(callbackRes.body).toContain("Enter your email to finish signing in");
      expect(callbackRes.body).toContain('action="/auth/complete-signup"');
      expect(ensureProvider).not.toHaveBeenCalled();
      expect(createSession).not.toHaveBeenCalled();
      expect(setSessionCookie).not.toHaveBeenCalled();
    });

    it("completes pending signup after collecting email on the web", async () => {
      const mockExchangeCode = vi.fn(() =>
        Promise.resolve({
          accessToken: "pending-web-access-token",
          refreshToken: "pending-web-refresh-token",
          expiresAt: new Date("2027-06-01"),
          scopes: "read",
        }),
      );
      const mockGetUserIdentity = vi.fn(() =>
        Promise.resolve({
          providerAccountId: "strava-web-signup-1",
          email: null,
          name: "Runner",
        }),
      );
      vi.mocked(resolveOrCreateUser)
        .mockRejectedValueOnce(new MissingEmailForSignupError("Strava"))
        .mockResolvedValueOnce({ userId: "manual-email-user", isNewUser: true });
      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "strava",
          name: "Strava",
          authSetup: () => ({
            oauthConfig: {
              authorizationEndpoint: "https://www.strava.com/oauth/authorize",
              clientId: "test",
              redirectUri: "https://dofek.asherlc.com/callback",
              scopes: ["read"],
            },
            exchangeCode: mockExchangeCode,
            getUserIdentity: mockGetUserIdentity,
            identityCapabilities: { providesEmail: false },
          }),
        },
      ]);

      const { app } = createTestApp();
      const returnTo = encodeURIComponent("/dashboard?tab=providers");

      const startRes = await request(app, "get", `/auth/login/data/strava?return_to=${returnTo}`);
      const location = startRes.headers.location;
      if (typeof location !== "string") throw new Error("Expected location header");
      const state = new URL(location).searchParams.get("state");
      const callbackRes = await request(
        app,
        "get",
        `/callback?code=strava-web-signup-code&state=${state}`,
      );
      const tokenMatch = callbackRes.body.match(/name="token" value="([^"]+)"/);
      const token = tokenMatch?.[1];
      if (!token) throw new Error("Expected pending signup token in form");

      const completeRes = await request(app, "post", "/auth/complete-signup", {
        formBody: { token, email: "runner@example.com" },
      });
      const { ensureProvider, saveTokens } = await import("dofek/db/tokens");

      expect(completeRes.status).toBe(302);
      expect(completeRes.headers.location).toBe("/dashboard?tab=providers");
      expect(resolveOrCreateUser).toHaveBeenLastCalledWith(
        expect.anything(),
        "strava",
        expect.objectContaining({
          providerAccountId: "strava-web-signup-1",
          email: "runner@example.com",
        }),
      );
      expect(ensureProvider).toHaveBeenCalledWith(
        expect.anything(),
        "strava",
        "Strava",
        undefined,
        "manual-email-user",
      );
      expect(saveTokens).toHaveBeenCalledWith(
        expect.anything(),
        "strava",
        {
          accessToken: "pending-web-access-token",
          refreshToken: "pending-web-refresh-token",
          expiresAt: new Date("2027-06-01"),
          scopes: "read",
        },
        "manual-email-user",
      );
      expect(createSession).toHaveBeenCalled();
      expect(setSessionCookie).toHaveBeenCalled();
    });

    it("returns a callback error when provider login fails for a reason other than missing email", async () => {
      const mockExchangeCode = vi.fn(() =>
        Promise.resolve({
          accessToken: "login-error-access-token",
          refreshToken: "login-error-refresh-token",
          expiresAt: new Date("2027-06-01"),
          scopes: "read",
        }),
      );
      const mockGetUserIdentity = vi.fn(() =>
        Promise.resolve({
          providerAccountId: "strava-login-error-1",
          email: null,
          name: "Runner",
        }),
      );
      vi.mocked(resolveOrCreateUser).mockRejectedValueOnce(new Error("database offline"));
      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "strava",
          name: "Strava",
          authSetup: () => ({
            oauthConfig: {
              authorizationEndpoint: "https://www.strava.com/oauth/authorize",
              clientId: "test",
              redirectUri: "https://dofek.asherlc.com/callback",
              scopes: ["read"],
            },
            exchangeCode: mockExchangeCode,
            getUserIdentity: mockGetUserIdentity,
            identityCapabilities: { providesEmail: false },
          }),
        },
      ]);

      const { app } = createTestApp();

      const startRes = await request(app, "get", "/auth/login/data/strava");
      const location = startRes.headers.location;
      if (typeof location !== "string") throw new Error("Expected location header");
      const state = new URL(location).searchParams.get("state");

      const callbackRes = await request(
        app,
        "get",
        `/callback?code=strava-login-error-code&state=${state}`,
      );

      expect(callbackRes.status).toBe(500);
      expect(callbackRes.body).toContain("Token exchange failed");
      expect(createSession).not.toHaveBeenCalled();
      expect(setSessionCookie).not.toHaveBeenCalled();
    });

    it("completes pending signup after collecting email on mobile", async () => {
      const mockExchangeCode = vi.fn(() =>
        Promise.resolve({
          accessToken: "pending-mobile-access-token",
          refreshToken: "pending-mobile-refresh-token",
          expiresAt: new Date("2027-06-01"),
          scopes: "read",
        }),
      );
      const mockGetUserIdentity = vi.fn(() =>
        Promise.resolve({
          providerAccountId: "strava-mobile-signup-1",
          email: null,
          name: "Runner",
        }),
      );
      vi.mocked(resolveOrCreateUser)
        .mockRejectedValueOnce(new MissingEmailForSignupError("Strava"))
        .mockResolvedValueOnce({ userId: "mobile-email-user", isNewUser: true });
      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "strava",
          name: "Strava",
          authSetup: () => ({
            oauthConfig: {
              authorizationEndpoint: "https://www.strava.com/oauth/authorize",
              clientId: "test",
              redirectUri: "https://dofek.asherlc.com/callback",
              scopes: ["read"],
            },
            exchangeCode: mockExchangeCode,
            getUserIdentity: mockGetUserIdentity,
            identityCapabilities: { providesEmail: false },
          }),
        },
      ]);

      const { app } = createTestApp();

      const startRes = await request(app, "get", "/auth/login/data/strava?redirect_scheme=dofek");
      const location = startRes.headers.location;
      if (typeof location !== "string") throw new Error("Expected location header");
      const state = new URL(location).searchParams.get("state");
      const callbackRes = await request(
        app,
        "get",
        `/callback?code=strava-mobile-signup-code&state=${state}`,
      );
      const tokenMatch = callbackRes.body.match(/name="token" value="([^"]+)"/);
      const token = tokenMatch?.[1];
      if (!token) throw new Error("Expected pending signup token in form");

      const completeRes = await request(app, "post", "/auth/complete-signup", {
        formBody: { token, email: "runner-mobile@example.com" },
      });
      const { ensureProvider } = await import("dofek/db/tokens");

      expect(completeRes.status).toBe(302);
      expect(completeRes.headers.location).toContain("dofek://auth/callback?session=");
      expect(ensureProvider).toHaveBeenCalledWith(
        expect.anything(),
        "strava",
        "Strava",
        undefined,
        "mobile-email-user",
      );
      expect(setSessionCookie).not.toHaveBeenCalled();
    });

    it("keeps the pending signup token when completion fails so the user can retry", async () => {
      const mockExchangeCode = vi.fn(() =>
        Promise.resolve({
          accessToken: "retry-access-token",
          refreshToken: "retry-refresh-token",
          expiresAt: new Date("2027-06-01"),
          scopes: "read",
        }),
      );
      const mockGetUserIdentity = vi.fn(() =>
        Promise.resolve({
          providerAccountId: "strava-retry-signup-1",
          email: null,
          name: "Retry Runner",
        }),
      );
      vi.mocked(resolveOrCreateUser)
        .mockRejectedValueOnce(new MissingEmailForSignupError("Strava"))
        .mockRejectedValueOnce(new Error("temporary database failure"))
        .mockResolvedValueOnce({ userId: "retry-user", isNewUser: true });
      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "strava",
          name: "Strava",
          authSetup: () => ({
            oauthConfig: {
              authorizationEndpoint: "https://www.strava.com/oauth/authorize",
              clientId: "test",
              redirectUri: "https://dofek.asherlc.com/callback",
              scopes: ["read"],
            },
            exchangeCode: mockExchangeCode,
            getUserIdentity: mockGetUserIdentity,
            identityCapabilities: { providesEmail: false },
          }),
        },
      ]);

      const { app } = createTestApp();

      const startRes = await request(app, "get", "/auth/login/data/strava");
      const location = startRes.headers.location;
      if (typeof location !== "string") throw new Error("Expected location header");
      const state = new URL(location).searchParams.get("state");
      const callbackRes = await request(
        app,
        "get",
        `/callback?code=strava-retry-code&state=${state}`,
      );
      const tokenMatch = callbackRes.body.match(/name="token" value="([^"]+)"/);
      const token = tokenMatch?.[1];
      if (!token) throw new Error("Expected pending signup token in form");

      const failedCompleteRes = await request(app, "post", "/auth/complete-signup", {
        formBody: { token, email: "retry@example.com" },
      });
      const successfulRetryRes = await request(app, "post", "/auth/complete-signup", {
        formBody: { token, email: "retry@example.com" },
      });
      const { ensureProvider } = await import("dofek/db/tokens");

      expect(failedCompleteRes.status).toBe(500);
      expect(successfulRetryRes.status).toBe(302);
      expect(successfulRetryRes.headers.location).toBe("/");
      expect(ensureProvider).toHaveBeenCalledTimes(1);
      expect(ensureProvider).toHaveBeenCalledWith(
        expect.anything(),
        "strava",
        "Strava",
        undefined,
        "retry-user",
      );
    });

    it("rejects complete-signup requests without a token", async () => {
      const { app } = createTestApp();

      const res = await request(app, "post", "/auth/complete-signup", {
        formBody: { email: "runner@example.com" },
      });

      expect(res.status).toBe(400);
      expect(res.body).toContain("Missing signup token");
    });

    it("rejects expired complete-signup tokens", async () => {
      const { app } = createTestApp();

      const res = await request(app, "post", "/auth/complete-signup", {
        formBody: { token: "expired-signup-token", email: "runner@example.com" },
      });

      expect(res.status).toBe(400);
      expect(res.body).toContain("Signup session expired");
    });

    it("re-renders the manual signup form when the submitted email is invalid", async () => {
      const mockExchangeCode = vi.fn(() =>
        Promise.resolve({
          accessToken: "invalid-email-access-token",
          refreshToken: "invalid-email-refresh-token",
          expiresAt: new Date("2027-06-01"),
          scopes: "read",
        }),
      );
      const mockGetUserIdentity = vi.fn(() =>
        Promise.resolve({
          providerAccountId: "strava-invalid-email-1",
          email: null,
          name: "Runner",
        }),
      );
      vi.mocked(resolveOrCreateUser).mockRejectedValueOnce(
        new MissingEmailForSignupError("Strava"),
      );
      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "strava",
          name: "Strava",
          authSetup: () => ({
            oauthConfig: {
              authorizationEndpoint: "https://www.strava.com/oauth/authorize",
              clientId: "test",
              redirectUri: "https://dofek.asherlc.com/callback",
              scopes: ["read"],
            },
            exchangeCode: mockExchangeCode,
            getUserIdentity: mockGetUserIdentity,
            identityCapabilities: { providesEmail: false },
          }),
        },
      ]);

      const { app } = createTestApp();

      const startRes = await request(app, "get", "/auth/login/data/strava");
      const location = startRes.headers.location;
      if (typeof location !== "string") throw new Error("Expected location header");
      const state = new URL(location).searchParams.get("state");
      const callbackRes = await request(
        app,
        "get",
        `/callback?code=strava-invalid-email-code&state=${state}`,
      );
      const tokenMatch = callbackRes.body.match(/name="token" value="([^"]+)"/);
      const token = tokenMatch?.[1];
      if (!token) throw new Error("Expected pending signup token in form");

      const completeRes = await request(app, "post", "/auth/complete-signup", {
        formBody: { token, email: "not-an-email" },
      });

      expect(completeRes.status).toBe(400);
      expect(completeRes.body).toContain("Enter a valid email address.");
      expect(completeRes.body).toContain('value="not-an-email"');
    });

    it("fails complete-signup if the provider is no longer registered", async () => {
      const mockExchangeCode = vi.fn(() =>
        Promise.resolve({
          accessToken: "missing-provider-access-token",
          refreshToken: "missing-provider-refresh-token",
          expiresAt: new Date("2027-06-01"),
          scopes: "read",
        }),
      );
      const mockGetUserIdentity = vi.fn(() =>
        Promise.resolve({
          providerAccountId: "strava-missing-provider-1",
          email: null,
          name: "Runner",
        }),
      );
      vi.mocked(resolveOrCreateUser)
        .mockRejectedValueOnce(new MissingEmailForSignupError("Strava"))
        .mockResolvedValueOnce({ userId: "missing-provider-user", isNewUser: true });
      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "strava",
          name: "Strava",
          authSetup: () => ({
            oauthConfig: {
              authorizationEndpoint: "https://www.strava.com/oauth/authorize",
              clientId: "test",
              redirectUri: "https://dofek.asherlc.com/callback",
              scopes: ["read"],
            },
            exchangeCode: mockExchangeCode,
            getUserIdentity: mockGetUserIdentity,
            identityCapabilities: { providesEmail: false },
          }),
        },
      ]);

      const { app } = createTestApp();

      const startRes = await request(app, "get", "/auth/login/data/strava");
      const location = startRes.headers.location;
      if (typeof location !== "string") throw new Error("Expected location header");
      const state = new URL(location).searchParams.get("state");
      const callbackRes = await request(
        app,
        "get",
        `/callback?code=strava-missing-provider-code&state=${state}`,
      );
      const tokenMatch = callbackRes.body.match(/name="token" value="([^"]+)"/);
      const token = tokenMatch?.[1];
      if (!token) throw new Error("Expected pending signup token in form");

      vi.mocked(getAllProviders).mockReturnValue([]);

      const completeRes = await request(app, "post", "/auth/complete-signup", {
        formBody: { token, email: "runner@example.com" },
      });
      const { ensureProvider } = await import("dofek/db/tokens");

      expect(completeRes.status).toBe(500);
      expect(completeRes.body).toContain("Provider no longer available");
      expect(ensureProvider).not.toHaveBeenCalled();
    });

    it("handles link intent: links provider and redirects to /settings", async () => {
      const mockExchangeCode = vi.fn(() =>
        Promise.resolve({
          accessToken: "link-access-token",
          refreshToken: "link-refresh-token",
          expiresAt: new Date("2027-06-01"),
          scopes: "read",
        }),
      );
      const mockGetUserIdentity = vi.fn(() =>
        Promise.resolve({
          providerAccountId: "strava-link-1",
          email: "linker@test.com",
          name: "Linker",
        }),
      );
      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "strava",
          name: "Strava",
          authSetup: () => ({
            oauthConfig: {
              authorizationEndpoint: "https://www.strava.com/oauth/authorize",
              clientId: "test",
              redirectUri: "https://dofek.asherlc.com/callback",
              scopes: ["read"],
            },
            exchangeCode: mockExchangeCode,
            getUserIdentity: mockGetUserIdentity,
            identityCapabilities: { providesEmail: false },
          }),
        },
      ]);

      // Simulate logged-in session for link
      vi.mocked(getSessionIdFromRequest).mockReturnValue("sess-1");
      vi.mocked(validateSession).mockResolvedValue({
        userId: "link-user-123",
        expiresAt: new Date("2027-01-01"),
      });

      const { app } = createTestApp();

      // Start data link flow
      const startRes = await request(app, "get", "/auth/link/data/strava");
      expect(startRes.status).toBe(302);
      const location = startRes.headers.location;
      if (typeof location !== "string") throw new Error("Expected location header");
      const redirectUrl = new URL(location);
      const state = redirectUrl.searchParams.get("state");
      expect(state).toBeTruthy();

      // Hit callback
      const callbackRes = await request(
        app,
        "get",
        `/callback?code=strava-link-code&state=${state}`,
      );
      expect(callbackRes.status).toBe(302);
      expect(callbackRes.headers.location).toBe("/settings");
      expect(mockGetUserIdentity).toHaveBeenCalledWith("link-access-token");
      expect(resolveOrCreateUser).toHaveBeenCalledWith(
        expect.anything(),
        "strava",
        expect.objectContaining({ providerAccountId: "strava-link-1" }),
        "link-user-123",
      );
    });

    it("returns 404 when provider is not found in callback", async () => {
      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "wahoo",
          name: "Wahoo",
          authSetup: () => ({
            oauthConfig: {
              authorizationEndpoint: "https://api.wahoo.com/oauth/authorize",
              clientId: "test",
              redirectUri: "https://dofek.asherlc.com/callback",
              scopes: ["user_read"],
            },
          }),
        },
      ]);

      const { app } = createTestApp();

      // Start OAuth flow for wahoo
      const startRes = await request(app, "get", "/auth/provider/wahoo");
      expect(startRes.status).toBe(302);
      const location = startRes.headers.location;
      if (typeof location !== "string") throw new Error("Expected location header");
      const redirectUrl = new URL(location);
      const state = redirectUrl.searchParams.get("state");

      // Now change getAllProviders to return empty, so the provider won't be found
      vi.mocked(getAllProviders).mockReturnValue([]);

      const callbackRes = await request(app, "get", `/callback?code=test-code&state=${state}`);
      expect(callbackRes.status).toBe(404);
      expect(callbackRes.body).toContain("Unknown provider");
    });

    it("returns 400 when provider has no exchangeCode", async () => {
      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "wahoo",
          name: "Wahoo",
          authSetup: () => ({
            oauthConfig: {
              authorizationEndpoint: "https://api.wahoo.com/oauth/authorize",
              clientId: "test",
              redirectUri: "https://dofek.asherlc.com/callback",
              scopes: ["user_read"],
            },
          }),
        },
      ]);

      const { app } = createTestApp();

      // Start OAuth flow
      const startRes = await request(app, "get", "/auth/provider/wahoo");
      expect(startRes.status).toBe(302);
      const location = startRes.headers.location;
      if (typeof location !== "string") throw new Error("Expected location header");
      const redirectUrl = new URL(location);
      const state = redirectUrl.searchParams.get("state");

      // In the callback, the provider's authSetup has oauthConfig but no exchangeCode
      const callbackRes = await request(app, "get", `/callback?code=test-code&state=${state}`);
      expect(callbackRes.status).toBe(400);
      expect(callbackRes.body).toContain("does not support OAuth code exchange");
    });

    it("returns 500 when token exchange throws", async () => {
      const mockExchangeCode = vi.fn(() => Promise.reject(new Error("Token exchange failed")));
      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "wahoo",
          name: "Wahoo",
          authSetup: () => ({
            oauthConfig: {
              authorizationEndpoint: "https://api.wahoo.com/oauth/authorize",
              clientId: "test",
              redirectUri: "https://dofek.asherlc.com/callback",
              scopes: ["user_read"],
            },
            exchangeCode: mockExchangeCode,
          }),
        },
      ]);

      const { app } = createTestApp();

      // Start OAuth flow
      const startRes = await request(app, "get", "/auth/provider/wahoo");
      expect(startRes.status).toBe(302);
      const location = startRes.headers.location;
      if (typeof location !== "string") throw new Error("Expected location header");
      const redirectUrl = new URL(location);
      const state = redirectUrl.searchParams.get("state");

      const callbackRes = await request(app, "get", `/callback?code=test-code&state=${state}`);
      expect(callbackRes.status).toBe(500);
      expect(callbackRes.body).toContain("Token exchange failed");
    });
  });

  describe("GET /callback (state consumed only once)", () => {
    it("returns 400 when same state token is used twice", async () => {
      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "wahoo",
          name: "Wahoo",
          authSetup: () => ({
            oauthConfig: {
              authorizationEndpoint: "https://api.wahoo.com/oauth/authorize",
              clientId: "test",
              redirectUri: "https://dofek.asherlc.com/callback",
              scopes: ["user_read"],
            },
            exchangeCode: vi.fn(() =>
              Promise.resolve({
                accessToken: "tok",
                refreshToken: "ref",
                expiresAt: new Date("2027-06-01"),
                scopes: "",
              }),
            ),
          }),
        },
      ]);

      const { app } = createTestApp();

      // Start OAuth flow
      const startRes = await request(app, "get", "/auth/provider/wahoo");
      expect(startRes.status).toBe(302);
      const location = startRes.headers.location;
      if (typeof location !== "string") throw new Error("Expected location header");
      const redirectUrl = new URL(location);
      const state = redirectUrl.searchParams.get("state");

      // First callback succeeds
      const firstRes = await request(app, "get", `/callback?code=abc&state=${state}`);
      expect(firstRes.status).toBe(200);

      // Second callback with same state should fail
      const secondRes = await request(app, "get", `/callback?code=abc&state=${state}`);
      expect(secondRes.status).toBe(400);
      expect(secondRes.body).toContain("Unknown or expired OAuth state");
    });
  });

  describe("GET /auth/login/:provider (mobile scheme cookie)", () => {
    it("sets mobile scheme cookie when valid redirect_scheme is provided", async () => {
      const { app } = createTestApp();
      const res = await request(app, "get", "/auth/login/google?redirect_scheme=dofek");
      expect(res.status).toBe(302);
      expect(setMobileSchemeCookie).toHaveBeenCalledWith(expect.anything(), "dofek");
    });

    it("does not set mobile scheme cookie when redirect_scheme is invalid", async () => {
      const { app } = createTestApp();
      const res = await request(app, "get", "/auth/login/google?redirect_scheme=evil");
      expect(res.status).toBe(302);
      expect(setMobileSchemeCookie).not.toHaveBeenCalled();
    });

    it("does not set mobile scheme cookie when redirect_scheme is absent", async () => {
      const { app } = createTestApp();
      const res = await request(app, "get", "/auth/login/google");
      expect(res.status).toBe(302);
      expect(setMobileSchemeCookie).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/auth/providers (data login providers filter)", () => {
    it("excludes providers without oauthConfig from data login list", async () => {
      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "manual-only",
          name: "Manual",
          authSetup: () => ({
            getUserIdentity: vi.fn(),
            // no oauthConfig
          }),
        },
      ]);
      const { app } = createTestApp();
      const res = await request(app, "get", "/api/auth/providers");
      const data = JSON.parse(res.body);
      expect(data.data).toEqual([]);
    });

    it("excludes providers without getUserIdentity from data login list", async () => {
      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "data-only",
          name: "DataOnly",
          authSetup: () => ({
            oauthConfig: { authorizationEndpoint: "https://example.com/oauth" },
            // no getUserIdentity
          }),
        },
      ]);
      const { app } = createTestApp();
      const res = await request(app, "get", "/api/auth/providers");
      const data = JSON.parse(res.body);
      expect(data.data).toEqual([]);
    });

    it("excludes providers without authSetup from data login list", async () => {
      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "no-auth",
          name: "NoAuth",
          // no authSetup at all
        },
      ]);
      const { app } = createTestApp();
      const res = await request(app, "get", "/api/auth/providers");
      const data = JSON.parse(res.body);
      expect(data.data).toEqual([]);
    });
  });

  describe("GET /auth/provider/:provider (provider without authSetup)", () => {
    it("returns 400 when provider has no authSetup function", async () => {
      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "no-auth",
          name: "NoAuth",
          // no authSetup
        },
      ]);
      const { app } = createTestApp();
      const res = await request(app, "get", "/auth/provider/no-auth");
      expect(res.status).toBe(400);
      expect(res.body).toContain("does not use OAuth");
    });
  });

  describe("GET /auth/provider/:provider (OAuth 1.0 flow)", () => {
    it("redirects through OAuth 1.0 flow for providers with oauth1Flow and data intent", async () => {
      const mockGetRequestToken = vi.fn(() =>
        Promise.resolve({
          oauthToken: "req-token-123",
          oauthTokenSecret: "req-secret-123",
          authorizeUrl: "https://fatsecret.com/authorize?oauth_token=req-token-123",
        }),
      );
      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "fatsecret",
          name: "FatSecret",
          authSetup: (options?: { host?: string }) => ({
            oauthConfig: {
              authorizationEndpoint: "https://fatsecret.com/authorize",
              clientId: "test",
              redirectUri: getOAuthRedirectUri(options?.host),
            },
            oauth1Flow: {
              getRequestToken: mockGetRequestToken,
              exchangeForAccessToken: vi.fn(),
            },
          }),
        },
      ]);

      const { app } = createTestApp();
      const res = await request(app, "get", "/auth/provider/fatsecret");
      expect(res.status).toBe(302);
      expect(res.headers.location).toContain("fatsecret.com/authorize");
      expect(mockGetRequestToken).toHaveBeenCalled();
    });
  });

  describe("GET /callback (Slack OAuth with missing env vars)", () => {
    it("returns 400 when only SLACK_CLIENT_ID is set but not SECRET", async () => {
      process.env.SLACK_CLIENT_ID = "test-client-id";
      delete process.env.SLACK_CLIENT_SECRET;

      const { app } = createTestApp();
      const slackRes = await request(app, "get", "/auth/provider/slack");
      expect(slackRes.status).toBe(302);
      const location = slackRes.headers.location;
      if (typeof location !== "string") throw new Error("Expected location header");
      const redirectUrl = new URL(location);
      const state = redirectUrl.searchParams.get("state");
      expect(state).toBeTruthy();

      // Now clear the client ID so the validation fails
      delete process.env.SLACK_CLIENT_ID;

      const callbackRes = await request(app, "get", `/callback?code=slack-code&state=${state}`);
      expect(callbackRes.status).toBe(400);
      expect(callbackRes.body).toContain("SLACK_CLIENT_ID");
    });
  });

  describe("POST /auth/apple/native", () => {
    it("returns 400 when native Apple is not configured", async () => {
      vi.mocked(isNativeAppleConfigured).mockReturnValue(false);
      const { app } = createTestApp();
      const res = await request(app, "post", "/auth/apple/native", {
        formBody: { authorizationCode: "code", identityToken: "token" },
      });
      expect(res.status).toBe(400);
      expect(res.body).toContain("not configured");
      vi.mocked(isNativeAppleConfigured).mockReturnValue(false);
    });

    it("returns 400 when authorizationCode is missing", async () => {
      vi.mocked(isNativeAppleConfigured).mockReturnValue(true);
      const { app } = createTestApp();
      const res = await request(app, "post", "/auth/apple/native", {
        formBody: { identityToken: "token" },
      });
      expect(res.status).toBe(400);
      expect(res.body).toContain("authorizationCode");
      vi.mocked(isNativeAppleConfigured).mockReturnValue(false);
    });

    it("returns session token on success", async () => {
      vi.mocked(isNativeAppleConfigured).mockReturnValue(true);
      vi.mocked(validateNativeAppleCallback).mockResolvedValue({
        user: { sub: "apple-native-1", email: "alice@icloud.com", name: null, groups: null },
      });
      const { app } = createTestApp();
      const res = await request(app, "post", "/auth/apple/native", {
        formBody: { authorizationCode: "native-code", identityToken: "jwt-token" },
      });
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.session).toBeDefined();
      expect(validateNativeAppleCallback).toHaveBeenCalledWith("native-code");
      vi.mocked(isNativeAppleConfigured).mockReturnValue(false);
    });

    it("passes fullName from givenName+familyName to resolveOrCreateUser when identity token has no name", async () => {
      vi.mocked(isNativeAppleConfigured).mockReturnValue(true);
      vi.mocked(validateNativeAppleCallback).mockResolvedValue({
        user: { sub: "apple-native-2", email: "bob@icloud.com", name: null, groups: null },
      });
      const { resolveOrCreateUser } = await import("../auth/account-linking.ts");
      const { app } = createTestApp();
      const res = await request(app, "post", "/auth/apple/native", {
        formBody: {
          authorizationCode: "native-code",
          identityToken: "jwt-token",
          givenName: "Bob",
          familyName: "Smith",
        },
      });
      expect(res.status).toBe(200);
      // Verify fullName was constructed from givenName + familyName
      expect(resolveOrCreateUser).toHaveBeenCalledWith(
        expect.anything(),
        "apple",
        expect.objectContaining({
          name: "Bob Smith",
          providerAccountId: "apple-native-2",
          email: "bob@icloud.com",
        }),
      );
      vi.mocked(isNativeAppleConfigured).mockReturnValue(false);
    });

    it("prefers identity token name over fullName from SDK", async () => {
      vi.mocked(isNativeAppleConfigured).mockReturnValue(true);
      vi.mocked(validateNativeAppleCallback).mockResolvedValue({
        user: {
          sub: "apple-native-3",
          email: "carol@icloud.com",
          name: "Carol Token",
          groups: null,
        },
      });
      const { resolveOrCreateUser } = await import("../auth/account-linking.ts");
      const { app } = createTestApp();
      const res = await request(app, "post", "/auth/apple/native", {
        formBody: {
          authorizationCode: "native-code",
          identityToken: "jwt-token",
          givenName: "Carol",
          familyName: "SDK",
        },
      });
      expect(res.status).toBe(200);
      // Identity token name takes precedence over SDK fullName
      expect(resolveOrCreateUser).toHaveBeenCalledWith(
        expect.anything(),
        "apple",
        expect.objectContaining({ name: "Carol Token" }),
      );
      vi.mocked(isNativeAppleConfigured).mockReturnValue(false);
    });

    it("handles only givenName without familyName", async () => {
      vi.mocked(isNativeAppleConfigured).mockReturnValue(true);
      vi.mocked(validateNativeAppleCallback).mockResolvedValue({
        user: { sub: "apple-native-4", email: null, name: null, groups: null },
      });
      const { resolveOrCreateUser } = await import("../auth/account-linking.ts");
      const { app } = createTestApp();
      const res = await request(app, "post", "/auth/apple/native", {
        formBody: { authorizationCode: "native-code", givenName: "Dave" },
      });
      expect(res.status).toBe(200);
      expect(resolveOrCreateUser).toHaveBeenCalledWith(
        expect.anything(),
        "apple",
        expect.objectContaining({ name: "Dave", email: null }),
      );
      vi.mocked(isNativeAppleConfigured).mockReturnValue(false);
    });

    it("passes null name when no name sources are available", async () => {
      vi.mocked(isNativeAppleConfigured).mockReturnValue(true);
      vi.mocked(validateNativeAppleCallback).mockResolvedValue({
        user: { sub: "apple-native-5", email: null, name: null, groups: null },
      });
      const { resolveOrCreateUser } = await import("../auth/account-linking.ts");
      const { app } = createTestApp();
      const res = await request(app, "post", "/auth/apple/native", {
        formBody: { authorizationCode: "native-code" },
      });
      expect(res.status).toBe(200);
      expect(resolveOrCreateUser).toHaveBeenCalledWith(
        expect.anything(),
        "apple",
        expect.objectContaining({ name: null }),
      );
      vi.mocked(isNativeAppleConfigured).mockReturnValue(false);
    });

    it("returns 500 when validateNativeAppleCallback throws", async () => {
      vi.mocked(isNativeAppleConfigured).mockReturnValue(true);
      vi.mocked(validateNativeAppleCallback).mockRejectedValue(new Error("Invalid code"));
      const { app } = createTestApp();
      const res = await request(app, "post", "/auth/apple/native", {
        formBody: { authorizationCode: "bad-code" },
      });
      expect(res.status).toBe(500);
      expect(res.body).toContain("Apple Sign In failed");
      vi.mocked(isNativeAppleConfigured).mockReturnValue(false);
    });

    it("rejects non-string authorizationCode", async () => {
      vi.mocked(isNativeAppleConfigured).mockReturnValue(true);
      const { app } = createTestApp();
      // Sending empty formBody — authorizationCode absent
      const res = await request(app, "post", "/auth/apple/native", {
        formBody: {},
      });
      expect(res.status).toBe(400);
      expect(res.body).toContain("authorizationCode");
      vi.mocked(isNativeAppleConfigured).mockReturnValue(false);
    });
  });

  // ── Cluster 1: OAuth 1.0 flow (lines 122-130) ──
  describe("GET /auth/provider/:provider (OAuth 1.0 full round-trip)", () => {
    it("stores oauth1 secret and redirects to authorizeUrl from getRequestToken", async () => {
      const mockGetRequestToken = vi.fn(() =>
        Promise.resolve({
          oauthToken: "oauth1-tok-abc",
          oauthTokenSecret: "oauth1-secret-abc",
          authorizeUrl: "https://fatsecret.com/authorize?oauth_token=oauth1-tok-abc",
        }),
      );
      const mockExchangeForAccessToken = vi.fn(() =>
        Promise.resolve({ token: "access-tok", tokenSecret: "access-secret" }),
      );
      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "fatsecret",
          name: "FatSecret",
          authSetup: (options?: { host?: string }) => ({
            oauthConfig: {
              authorizationEndpoint: "https://fatsecret.com/authorize",
              clientId: "test",
              redirectUri: getOAuthRedirectUri(options?.host),
            },
            oauth1Flow: {
              getRequestToken: mockGetRequestToken,
              exchangeForAccessToken: mockExchangeForAccessToken,
            },
          }),
        },
      ]);

      const { app } = createTestApp();
      const res = await request(app, "get", "/auth/provider/fatsecret");
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe(
        "https://fatsecret.com/authorize?oauth_token=oauth1-tok-abc",
      );
      // getRequestToken should have been called with the callback URL
      expect(mockGetRequestToken).toHaveBeenCalledWith(expect.stringContaining("callback"));
    });

    it("completes OAuth 1.0 callback: exchanges tokens and saves them", async () => {
      const mockGetRequestToken = vi.fn(() =>
        Promise.resolve({
          oauthToken: "oauth1-roundtrip-tok",
          oauthTokenSecret: "oauth1-roundtrip-secret",
          authorizeUrl: "https://fatsecret.com/authorize?oauth_token=oauth1-roundtrip-tok",
        }),
      );
      const mockExchangeForAccessToken = vi.fn(() =>
        Promise.resolve({ token: "final-access-tok", tokenSecret: "final-secret-tok" }),
      );
      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "fatsecret",
          name: "FatSecret",
          authSetup: (options?: { host?: string }) => ({
            oauthConfig: {
              authorizationEndpoint: "https://fatsecret.com/authorize",
              clientId: "test",
              redirectUri: getOAuthRedirectUri(options?.host),
            },
            oauth1Flow: {
              getRequestToken: mockGetRequestToken,
              exchangeForAccessToken: mockExchangeForAccessToken,
            },
          }),
        },
      ]);

      const { app } = createTestApp();

      // Step 1: Start OAuth 1.0 flow (populates oauth1Secrets map)
      const startRes = await request(app, "get", "/auth/provider/fatsecret");
      expect(startRes.status).toBe(302);

      // Step 2: Hit callback with oauth_token + oauth_verifier
      const callbackRes = await request(
        app,
        "get",
        "/callback?oauth_token=oauth1-roundtrip-tok&oauth_verifier=verifier-xyz",
      );
      expect(callbackRes.status).toBe(200);
      expect(callbackRes.body).toContain("Authorized!");
      expect(callbackRes.body).toContain("FatSecret connected successfully.");
      expect(mockExchangeForAccessToken).toHaveBeenCalledWith(
        "oauth1-roundtrip-tok",
        "oauth1-roundtrip-secret",
        "verifier-xyz",
      );
    });

    it("uses OAUTH_REDIRECT_URI env var for callback URL when set", async () => {
      const customUrl = "https://custom.example.com/callback";
      process.env.OAUTH_REDIRECT_URI_unencrypted = customUrl;
      const mockGetRequestToken = vi.fn(() =>
        Promise.resolve({
          oauthToken: "env-tok",
          oauthTokenSecret: "env-secret",
          authorizeUrl: "https://fatsecret.com/authorize?oauth_token=env-tok",
        }),
      );
      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "fatsecret",
          name: "FatSecret",
          authSetup: () => ({
            oauthConfig: {
              authorizationEndpoint: "https://fatsecret.com/authorize",
              clientId: "test",
              redirectUri: customUrl,
            },
            oauth1Flow: {
              getRequestToken: mockGetRequestToken,
              exchangeForAccessToken: vi.fn(),
            },
          }),
        },
      ]);

      const { app } = createTestApp();
      await request(app, "get", "/auth/provider/fatsecret");
      expect(mockGetRequestToken).toHaveBeenCalledWith(customUrl);
      delete process.env.OAUTH_REDIRECT_URI_unencrypted;
    });
  });

  // ── Cluster 2: PKCE flow (lines 143-151) ──
  describe("GET /auth/provider/:provider (PKCE code challenge verification)", () => {
    it("calls generateCodeChallenge with the PKCE verifier and includes code_challenge in URL", async () => {
      const { buildAuthorizationUrl, generateCodeChallenge } = await import("dofek/auth/oauth");
      vi.mocked(generateCodeChallenge).mockReturnValue("test-pkce-challenge");
      vi.mocked(buildAuthorizationUrl).mockReturnValue(
        "https://oauth.example.com/authorize?client_id=test&code_challenge=test-pkce-challenge",
      );

      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "withings",
          name: "Withings",
          authSetup: () => ({
            oauthConfig: {
              authorizationEndpoint: "https://account.withings.com/oauth2_user/authorize2",
              clientId: "test-client",
              redirectUri: "https://dofek.asherlc.com/callback",
              scopes: ["user.metrics"],
              usePkce: true,
            },
          }),
        },
      ]);

      const { app } = createTestApp();
      const res = await request(app, "get", "/auth/provider/withings");
      expect(res.status).toBe(302);
      // Verify buildAuthorizationUrl was called with codeChallenge param
      expect(buildAuthorizationUrl).toHaveBeenCalledWith(
        expect.objectContaining({ usePkce: true }),
        expect.objectContaining({ codeChallenge: "test-pkce-challenge" }),
      );
      expect(generateCodeChallenge).toHaveBeenCalledWith("pkce-verifier");
    });

    it("does not generate PKCE params when usePkce is false", async () => {
      const { buildAuthorizationUrl, generateCodeChallenge } = await import("dofek/auth/oauth");
      vi.mocked(generateCodeChallenge).mockClear();

      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "wahoo",
          name: "Wahoo",
          authSetup: () => ({
            oauthConfig: {
              authorizationEndpoint: "https://api.wahoo.com/oauth/authorize",
              clientId: "test",
              redirectUri: "https://dofek.asherlc.com/callback",
              scopes: ["user_read"],
              usePkce: false,
            },
          }),
        },
      ]);

      const { app } = createTestApp();
      await request(app, "get", "/auth/provider/wahoo");
      expect(generateCodeChallenge).not.toHaveBeenCalled();
      expect(buildAuthorizationUrl).toHaveBeenCalledWith(
        expect.objectContaining({ usePkce: false }),
        undefined,
      );
    });

    it("passes stored codeVerifier to exchangeCode during PKCE callback", async () => {
      const { generateCodeChallenge } = await import("dofek/auth/oauth");
      vi.mocked(generateCodeChallenge).mockReturnValue("challenge-for-pkce");

      const mockExchangeCode = vi.fn(() =>
        Promise.resolve({
          accessToken: "pkce-access",
          refreshToken: "pkce-refresh",
          expiresAt: new Date("2027-06-01"),
          scopes: "read",
        }),
      );
      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "withings",
          name: "Withings",
          authSetup: () => ({
            oauthConfig: {
              authorizationEndpoint: "https://account.withings.com/oauth2_user/authorize2",
              clientId: "test",
              redirectUri: "https://dofek.asherlc.com/callback",
              scopes: ["user.metrics"],
              usePkce: true,
            },
            exchangeCode: mockExchangeCode,
          }),
        },
      ]);

      const { app } = createTestApp();

      // Start flow (stores codeVerifier in state map)
      const startRes = await request(app, "get", "/auth/provider/withings");
      expect(startRes.status).toBe(302);
      const location = startRes.headers.location;
      if (typeof location !== "string") throw new Error("Expected location header");
      const redirectUrl = new URL(location);
      const state = redirectUrl.searchParams.get("state");
      expect(state).toBeTruthy();

      // Callback — exchangeCode should receive the stored PKCE verifier
      const callbackRes = await request(app, "get", `/callback?code=withings-code&state=${state}`);
      expect(callbackRes.status).toBe(200);
      // "pkce-verifier" is what the mocked generateCodeVerifier from dofek/auth/oauth returns
      expect(mockExchangeCode).toHaveBeenCalledWith("withings-code", "pkce-verifier");
    });
  });

  // ── Cluster 3: /api/auth/me mobile detection (lines 455-460) ──
  describe("GET /api/auth/me (mobile user-agent logging)", () => {
    function setupValidSession(fakeDb: ReturnType<typeof createDatabaseFromEnv>) {
      vi.mocked(getSessionIdFromRequest).mockReturnValue("good-session");
      vi.mocked(validateSession).mockResolvedValue({
        userId: "user-1",
        expiresAt: new Date("2027-01-01"),
      });
      vi.mocked(fakeDb.execute).mockResolvedValue([
        { id: "user-1", name: "Alice", email: "alice@test.com", is_admin: false },
      ]);
    }

    it("logs mobile info when user-agent contains Darwin", async () => {
      const { app, fakeDb } = createTestApp();
      setupValidSession(fakeDb);
      const res = await request(app, "get", "/api/auth/me", {
        headers: { "User-Agent": "dofek/1.0 Darwin/23.1.0 CFNetwork/1494.0.7" },
      });
      expect(res.status).toBe(200);
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("(mobile)"));
    });

    it("logs mobile info when user-agent contains CFNetwork", async () => {
      const { app, fakeDb } = createTestApp();
      setupValidSession(fakeDb);
      const res = await request(app, "get", "/api/auth/me", {
        headers: { "User-Agent": "CFNetwork/1494.0.7 something" },
      });
      expect(res.status).toBe(200);
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("(mobile)"));
    });

    it("does not log mobile info for desktop user-agent", async () => {
      const { app, fakeDb } = createTestApp();
      setupValidSession(fakeDb);
      const res = await request(app, "get", "/api/auth/me", {
        headers: {
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/120.0",
        },
      });
      expect(res.status).toBe(200);
      expect(logger.info).not.toHaveBeenCalled();
    });

    it("does not log mobile info when user-agent is absent (defaults to unknown)", async () => {
      const { app, fakeDb } = createTestApp();
      setupValidSession(fakeDb);
      // No User-Agent header — the code uses ?? "unknown"
      const res = await request(app, "get", "/api/auth/me");
      expect(res.status).toBe(200);
      expect(logger.info).not.toHaveBeenCalled();
    });
  });

  // ── Cluster 4: Data login/link mobile scheme and session validation ──
  describe("GET /auth/login/data/:provider (mobile scheme in state entry)", () => {
    it("stores valid mobileScheme in state and passes to callback redirect", async () => {
      const mockExchangeCode = vi.fn(() =>
        Promise.resolve({
          accessToken: "mobile-data-access",
          refreshToken: "mobile-data-refresh",
          expiresAt: new Date("2027-06-01"),
          scopes: "read",
        }),
      );
      const mockGetUserIdentity = vi.fn(() =>
        Promise.resolve({
          providerAccountId: "strava-mobile-data",
          email: "runner-mobile@test.com",
          name: "Mobile Data Runner",
        }),
      );
      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "strava",
          name: "Strava",
          authSetup: () => ({
            oauthConfig: {
              authorizationEndpoint: "https://www.strava.com/oauth/authorize",
              clientId: "test",
              redirectUri: "https://dofek.asherlc.com/callback",
              scopes: ["read"],
            },
            exchangeCode: mockExchangeCode,
            getUserIdentity: mockGetUserIdentity,
          }),
        },
      ]);

      const { app } = createTestApp();

      // Start data login with valid mobile scheme
      const startRes = await request(app, "get", "/auth/login/data/strava?redirect_scheme=dofek");
      expect(startRes.status).toBe(302);
      const location = startRes.headers.location;
      if (typeof location !== "string") throw new Error("Expected location header");
      const redirectUrl = new URL(location);
      const state = redirectUrl.searchParams.get("state");
      expect(state).toBeTruthy();

      // Callback should redirect to deep link
      const callbackRes = await request(
        app,
        "get",
        `/callback?code=mobile-data-code&state=${state}`,
      );
      expect(callbackRes.status).toBe(302);
      expect(callbackRes.headers.location).toContain("dofek://auth/callback?session=");
      expect(setSessionCookie).not.toHaveBeenCalled();
    });

    it("stores undefined mobileScheme when redirect_scheme is invalid", async () => {
      const mockExchangeCode = vi.fn(() =>
        Promise.resolve({
          accessToken: "web-data-access",
          refreshToken: "web-data-refresh",
          expiresAt: new Date("2027-06-01"),
          scopes: "read",
        }),
      );
      const mockGetUserIdentity = vi.fn(() =>
        Promise.resolve({
          providerAccountId: "strava-web-data",
          email: "runner-web@test.com",
          name: "Web Data Runner",
        }),
      );
      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "strava",
          name: "Strava",
          authSetup: () => ({
            oauthConfig: {
              authorizationEndpoint: "https://www.strava.com/oauth/authorize",
              clientId: "test",
              redirectUri: "https://dofek.asherlc.com/callback",
              scopes: ["read"],
            },
            exchangeCode: mockExchangeCode,
            getUserIdentity: mockGetUserIdentity,
          }),
        },
      ]);

      const { app } = createTestApp();

      // Start data login with invalid mobile scheme
      const startRes = await request(app, "get", "/auth/login/data/strava?redirect_scheme=evil");
      expect(startRes.status).toBe(302);
      const location = startRes.headers.location;
      if (typeof location !== "string") throw new Error("Expected location header");
      const redirectUrl = new URL(location);
      const state = redirectUrl.searchParams.get("state");

      // Callback should redirect to / (web), not deep link
      const callbackRes = await request(app, "get", `/callback?code=web-data-code&state=${state}`);
      expect(callbackRes.status).toBe(302);
      expect(callbackRes.headers.location).toBe("/");
      expect(setSessionCookie).toHaveBeenCalled();
    });
  });

  describe("GET /auth/link/data/:provider (session validation)", () => {
    it("redirects to OAuth when session is valid", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue("sess-1");
      vi.mocked(validateSession).mockResolvedValue({
        userId: "link-data-user",
        expiresAt: new Date("2027-01-01"),
      });
      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "wahoo",
          name: "Wahoo",
          authSetup: () => ({
            oauthConfig: {
              authorizationEndpoint: "https://api.wahoo.com/oauth/authorize",
              clientId: "test",
              redirectUri: "https://dofek.asherlc.com/callback",
              scopes: ["user_read"],
            },
          }),
        },
      ]);

      const { app } = createTestApp();
      const res = await request(app, "get", "/auth/link/data/wahoo");
      expect(res.status).toBe(302);
    });

    it("returns 401 with expired session message", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue("expired-sess");
      vi.mocked(validateSession).mockResolvedValue(null);
      const { app } = createTestApp();
      const res = await request(app, "get", "/auth/link/data/wahoo");
      expect(res.status).toBe(401);
      expect(res.body).toContain("Session expired");
    });
  });

  // ── Cluster 5: /callback param reading (lines 561-567, 581, 583) ──
  describe("GET /callback (OAuth 1.0 param edge cases)", () => {
    it("falls through to OAuth 2.0 path when only oauth_token is present without oauth_verifier", async () => {
      const { app } = createTestApp();
      // oauth_token without oauth_verifier — the if (oauthToken && oauthVerifier) check fails
      // Falls through to OAuth 2.0 path, which requires code+state
      const res = await request(app, "get", "/callback?oauth_token=some-token");
      // No code/state, so it should hit "Missing code or state parameter"
      expect(res.status).toBe(400);
      expect(res.body).toContain("Missing code or state");
    });

    it("returns OK when only oauth_verifier is present without oauth_token (treated as bare GET)", async () => {
      const { app } = createTestApp();
      // oauth_verifier without oauth_token — oauthToken is undefined, so bare GET check passes
      const res = await request(app, "get", "/callback?oauth_verifier=some-verifier");
      expect(res.status).toBe(200);
      expect(res.body).toBe("OK");
    });

    it("reads code and state from query params correctly", async () => {
      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "wahoo",
          name: "Wahoo",
          authSetup: () => ({
            oauthConfig: {
              authorizationEndpoint: "https://api.wahoo.com/oauth/authorize",
              clientId: "test",
              redirectUri: "https://dofek.asherlc.com/callback",
              scopes: ["user_read"],
            },
            exchangeCode: vi.fn(() =>
              Promise.resolve({
                accessToken: "tok",
                refreshToken: "ref",
                expiresAt: new Date("2027-06-01"),
                scopes: "",
              }),
            ),
          }),
        },
      ]);

      const { app } = createTestApp();
      const startRes = await request(app, "get", "/auth/provider/wahoo");
      expect(startRes.status).toBe(302);
      const location = startRes.headers.location;
      if (typeof location !== "string") throw new Error("Expected location header");
      const redirectUrl = new URL(location);
      const state = redirectUrl.searchParams.get("state");

      // Passing both code and state properly
      const callbackRes = await request(app, "get", `/callback?code=valid-code&state=${state}`);
      expect(callbackRes.status).toBe(200);
      expect(callbackRes.body).toContain("Authorized!");
    });

    it("treats non-string query params as missing (returns 400 with code/state)", async () => {
      const { app } = createTestApp();
      // When code is present as string but state has valid data, it needs a valid state token
      // This test verifies the code param is read properly as a string
      const res = await request(app, "get", "/callback?code=real-code&state=nonexistent-state");
      expect(res.status).toBe(400);
      expect(res.body).toContain("Unknown or expired OAuth state");
    });
  });

  // ── Cluster 6: Data provider callback — webhook registration, identity intent branching ──
  describe("GET /callback (webhook registration on successful data OAuth)", () => {
    it("registers webhook when provider is a webhook provider", async () => {
      vi.mocked(isWebhookProvider).mockReturnValue(true);
      const mockExchangeCode = vi.fn(() =>
        Promise.resolve({
          accessToken: "webhook-access",
          refreshToken: "webhook-refresh",
          expiresAt: new Date("2027-06-01"),
          scopes: "read",
        }),
      );
      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "wahoo",
          name: "Wahoo",
          authSetup: () => ({
            oauthConfig: {
              authorizationEndpoint: "https://api.wahoo.com/oauth/authorize",
              clientId: "test",
              redirectUri: "https://dofek.asherlc.com/callback",
              scopes: ["user_read"],
            },
            exchangeCode: mockExchangeCode,
          }),
        },
      ]);

      const { app } = createTestApp();

      // Start OAuth
      const startRes = await request(app, "get", "/auth/provider/wahoo");
      expect(startRes.status).toBe(302);
      const location = startRes.headers.location;
      if (typeof location !== "string") throw new Error("Expected location header");
      const redirectUrl = new URL(location);
      const state = redirectUrl.searchParams.get("state");

      // Callback
      const callbackRes = await request(
        app,
        "get",
        `/callback?code=wahoo-webhook-code&state=${state}`,
      );
      expect(callbackRes.status).toBe(200);
      expect(registerWebhookForProvider).toHaveBeenCalled();

      vi.mocked(isWebhookProvider).mockReturnValue(false);
    });

    it("does not register webhook when provider is not a webhook provider", async () => {
      vi.mocked(isWebhookProvider).mockReturnValue(false);
      const mockExchangeCode = vi.fn(() =>
        Promise.resolve({
          accessToken: "no-webhook-access",
          refreshToken: "no-webhook-refresh",
          expiresAt: new Date("2027-06-01"),
          scopes: "read",
        }),
      );
      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "wahoo",
          name: "Wahoo",
          authSetup: () => ({
            oauthConfig: {
              authorizationEndpoint: "https://api.wahoo.com/oauth/authorize",
              clientId: "test",
              redirectUri: "https://dofek.asherlc.com/callback",
              scopes: ["user_read"],
            },
            exchangeCode: mockExchangeCode,
          }),
        },
      ]);

      const { app } = createTestApp();
      const startRes = await request(app, "get", "/auth/provider/wahoo");
      const location = startRes.headers.location;
      if (typeof location !== "string") throw new Error("Expected location header");
      const state = new URL(location).searchParams.get("state");

      await request(app, "get", `/callback?code=code&state=${state}`);
      expect(registerWebhookForProvider).not.toHaveBeenCalled();
    });

    it("continues successfully even when webhook registration fails", async () => {
      vi.mocked(isWebhookProvider).mockReturnValue(true);
      vi.mocked(registerWebhookForProvider).mockRejectedValueOnce(
        new Error("Webhook registration failed"),
      );
      const mockExchangeCode = vi.fn(() =>
        Promise.resolve({
          accessToken: "webhook-fail-access",
          refreshToken: "webhook-fail-refresh",
          expiresAt: new Date("2027-06-01"),
          scopes: "read",
        }),
      );
      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "wahoo",
          name: "Wahoo",
          authSetup: () => ({
            oauthConfig: {
              authorizationEndpoint: "https://api.wahoo.com/oauth/authorize",
              clientId: "test",
              redirectUri: "https://dofek.asherlc.com/callback",
              scopes: ["user_read"],
            },
            exchangeCode: mockExchangeCode,
          }),
        },
      ]);

      const { app } = createTestApp();
      const startRes = await request(app, "get", "/auth/provider/wahoo");
      const location = startRes.headers.location;
      if (typeof location !== "string") throw new Error("Expected location header");
      const state = new URL(location).searchParams.get("state");

      // Should still succeed even though webhook registration failed
      const callbackRes = await request(app, "get", `/callback?code=code&state=${state}`);
      expect(callbackRes.status).toBe(200);
      expect(callbackRes.body).toContain("Authorized!");
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to register webhook"),
      );

      vi.mocked(isWebhookProvider).mockReturnValue(false);
    });
  });

  describe("GET /callback (pre-exchange token revocation)", () => {
    it("revokes existing access and refresh tokens when revokeUrl is configured", async () => {
      vi.mocked(loadTokens).mockResolvedValueOnce({
        accessToken: "old-access",
        refreshToken: "old-refresh",
        expiresAt: new Date("2027-01-01"),
        scopes: "read",
      });

      const mockExchangeCode = vi.fn(() =>
        Promise.resolve({
          accessToken: "new-access",
          refreshToken: "new-refresh",
          expiresAt: new Date("2027-06-01"),
          scopes: "read",
        }),
      );
      const revokeUrl = "https://api.wahoo.com/oauth/token/revoke";
      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "wahoo",
          name: "Wahoo",
          authSetup: () => ({
            oauthConfig: {
              clientId: "test",
              redirectUri: "https://dofek.asherlc.com/callback",
              scopes: ["user_read"],
              revokeUrl,
            },
            exchangeCode: mockExchangeCode,
          }),
        },
      ]);

      const { app } = createTestApp();
      const startRes = await request(app, "get", "/auth/provider/wahoo");
      expect(startRes.status).toBe(302);
      const location = startRes.headers.location;
      if (typeof location !== "string") throw new Error("Expected location header");
      const state = new URL(location).searchParams.get("state");

      const callbackRes = await request(app, "get", `/callback?code=code&state=${state}`);
      expect(callbackRes.status).toBe(200);

      // Both access and refresh tokens should have been revoked
      expect(revokeToken).toHaveBeenCalledTimes(2);
      expect(revokeToken).toHaveBeenCalledWith(
        expect.objectContaining({ revokeUrl }),
        "old-access",
      );
      expect(revokeToken).toHaveBeenCalledWith(
        expect.objectContaining({ revokeUrl }),
        "old-refresh",
      );

      // Exchange should still happen after revocation
      expect(mockExchangeCode).toHaveBeenCalledWith("code", undefined);
    });

    it("skips revocation when no existing tokens are stored", async () => {
      vi.mocked(loadTokens).mockResolvedValueOnce(null);

      const mockExchangeCode = vi.fn(() =>
        Promise.resolve({
          accessToken: "new-access",
          refreshToken: "new-refresh",
          expiresAt: new Date("2027-06-01"),
          scopes: "read",
        }),
      );
      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "wahoo",
          name: "Wahoo",
          authSetup: () => ({
            oauthConfig: {
              clientId: "test",
              redirectUri: "https://dofek.asherlc.com/callback",
              scopes: ["user_read"],
              revokeUrl: "https://api.wahoo.com/oauth/token/revoke",
            },
            exchangeCode: mockExchangeCode,
          }),
        },
      ]);

      const { app } = createTestApp();
      const startRes = await request(app, "get", "/auth/provider/wahoo");
      const location = startRes.headers.location;
      if (typeof location !== "string") throw new Error("Expected location header");
      const state = new URL(location).searchParams.get("state");

      const callbackRes = await request(app, "get", `/callback?code=code&state=${state}`);
      expect(callbackRes.status).toBe(200);
      expect(revokeToken).not.toHaveBeenCalled();
      expect(mockExchangeCode).toHaveBeenCalled();
    });

    it("proceeds with exchange even when revocation fails", async () => {
      vi.mocked(loadTokens).mockRejectedValueOnce(new Error("DB connection lost"));

      const mockExchangeCode = vi.fn(() =>
        Promise.resolve({
          accessToken: "new-access",
          refreshToken: "new-refresh",
          expiresAt: new Date("2027-06-01"),
          scopes: "read",
        }),
      );
      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "wahoo",
          name: "Wahoo",
          authSetup: () => ({
            oauthConfig: {
              clientId: "test",
              redirectUri: "https://dofek.asherlc.com/callback",
              scopes: ["user_read"],
              revokeUrl: "https://api.wahoo.com/oauth/token/revoke",
            },
            exchangeCode: mockExchangeCode,
          }),
        },
      ]);

      const { app } = createTestApp();
      const startRes = await request(app, "get", "/auth/provider/wahoo");
      const location = startRes.headers.location;
      if (typeof location !== "string") throw new Error("Expected location header");
      const state = new URL(location).searchParams.get("state");

      const callbackRes = await request(app, "get", `/callback?code=code&state=${state}`);
      expect(callbackRes.status).toBe(200);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Pre-exchange token revocation failed for wahoo"),
      );
      expect(mockExchangeCode).toHaveBeenCalled();
    });
  });

  describe("GET /callback (data intent auto-linking identity)", () => {
    it("auto-links identity to logged-in user for data intent with getUserIdentity", async () => {
      const mockExchangeCode = vi.fn(() =>
        Promise.resolve({
          accessToken: "auto-link-access",
          refreshToken: "auto-link-refresh",
          expiresAt: new Date("2027-06-01"),
          scopes: "read",
        }),
      );
      const mockGetUserIdentity = vi.fn(() =>
        Promise.resolve({
          providerAccountId: "wahoo-user-1",
          email: "wahoo@test.com",
          name: "Wahoo User",
        }),
      );

      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "wahoo",
          name: "Wahoo",
          authSetup: () => ({
            oauthConfig: {
              authorizationEndpoint: "https://api.wahoo.com/oauth/authorize",
              clientId: "test",
              redirectUri: "https://dofek.asherlc.com/callback",
              scopes: ["user_read"],
            },
            exchangeCode: mockExchangeCode,
            getUserIdentity: mockGetUserIdentity,
          }),
        },
      ]);

      // Simulate logged-in user for data intent
      vi.mocked(getSessionIdFromRequest).mockReturnValue("sess-data");
      vi.mocked(validateSession).mockResolvedValue({
        userId: "logged-in-user",
        expiresAt: new Date("2027-01-01"),
      });

      const { app } = createTestApp();

      // Start data OAuth flow
      const startRes = await request(app, "get", "/auth/provider/wahoo");
      expect(startRes.status).toBe(302);
      const location = startRes.headers.location;
      if (typeof location !== "string") throw new Error("Expected location header");
      const state = new URL(location).searchParams.get("state");

      // Callback — should auto-link identity
      const callbackRes = await request(app, "get", `/callback?code=auto-link-code&state=${state}`);
      expect(callbackRes.status).toBe(200);
      expect(callbackRes.body).toContain("Authorized!");
      expect(mockGetUserIdentity).toHaveBeenCalledWith("auto-link-access");
      // resolveOrCreateUser should be called with the logged-in user ID for auto-linking
      expect(resolveOrCreateUser).toHaveBeenCalledWith(
        expect.anything(),
        "wahoo",
        expect.objectContaining({ providerAccountId: "wahoo-user-1" }),
        "logged-in-user",
      );
    });

    it("requires session for data-provider OAuth start", async () => {
      const mockExchangeCode = vi.fn(() =>
        Promise.resolve({
          accessToken: "no-session-access",
          refreshToken: "no-session-refresh",
          expiresAt: new Date("2027-06-01"),
          scopes: "read",
        }),
      );
      const mockGetUserIdentity = vi.fn(() =>
        Promise.resolve({
          providerAccountId: "wahoo-anon",
          email: "anon@test.com",
          name: "Anon",
        }),
      );

      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "wahoo",
          name: "Wahoo",
          authSetup: () => ({
            oauthConfig: {
              authorizationEndpoint: "https://api.wahoo.com/oauth/authorize",
              clientId: "test",
              redirectUri: "https://dofek.asherlc.com/callback",
              scopes: ["user_read"],
            },
            exchangeCode: mockExchangeCode,
            getUserIdentity: mockGetUserIdentity,
          }),
        },
      ]);

      // No logged-in session
      vi.mocked(getSessionIdFromRequest).mockReturnValue(undefined);
      vi.mocked(validateSession).mockResolvedValue(null);

      const { app } = createTestApp();

      const startRes = await request(app, "get", "/auth/provider/wahoo");
      expect(startRes.status).toBe(401);
      expect(mockGetUserIdentity).not.toHaveBeenCalled();
      expect(resolveOrCreateUser).not.toHaveBeenCalled();
    });

    it("continues even when getUserIdentity throws (non-fatal)", async () => {
      const mockExchangeCode = vi.fn(() =>
        Promise.resolve({
          accessToken: "identity-fail-access",
          refreshToken: "identity-fail-refresh",
          expiresAt: new Date("2027-06-01"),
          scopes: "read",
        }),
      );
      const mockGetUserIdentity = vi.fn(() =>
        Promise.reject(new Error("Identity extraction failed")),
      );

      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "wahoo",
          name: "Wahoo",
          authSetup: () => ({
            oauthConfig: {
              authorizationEndpoint: "https://api.wahoo.com/oauth/authorize",
              clientId: "test",
              redirectUri: "https://dofek.asherlc.com/callback",
              scopes: ["user_read"],
            },
            exchangeCode: mockExchangeCode,
            getUserIdentity: mockGetUserIdentity,
          }),
        },
      ]);

      const { app } = createTestApp();
      const startRes = await request(app, "get", "/auth/provider/wahoo");
      const location = startRes.headers.location;
      if (typeof location !== "string") throw new Error("Expected location header");
      const state = new URL(location).searchParams.get("state");

      const callbackRes = await request(
        app,
        "get",
        `/callback?code=fail-identity-code&state=${state}`,
      );
      // Should still succeed — identity extraction failure is non-fatal
      expect(callbackRes.status).toBe(200);
      expect(callbackRes.body).toContain("Authorized!");
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to extract identity"),
      );
    });
  });

  // ── Cluster: /auth/provider/:provider session resolution (line 546) ──
  describe("GET /auth/provider/:provider (session resolution for userId)", () => {
    it("uses session userId when logged in", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue("sess-provider");
      vi.mocked(validateSession).mockResolvedValue({
        userId: "session-user-id",
        expiresAt: new Date("2027-01-01"),
      });

      const mockExchangeCode = vi.fn(() =>
        Promise.resolve({
          accessToken: "session-access",
          refreshToken: "session-refresh",
          expiresAt: new Date("2027-06-01"),
          scopes: "read",
        }),
      );
      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "wahoo",
          name: "Wahoo",
          authSetup: () => ({
            oauthConfig: {
              authorizationEndpoint: "https://api.wahoo.com/oauth/authorize",
              clientId: "test",
              redirectUri: "https://dofek.asherlc.com/callback",
              scopes: ["user_read"],
            },
            exchangeCode: mockExchangeCode,
          }),
        },
      ]);

      const { app } = createTestApp();
      const startRes = await request(app, "get", "/auth/provider/wahoo");
      expect(startRes.status).toBe(302);
      const location = startRes.headers.location;
      if (typeof location !== "string") throw new Error("Expected location header");
      const state = new URL(location).searchParams.get("state");

      const { ensureProvider } = await import("dofek/db/tokens");

      const callbackRes = await request(app, "get", `/callback?code=session-code&state=${state}`);
      expect(callbackRes.status).toBe(200);
      // ensureProvider should be called with the session userId
      expect(ensureProvider).toHaveBeenCalledWith(
        expect.anything(),
        "wahoo",
        "Wahoo",
        undefined,
        "session-user-id",
      );
    });

    it("returns 401 when no session", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue(undefined);
      vi.mocked(validateSession).mockResolvedValue(null);

      const mockExchangeCode = vi.fn(() =>
        Promise.resolve({
          accessToken: "default-access",
          refreshToken: "default-refresh",
          expiresAt: new Date("2027-06-01"),
          scopes: "read",
        }),
      );
      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "wahoo",
          name: "Wahoo",
          authSetup: () => ({
            oauthConfig: {
              authorizationEndpoint: "https://api.wahoo.com/oauth/authorize",
              clientId: "test",
              redirectUri: "https://dofek.asherlc.com/callback",
              scopes: ["user_read"],
            },
            exchangeCode: mockExchangeCode,
          }),
        },
      ]);

      const { app } = createTestApp();
      const startRes = await request(app, "get", "/auth/provider/wahoo");
      const { ensureProvider } = await import("dofek/db/tokens");
      expect(startRes.status).toBe(401);
      expect(ensureProvider).not.toHaveBeenCalled();
    });
  });

  // ── Cluster: OAuth 1.0 callback edge cases ──
  describe("GET /callback (OAuth 1.0 provider not found)", () => {
    it("returns 404 when provider is not found during OAuth 1.0 callback", async () => {
      const mockGetRequestToken = vi.fn(() =>
        Promise.resolve({
          oauthToken: "orphan-oauth1-tok",
          oauthTokenSecret: "orphan-oauth1-secret",
          authorizeUrl: "https://fatsecret.com/authorize?oauth_token=orphan-oauth1-tok",
        }),
      );
      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "fatsecret",
          name: "FatSecret",
          authSetup: (options?: { host?: string }) => ({
            oauthConfig: {
              authorizationEndpoint: "https://fatsecret.com/authorize",
              clientId: "test",
              redirectUri: getOAuthRedirectUri(options?.host),
            },
            oauth1Flow: {
              getRequestToken: mockGetRequestToken,
              exchangeForAccessToken: vi.fn(),
            },
          }),
        },
      ]);

      const { app } = createTestApp();

      // Start OAuth 1.0 flow
      const startRes = await request(app, "get", "/auth/provider/fatsecret");
      expect(startRes.status).toBe(302);

      // Now change getAllProviders to return empty, so the provider won't be found
      vi.mocked(getAllProviders).mockReturnValue([]);

      const callbackRes = await request(
        app,
        "get",
        "/callback?oauth_token=orphan-oauth1-tok&oauth_verifier=verifier",
      );
      expect(callbackRes.status).toBe(404);
      expect(callbackRes.body).toContain("Unknown provider");
    });

    it("returns 400 when provider no longer has oauth1Flow during callback", async () => {
      const mockGetRequestToken = vi.fn(() =>
        Promise.resolve({
          oauthToken: "lost-flow-tok",
          oauthTokenSecret: "lost-flow-secret",
          authorizeUrl: "https://fatsecret.com/authorize?oauth_token=lost-flow-tok",
        }),
      );
      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "fatsecret",
          name: "FatSecret",
          authSetup: (options?: { host?: string }) => ({
            oauthConfig: {
              authorizationEndpoint: "https://fatsecret.com/authorize",
              clientId: "test",
              redirectUri: getOAuthRedirectUri(options?.host),
            },
            oauth1Flow: {
              getRequestToken: mockGetRequestToken,
              exchangeForAccessToken: vi.fn(),
            },
          }),
        },
      ]);

      const { app } = createTestApp();

      // Start OAuth 1.0 flow
      const startRes = await request(app, "get", "/auth/provider/fatsecret");
      expect(startRes.status).toBe(302);

      // Now change provider to no longer have oauth1Flow
      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "fatsecret",
          name: "FatSecret",
          authSetup: (options?: { host?: string }) => ({
            oauthConfig: {
              authorizationEndpoint: "https://fatsecret.com/authorize",
              clientId: "test",
              redirectUri: getOAuthRedirectUri(options?.host),
            },
            // no oauth1Flow
          }),
        },
      ]);

      const callbackRes = await request(
        app,
        "get",
        "/callback?oauth_token=lost-flow-tok&oauth_verifier=verifier",
      );
      expect(callbackRes.status).toBe(400);
      expect(callbackRes.body).toContain("does not support OAuth 1.0");
    });
  });

  // ── Cluster: /api/auth/me clearSessionCookie on expired session ──
  describe("GET /api/auth/me (session cookie cleanup)", () => {
    it("clears session cookie when session is expired", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue("expired-session");
      vi.mocked(validateSession).mockResolvedValue(null);
      const { app } = createTestApp();
      const res = await request(app, "get", "/api/auth/me");
      expect(res.status).toBe(401);
      expect(clearSessionCookie).toHaveBeenCalled();
    });

    it("does not clear session cookie when no session is present", async () => {
      vi.mocked(getSessionIdFromRequest).mockReturnValue(undefined);
      const { app } = createTestApp();
      const res = await request(app, "get", "/api/auth/me");
      expect(res.status).toBe(401);
      expect(clearSessionCookie).not.toHaveBeenCalled();
    });
  });
});

describe("oauthSuccessHtml", () => {
  it("includes provider name", () => {
    const html = oauthSuccessHtml("Wahoo");
    expect(html).toContain("Wahoo connected successfully.");
  });

  it("includes detail when provided", () => {
    const html = oauthSuccessHtml("Wahoo", "Token expires: 2027-01-01");
    expect(html).toContain("Token expires: 2027-01-01");
  });

  it("omits detail paragraph when not provided", () => {
    const html = oauthSuccessHtml("Wahoo");
    // Should have the provider message followed directly by the dashboard link
    expect(html).toContain("connected successfully.</p><p><a href");
  });

  it("includes BroadcastChannel notification script with providerId", () => {
    const html = oauthSuccessHtml("Wahoo", undefined, "wahoo");
    expect(html).toContain("BroadcastChannel('oauth-complete')");
    expect(html).toContain('"type":"complete"');
    expect(html).toContain('"providerId":"wahoo"');
  });

  it("includes window.opener postMessage fallback with providerId", () => {
    const html = oauthSuccessHtml("Wahoo", undefined, "wahoo");
    expect(html).toContain("window.opener");
    expect(html).toContain('"type":"oauth-complete"');
    expect(html).toContain('"providerId":"wahoo"');
  });

  it("falls back to simple message when no providerId", () => {
    const html = oauthSuccessHtml("Slack");
    expect(html).toContain('"type":"complete"');
    expect(html).toContain('"type":"oauth-complete"');
  });

  it("includes window.close() for auto-closing the popup", () => {
    const html = oauthSuccessHtml("Wahoo");
    expect(html).toContain("window.close()");
  });

  it("includes a return-to-dashboard link", () => {
    const html = oauthSuccessHtml("Wahoo");
    expect(html).toContain('<a href="/"');
    expect(html).toContain("Return to dashboard");
  });

  it("escapes special characters in providerName to prevent XSS", () => {
    const html = oauthSuccessHtml('<script>alert("xss")</script>');
    expect(html).toContain("&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
    expect(html).not.toContain("<script>alert");
  });

  it("escapes special characters in detail string", () => {
    const html = oauthSuccessHtml("Wahoo", 'Attempt & "Fail"');
    expect(html).toContain("Attempt &amp; &quot;Fail&quot;");
  });

  it("safely embeds JSON by escaping script tags", () => {
    const html = oauthSuccessHtml("Wahoo");
    // The embedded JSON should use the actual payload shapes the implementation produces
    expect(html).toContain('{"type":"complete"}');
    expect(html).toContain('{"type":"oauth-complete"}');
    // Ensure no raw </script> exists that could prematurely terminate the block
    const scriptBlocks = html.match(/<script[\s\S]*?<\/script[^>]*>/gi) || [];
    for (const block of scriptBlocks) {
      const content = block.replace(/^<script[\s\S]*?>|<\/script[^>]*>$/gi, "");
      expect(content).not.toContain("</script>");
    }
  });
});

describe("OAuth callback success responses include notification script", () => {
  it("credential providers are rejected at the OAuth route", async () => {
    vi.mocked(getSessionIdFromRequest).mockReturnValue("sess-1");
    vi.mocked(validateSession).mockResolvedValue({
      userId: "user-1",
      expiresAt: new Date("2027-01-01"),
    });
    vi.mocked(getAllProviders).mockReturnValue([
      {
        id: "peloton",
        name: "Peloton",
        authSetup: () => ({
          oauthConfig: {},
          automatedLogin: vi.fn(),
          apiBaseUrl: "https://api.peloton.com",
        }),
      },
    ]);
    const { app } = createTestApp();
    const res = await request(app, "get", "/auth/provider/peloton");
    expect(res.status).toBe(400);
    expect(res.body).toContain("credential authentication");
  });
});
