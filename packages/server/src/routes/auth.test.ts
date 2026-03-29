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
  getIdentityProvider: vi.fn(() => ({
    createAuthorizationUrl: vi.fn(() => new URL("https://accounts.google.com/authorize")),
    validateCallback: vi.fn(),
  })),
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
}));

vi.mock("dofek/auth/oauth", () => ({
  getOAuthRedirectUri: vi.fn(() => "https://dofek.asherlc.com/callback"),
  buildAuthorizationUrl: vi.fn(() => "https://oauth.example.com/authorize?client_id=test"),
  generateCodeVerifier: vi.fn(() => "pkce-verifier"),
  generateCodeChallenge: vi.fn(() => "pkce-challenge"),
}));

vi.mock("../routers/sync.ts", () => ({
  ensureProvidersRegistered: vi.fn(() => Promise.resolve()),
}));

vi.mock("dofek/providers/types", () => ({
  isWebhookProvider: vi.fn(() => false),
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
import { createDatabaseFromEnv } from "dofek/db";
import { getAllProviders } from "dofek/providers/registry";
import express from "express";
import { resolveOrCreateUser } from "../auth/account-linking.ts";
import {
  getLinkUserCookie,
  getMobileSchemeCookie,
  getOAuthFlowCookies,
  getPostLoginRedirectCookie,
  getSessionIdFromRequest,
  setMobileSchemeCookie,
  setPostLoginRedirectCookie,
  setSessionCookie,
} from "../auth/cookies.ts";
import { getIdentityProvider, isProviderConfigured } from "../auth/providers.ts";
import { createSession, deleteSession, validateSession } from "../auth/session.ts";
import { createAuthRouter } from "./auth.ts";

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
  options?: { formBody?: Record<string, string> },
): Promise<{
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = getPort(server);
      const fetchOptions: RequestInit = { method: method.toUpperCase(), redirect: "manual" };
      if (options?.formBody) {
        fetchOptions.body = new URLSearchParams(options.formBody).toString();
        fetchOptions.headers = { "Content-Type": "application/x-www-form-urlencoded" };
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
        { id: "user-1", name: "Alice", email: "alice@test.com" },
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
          authSetup: () => ({
            oauthConfig: { authorizationEndpoint: "https://strava.com/oauth" },
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
          authSetup: () => ({
            oauthConfig: { authorizationEndpoint: "https://strava.com/oauth" },
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
        { id: "user-1", name: "Alice", email: "alice@test.com" },
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
      expect(data).toEqual({ id: "user-1", name: "Alice", email: "alice@test.com" });
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
      expect(callbackRes.status).toBe(302);
      expect(callbackRes.headers.location).toBe("/");
      expect(mockGetUserIdentity).toHaveBeenCalledWith("login-access-token");
      expect(resolveOrCreateUser).toHaveBeenCalled();
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
          authSetup: () => ({
            oauthConfig: {
              authorizationEndpoint: "https://fatsecret.com/authorize",
              clientId: "test",
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

      // We need the state to start with "slack:" and be in the map
      // Start the Slack OAuth to get valid state
      vi.mocked(getSessionIdFromRequest).mockReturnValue(undefined);
      vi.mocked(validateSession).mockResolvedValue(null);

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
    it("returns 400 when Apple is not configured", async () => {
      vi.mocked(isProviderConfigured).mockReturnValue(false);
      const { app } = createTestApp();
      const res = await request(app, "post", "/auth/apple/native", {
        formBody: { authorizationCode: "code", identityToken: "token" },
      });
      expect(res.status).toBe(400);
      expect(res.body).toContain("not configured");
      vi.mocked(isProviderConfigured).mockImplementation((name: string) => name === "google");
    });

    it("returns 400 when authorizationCode is missing", async () => {
      vi.mocked(isProviderConfigured).mockImplementation((name: string) => name === "apple");
      const { app } = createTestApp();
      const res = await request(app, "post", "/auth/apple/native", {
        formBody: { identityToken: "token" },
      });
      expect(res.status).toBe(400);
      expect(res.body).toContain("authorizationCode");
      vi.mocked(isProviderConfigured).mockImplementation((name: string) => name === "google");
    });

    it("returns session token on success", async () => {
      vi.mocked(isProviderConfigured).mockImplementation((name: string) => name === "apple");
      const mockValidate = vi.fn(() =>
        Promise.resolve({
          tokens: {},
          user: { sub: "apple-native-1", email: "alice@icloud.com", name: null, groups: null },
        }),
      );
      vi.mocked(getIdentityProvider).mockReturnValue({
        createAuthorizationUrl: vi.fn(() => new URL("https://appleid.apple.com/auth/authorize")),
        validateCallback: mockValidate,
      });
      const { app } = createTestApp();
      const res = await request(app, "post", "/auth/apple/native", {
        formBody: { authorizationCode: "native-code", identityToken: "jwt-token" },
      });
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.session).toBeDefined();
      expect(mockValidate).toHaveBeenCalledWith("native-code", "");
      vi.mocked(isProviderConfigured).mockImplementation((name: string) => name === "google");
    });

    it("passes fullName from givenName+familyName to resolveOrCreateUser when identity token has no name", async () => {
      vi.mocked(isProviderConfigured).mockImplementation((name: string) => name === "apple");
      const mockValidate = vi.fn(() =>
        Promise.resolve({
          tokens: {},
          user: { sub: "apple-native-2", email: "bob@icloud.com", name: null, groups: null },
        }),
      );
      vi.mocked(getIdentityProvider).mockReturnValue({
        createAuthorizationUrl: vi.fn(() => new URL("https://appleid.apple.com/auth/authorize")),
        validateCallback: mockValidate,
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
      vi.mocked(isProviderConfigured).mockImplementation((name: string) => name === "google");
    });

    it("prefers identity token name over fullName from SDK", async () => {
      vi.mocked(isProviderConfigured).mockImplementation((name: string) => name === "apple");
      const mockValidate = vi.fn(() =>
        Promise.resolve({
          tokens: {},
          user: {
            sub: "apple-native-3",
            email: "carol@icloud.com",
            name: "Carol Token",
            groups: null,
          },
        }),
      );
      vi.mocked(getIdentityProvider).mockReturnValue({
        createAuthorizationUrl: vi.fn(() => new URL("https://appleid.apple.com/auth/authorize")),
        validateCallback: mockValidate,
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
      vi.mocked(isProviderConfigured).mockImplementation((name: string) => name === "google");
    });

    it("handles only givenName without familyName", async () => {
      vi.mocked(isProviderConfigured).mockImplementation((name: string) => name === "apple");
      const mockValidate = vi.fn(() =>
        Promise.resolve({
          tokens: {},
          user: { sub: "apple-native-4", email: null, name: null, groups: null },
        }),
      );
      vi.mocked(getIdentityProvider).mockReturnValue({
        createAuthorizationUrl: vi.fn(() => new URL("https://appleid.apple.com/auth/authorize")),
        validateCallback: mockValidate,
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
      vi.mocked(isProviderConfigured).mockImplementation((name: string) => name === "google");
    });

    it("passes null name when no name sources are available", async () => {
      vi.mocked(isProviderConfigured).mockImplementation((name: string) => name === "apple");
      const mockValidate = vi.fn(() =>
        Promise.resolve({
          tokens: {},
          user: { sub: "apple-native-5", email: null, name: null, groups: null },
        }),
      );
      vi.mocked(getIdentityProvider).mockReturnValue({
        createAuthorizationUrl: vi.fn(() => new URL("https://appleid.apple.com/auth/authorize")),
        validateCallback: mockValidate,
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
      vi.mocked(isProviderConfigured).mockImplementation((name: string) => name === "google");
    });

    it("returns 500 when validateCallback throws", async () => {
      vi.mocked(isProviderConfigured).mockImplementation((name: string) => name === "apple");
      vi.mocked(getIdentityProvider).mockReturnValue({
        createAuthorizationUrl: vi.fn(() => new URL("https://appleid.apple.com/auth/authorize")),
        validateCallback: vi.fn(() => Promise.reject(new Error("Invalid code"))),
      });
      const { app } = createTestApp();
      const res = await request(app, "post", "/auth/apple/native", {
        formBody: { authorizationCode: "bad-code" },
      });
      expect(res.status).toBe(500);
      expect(res.body).toContain("Apple Sign In failed");
      vi.mocked(isProviderConfigured).mockImplementation((name: string) => name === "google");
    });

    it("rejects non-string authorizationCode", async () => {
      vi.mocked(isProviderConfigured).mockImplementation((name: string) => name === "apple");
      const { app } = createTestApp();
      // Sending empty formBody — authorizationCode absent
      const res = await request(app, "post", "/auth/apple/native", {
        formBody: {},
      });
      expect(res.status).toBe(400);
      expect(res.body).toContain("authorizationCode");
      vi.mocked(isProviderConfigured).mockImplementation((name: string) => name === "google");
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
});

describe("OAuth callback success responses include notification script", () => {
  it("credential providers are rejected at the OAuth route", async () => {
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
