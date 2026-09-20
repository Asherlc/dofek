import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TokenSet } from "../../auth/oauth.ts";
import { logger } from "../../logger.ts";
import { ProviderAuthorizationFailedError } from "../auth-errors.ts";
import {
  createZivaAuthSetup,
  validateZivaAuthConfiguration,
  validateZivaRefreshedIdentity,
  zivaSubjectFromAccessToken,
} from "./auth.ts";

const ZIVA_ISSUER = "https://connect.ziva.fit/";
const ZIVA_RESOURCE = "https://connect.ziva.fit/mcp";

function jwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const claims = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${claims}.synthetic-signature`;
}

function tokenResponseFetch(
  accessToken: string,
  inspectRequest?: (url: string, init?: RequestInit) => void,
): typeof globalThis.fetch {
  return async (input, init) => {
    inspectRequest?.(String(input), init);
    return Response.json({
      access_token: accessToken,
      refresh_token: "rotated-refresh-token",
      expires_in: 3600,
      token_type: "Bearer",
    });
  };
}

function configuredSetup(fetchFn: typeof globalThis.fetch) {
  const setup = createZivaAuthSetup(undefined, fetchFn);
  if (!setup?.exchangeCode || !setup.oauthConfig) {
    throw new Error("Expected configured Ziva OAuth setup");
  }
  return {
    ...setup,
    exchangeCode: setup.exchangeCode,
    oauthConfig: setup.oauthConfig,
  };
}

function tokens(accessToken: string, providerAccountId?: string): TokenSet {
  return {
    accessToken,
    refreshToken: "refresh-token",
    expiresAt: new Date("2026-09-20T18:00:00.000Z"),
    scopes: null,
    ...(providerAccountId ? { providerAccountId } : {}),
  };
}

describe("Ziva OAuth configuration", () => {
  beforeEach(() => {
    vi.stubEnv("ZIVA_CLIENT_ID", "ziva-client-id");
    vi.stubEnv("ZIVA_CLIENT_SECRET", "ziva-client-secret");
    vi.stubEnv("OAUTH_REDIRECT_URI", "https://dofek.example.com/callback");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("builds the registered confidential-client PKCE setup", () => {
    const setup = createZivaAuthSetup();

    expect(setup?.oauthConfig).toEqual({
      clientId: "ziva-client-id",
      clientSecret: "ziva-client-secret",
      authorizeUrl: "https://connect.ziva.fit/authorize",
      tokenUrl: "https://connect.ziva.fit/token",
      redirectUri: "https://dofek.example.com/callback",
      scopes: [],
      usePkce: true,
      tokenAuthMethod: "body",
      resource: ZIVA_RESOURCE,
    });
  });

  it.each([
    ["ZIVA_CLIENT_ID", "ZIVA_CLIENT_ID is not set"],
    ["ZIVA_CLIENT_SECRET", "ZIVA_CLIENT_SECRET is not set"],
  ] as const)("returns no setup when %s is missing", (key, expectedError) => {
    delete process.env[key];

    expect(validateZivaAuthConfiguration()).toBe(expectedError);
    expect(createZivaAuthSetup()).toBeUndefined();
  });

  it("requires the callback PKCE verifier before contacting the token endpoint", async () => {
    const fetchFn = vi.fn<typeof globalThis.fetch>();
    const { exchangeCode } = configuredSetup(fetchFn);

    await expect(exchangeCode("authorization-code")).rejects.toThrow(
      "Ziva OAuth code exchange requires a PKCE verifier",
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });
});

describe("Ziva OAuth token identity", () => {
  beforeEach(() => {
    vi.stubEnv("ZIVA_CLIENT_ID", "ziva-client-id");
    vi.stubEnv("ZIVA_CLIENT_SECRET", "ziva-client-secret");
    vi.stubEnv("OAUTH_REDIRECT_URI", "https://dofek.example.com/callback");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([[ZIVA_RESOURCE], [["https://other.example/resource", ZIVA_RESOURCE]]])(
    "exchanges a code and stores the verified subject for audience %j",
    async (audience) => {
      const accessToken = jwt({
        iss: ZIVA_ISSUER,
        aud: audience,
        sub: "stable-ziva-subject",
      });
      const fetchFn = tokenResponseFetch(accessToken, (url, init) => {
        expect(url).toBe("https://connect.ziva.fit/token");
        const body = new URLSearchParams(String(init?.body));
        expect(body.get("client_id")).toBe("ziva-client-id");
        expect(body.get("client_secret")).toBe("ziva-client-secret");
        expect(body.get("code_verifier")).toBe("pkce-verifier");
        expect(body.get("resource")).toBe(ZIVA_RESOURCE);
      });
      const { exchangeCode } = configuredSetup(fetchFn);

      const result = await exchangeCode("authorization-code", "pkce-verifier");

      expect(result).toMatchObject({
        accessToken,
        refreshToken: "rotated-refresh-token",
        providerAccountId: "stable-ziva-subject",
      });
      expect(zivaSubjectFromAccessToken(accessToken)).toBe("stable-ziva-subject");
    },
  );

  it.each([
    ["a malformed JWT", "not-a-jwt"],
    [
      "the wrong issuer",
      jwt({ iss: "https://issuer.example/", aud: ZIVA_RESOURCE, sub: "stable-ziva-subject" }),
    ],
    [
      "the wrong audience",
      jwt({ iss: ZIVA_ISSUER, aud: "https://other.example/resource", sub: "stable-ziva-subject" }),
    ],
    ["a blank subject", jwt({ iss: ZIVA_ISSUER, aud: ZIVA_RESOURCE, sub: "   " })],
    ["a missing subject", jwt({ iss: ZIVA_ISSUER, aud: ZIVA_RESOURCE })],
  ])("rejects %s returned by the fixed token endpoint", async (_case, accessToken) => {
    const { exchangeCode } = configuredSetup(tokenResponseFetch(accessToken));

    await expect(exchangeCode("authorization-code", "pkce-verifier")).rejects.toBeInstanceOf(
      ProviderAuthorizationFailedError,
    );
  });

  it("does not log the access token while deriving its identity", async () => {
    const accessToken = jwt({
      iss: ZIVA_ISSUER,
      aud: ZIVA_RESOURCE,
      sub: "stable-ziva-subject",
    });
    const logSpies = [
      vi.spyOn(logger, "debug"),
      vi.spyOn(logger, "info"),
      vi.spyOn(logger, "warn"),
      vi.spyOn(logger, "error"),
    ];
    const { exchangeCode } = configuredSetup(tokenResponseFetch(accessToken));

    await exchangeCode("authorization-code", "pkce-verifier");

    for (const logSpy of logSpies) {
      expect(logSpy).not.toHaveBeenCalled();
    }
  });

  it("accepts a refreshed token for the stored account subject", () => {
    const refreshed = tokens(
      jwt({ iss: ZIVA_ISSUER, aud: ZIVA_RESOURCE, sub: "stable-ziva-subject" }),
    );

    expect(() =>
      validateZivaRefreshedIdentity(tokens("old-token", "stable-ziva-subject"), refreshed),
    ).not.toThrow();
  });

  it("accepts matching refreshed token-response account identity", () => {
    const refreshed = tokens(
      jwt({ iss: ZIVA_ISSUER, aud: ZIVA_RESOURCE, sub: "stable-ziva-subject" }),
      "stable-ziva-subject",
    );

    expect(() =>
      validateZivaRefreshedIdentity(tokens("old-token", "stable-ziva-subject"), refreshed),
    ).not.toThrow();
  });

  it("rejects a refreshed token for a different account subject", () => {
    const refreshed = tokens(
      jwt({ iss: ZIVA_ISSUER, aud: ZIVA_RESOURCE, sub: "changed-ziva-subject" }),
    );

    expect(() =>
      validateZivaRefreshedIdentity(tokens("old-token", "stable-ziva-subject"), refreshed),
    ).toThrow(ProviderAuthorizationFailedError);
  });

  it("rejects conflicting refreshed token-response account identity", () => {
    const refreshed = tokens(
      jwt({ iss: ZIVA_ISSUER, aud: ZIVA_RESOURCE, sub: "stable-ziva-subject" }),
      "changed-ziva-subject",
    );

    expect(() =>
      validateZivaRefreshedIdentity(tokens("old-token", "stable-ziva-subject"), refreshed),
    ).toThrow(ProviderAuthorizationFailedError);
  });
});
