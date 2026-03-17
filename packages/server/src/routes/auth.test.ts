import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock all heavy dependencies
vi.mock("../auth/cookies.ts", () => ({
  getSessionCookie: vi.fn(),
  setSessionCookie: vi.fn(),
  clearSessionCookie: vi.fn(),
  getOAuthFlowCookies: vi.fn(() => ({ state: null, codeVerifier: null })),
  setOAuthFlowCookies: vi.fn(),
  clearOAuthFlowCookies: vi.fn(),
  getLinkUserCookie: vi.fn(() => null),
  setLinkUserCookie: vi.fn(),
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
import { getOAuthFlowCookies, getSessionCookie } from "../auth/cookies.ts";
import { getIdentityProvider, isProviderConfigured } from "../auth/providers.ts";
import { deleteSession, validateSession } from "../auth/session.ts";
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
): Promise<{
  status: number;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}> {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const port = getPort(server);
      fetch(`http://localhost:${port}${path}`, { method: method.toUpperCase(), redirect: "manual" })
        .then(async (res) => {
          const body = await res.text();
          const headers: Record<string, string | string[] | undefined> = {};
          for (const [k, v] of res.headers.entries()) headers[k] = v;
          resolve({ status: res.status, body, headers });
          server.close();
        })
        .catch(() => {
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
      vi.mocked(getSessionCookie).mockReturnValue("sess-1");
      const { app } = createTestApp();
      const res = await request(app, "post", "/auth/logout");
      expect(res.status).toBe(200);
      const data = JSON.parse(res.body);
      expect(data.ok).toBe(true);
      expect(deleteSession).toHaveBeenCalledWith(expect.anything(), "sess-1");
    });

    it("returns ok even without session", async () => {
      vi.mocked(getSessionCookie).mockReturnValue(undefined);
      const { app } = createTestApp();
      const res = await request(app, "post", "/auth/logout");
      expect(res.status).toBe(200);
      expect(deleteSession).not.toHaveBeenCalled();
    });
  });

  describe("GET /api/auth/me", () => {
    it("returns 401 when no session cookie", async () => {
      vi.mocked(getSessionCookie).mockReturnValue(undefined);
      const { app } = createTestApp();
      const res = await request(app, "get", "/api/auth/me");
      expect(res.status).toBe(401);
    });

    it("returns 401 when session is invalid", async () => {
      vi.mocked(getSessionCookie).mockReturnValue("bad-session");
      vi.mocked(validateSession).mockResolvedValue(null);
      const { app } = createTestApp();
      const res = await request(app, "get", "/api/auth/me");
      expect(res.status).toBe(401);
    });

    it("returns user when session is valid", async () => {
      vi.mocked(getSessionCookie).mockReturnValue("good-session");
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
      vi.mocked(getSessionCookie).mockReturnValue("good-session");
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
  });

  describe("GET /auth/link/:provider", () => {
    it("returns 404 for unknown provider", async () => {
      const { app } = createTestApp();
      const res = await request(app, "get", "/auth/link/unknown");
      expect(res.status).toBe(404);
    });

    it("returns 401 when not logged in", async () => {
      vi.mocked(getSessionCookie).mockReturnValue(undefined);
      const { app } = createTestApp();
      const res = await request(app, "get", "/auth/link/google");
      expect(res.status).toBe(401);
    });

    it("returns 400 for unconfigured provider", async () => {
      vi.mocked(getSessionCookie).mockReturnValue("sess-1");
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
      vi.mocked(getSessionCookie).mockReturnValue("sess-1");
      vi.mocked(validateSession).mockResolvedValue(null);
      const { app } = createTestApp();
      const res = await request(app, "get", "/auth/link/google");
      expect(res.status).toBe(401);
    });

    it("redirects when logged in with valid session", async () => {
      vi.mocked(getSessionCookie).mockReturnValue("sess-1");
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
      vi.mocked(getSessionCookie).mockReturnValue(undefined);
      const { app } = createTestApp();
      const res = await request(app, "get", "/auth/link/data/wahoo");
      expect(res.status).toBe(401);
    });

    it("returns 401 when session is expired", async () => {
      vi.mocked(getSessionCookie).mockReturnValue("sess-1");
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

    it("handles automated login when env vars are missing", async () => {
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
      delete process.env.PELOTON_USERNAME;
      delete process.env.PELOTON_PASSWORD;
      const { app } = createTestApp();
      const res = await request(app, "get", "/auth/provider/peloton");
      expect(res.status).toBe(400);
      expect(res.body).toContain("PELOTON_USERNAME");
    });

    it("handles automated login with env vars set", async () => {
      const mockAutoLogin = vi.fn(() =>
        Promise.resolve({
          accessToken: "tok-123",
          refreshToken: null,
          expiresAt: new Date("2027-01-01"),
          scopes: "",
        }),
      );
      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "peloton",
          name: "Peloton",
          authSetup: () => ({
            oauthConfig: {},
            automatedLogin: mockAutoLogin,
            apiBaseUrl: "https://api.peloton.com",
          }),
        },
      ]);
      process.env.PELOTON_USERNAME = "user@test.com";
      process.env.PELOTON_PASSWORD = "pass123";
      const { app } = createTestApp();
      const res = await request(app, "get", "/auth/provider/peloton");
      expect(res.status).toBe(200);
      expect(res.body).toContain("Authorized!");
      delete process.env.PELOTON_USERNAME;
      delete process.env.PELOTON_PASSWORD;
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

  describe("GET /auth/provider/:provider (automated login error)", () => {
    it("returns 500 when automated login throws", async () => {
      vi.mocked(getAllProviders).mockReturnValue([
        {
          id: "peloton",
          name: "Peloton",
          authSetup: () => ({
            oauthConfig: {},
            automatedLogin: vi.fn().mockRejectedValue(new Error("Login failed")),
            apiBaseUrl: "https://api.peloton.com",
          }),
        },
      ]);
      process.env.PELOTON_USERNAME = "user@test.com";
      process.env.PELOTON_PASSWORD = "pass123";
      const { app } = createTestApp();
      const res = await request(app, "get", "/auth/provider/peloton");
      expect(res.status).toBe(500);
      delete process.env.PELOTON_USERNAME;
      delete process.env.PELOTON_PASSWORD;
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
      vi.mocked(getSessionCookie).mockReturnValue("sess-1");
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

  describe("GET /api/auth/providers (error fallback)", () => {
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
      vi.mocked(getSessionCookie).mockReturnValue("sess-1");
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
});
