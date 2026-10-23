import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAuthorizationUrl, refreshAccessToken, type TokenSet } from "../../auth/oauth.ts";
import { captureException } from "../../lib/error-reporting.ts";
import { logger } from "../../logger.ts";
import { createGarminAuthSetup } from "./oauth.ts";

vi.mock("../../lib/error-reporting.ts", () => ({ captureException: vi.fn() }));

const TOKEN_URL = "https://diauth.garmin.com/di-oauth2-service/oauth/token";
const API_BASE = "https://apis.garmin.com/partner-gateway/rest";

function tokenResponse() {
  return Response.json({
    access_token: "access-token",
    refresh_token: "refresh-token",
    expires_in: 86400,
    scope: "PARTNER_READ PARTNER_WRITE CONNECT_READ CONNECT_WRITE",
  });
}

function authorization(expiresAt = new Date(Date.now() + 60_000)): TokenSet {
  return {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt,
    providerAccountId: "stable-garmin-owner",
    scopes: "ACTIVITY_EXPORT HEALTH_EXPORT",
  };
}

describe("createGarminAuthSetup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(logger, "warn").mockReturnValue(logger);
    vi.stubEnv("GARMIN_CLIENT_ID", "client-id");
    vi.stubEnv("GARMIN_CLIENT_SECRET", "client-secret");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each(["GARMIN_CLIENT_ID", "GARMIN_CLIENT_SECRET"])("requires %s", (key) => {
    vi.stubEnv(key, "");
    expect(() => createGarminAuthSetup(vi.fn<typeof fetch>())).toThrow(key);
  });

  it("uses the official authorization endpoint and shared PKCE flow without changing partner scopes", () => {
    const setup = createGarminAuthSetup(vi.fn<typeof fetch>(), "app.example.com");
    expect(setup.oauthConfig).toMatchObject({
      authorizeUrl: "https://connect.garmin.com/oauth2Confirm",
      tokenUrl: TOKEN_URL,
      clientId: "client-id",
      clientSecret: "client-secret",
      redirectUri: "https://app.example.com/callback",
      scopes: [],
      usePkce: true,
      tokenAuthMethod: "basic",
    });
    if (!setup.oauthConfig) throw new Error("Missing OAuth config");
    const url = new URL(buildAuthorizationUrl(setup.oauthConfig, { codeChallenge: "challenge" }));
    expect(url.searchParams.get("code_challenge")).toBe("challenge");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.has("scope")).toBe(false);
  });

  it("exchanges with Basic client authentication and attaches stable identity and actual permissions", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(Response.json({ userId: "stable-garmin-owner" }))
      .mockResolvedValueOnce(Response.json({ permissions: ["ACTIVITY_EXPORT", "HEALTH_EXPORT"] }));
    const setup = createGarminAuthSetup(fetchFn, "app.example.com");
    const issued = vi.fn();
    const tokens = await setup.exchangeCode?.("authorization-code", "pkce-verifier", issued);

    expect(tokens).toMatchObject({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      providerAccountId: "stable-garmin-owner",
      scopes: "ACTIVITY_EXPORT HEALTH_EXPORT",
    });
    expect(issued).toHaveBeenCalledWith(expect.objectContaining({ accessToken: "access-token" }));
    expect(tokens).toHaveProperty("authorizationId", expect.stringMatching(/^[0-9a-f-]{36}$/));
    expect(issued).toHaveBeenCalledWith(
      expect.objectContaining({
        authorizationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      }),
    );
    const [url, request] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe(TOKEN_URL);
    expect(new Headers(request?.headers).get("Authorization")).toBe(
      `Basic ${btoa("client-id:client-secret")}`,
    );
    const body = new URLSearchParams(String(request?.body));
    expect(body.get("code")).toBe("authorization-code");
    expect(body.get("code_verifier")).toBe("pkce-verifier");
    expect(body.get("redirect_uri")).toBe("https://app.example.com/callback");
    expect(body.has("client_secret")).toBe(false);
    expect(fetchFn).toHaveBeenNthCalledWith(
      2,
      `${API_BASE}/user/id`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer access-token" }),
      }),
    );
    expect(fetchFn).toHaveBeenNthCalledWith(
      3,
      `${API_BASE}/user/permissions`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer access-token" }),
      }),
    );
  });

  it("requires the PKCE verifier before sending the authorization code", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    await expect(createGarminAuthSetup(fetchFn).exchangeCode?.("code")).rejects.toThrow("PKCE");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("reports the verified account identity before permissions lookup can fail", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(Response.json({ userId: "verified-owner" }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }));
    const issued = vi.fn();

    await expect(
      createGarminAuthSetup(fetchFn).exchangeCode?.("code", "verifier", issued),
    ).rejects.toThrow("503");

    expect(issued).toHaveBeenLastCalledWith(
      expect.objectContaining({ providerAccountId: "verified-owner" }),
    );
  });

  it.each([{}, { userId: "" }, { userId: "   " }, { userId: 123 }])(
    "rejects an unusable account identity %j",
    async (identity) => {
      const fetchFn = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(Response.json(identity));
      await expect(
        createGarminAuthSetup(fetchFn).exchangeCode?.("code", "verifier"),
      ).rejects.toThrow();
    },
  );

  it.each(["identity", "permissions"])(
    "reports a rejected %s request with safe stage diagnostics",
    async (failure) => {
      const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(tokenResponse());
      if (failure === "permissions") {
        fetchFn.mockResolvedValueOnce(Response.json({ userId: "owner" }));
      }
      fetchFn.mockResolvedValueOnce(
        Response.json(
          { error: "insufficient_scope", error_description: "private-upstream-detail" },
          { status: 401 },
        ),
      );
      await expect(
        createGarminAuthSetup(fetchFn).exchangeCode?.("code", "verifier"),
      ).rejects.toMatchObject({
        name: "ProviderConnectionError",
        stage: failure,
        statusCode: 401,
      });
      expect(captureException).toHaveBeenCalledWith(
        expect.objectContaining({ name: "ProviderConnectionError" }),
        expect.objectContaining({
          extra: expect.objectContaining({
            stage: failure,
            statusCode: 401,
            errorCodes: ["insufficient_scope"],
          }),
        }),
      );
      expect(JSON.stringify(vi.mocked(captureException).mock.calls)).not.toContain(
        "private-upstream-detail",
      );
      expect(fetchFn).toHaveBeenCalledTimes(failure === "permissions" ? 3 : 2);
    },
  );

  it("rejects malformed permissions rather than storing default OAuth scopes", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(Response.json({ userId: "owner" }))
      .mockResolvedValueOnce(Response.json({ permissions: "HEALTH_EXPORT" }));
    await expect(
      createGarminAuthSetup(fetchFn).exchangeCode?.("code", "verifier"),
    ).rejects.toThrow();
  });

  it("preserves an explicitly empty permission list", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(Response.json({ userId: "owner" }))
      .mockResolvedValueOnce(Response.json({ permissions: [] }));
    const result = await createGarminAuthSetup(fetchFn).exchangeCode?.("code", "verifier");
    expect(result?.scopes).toBe("");
  });

  it("uses the shared refresh contract and keeps Garmin's rotated refresh token", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        access_token: "rotated-access",
        refresh_token: "rotated-refresh",
        expires_in: 86400,
      }),
    );
    const config = createGarminAuthSetup(fetchFn).oauthConfig;
    if (!config) throw new Error("Missing OAuth config");
    const refreshed = await refreshAccessToken(config, "old-refresh", fetchFn);
    expect(refreshed.refreshToken).toBe("rotated-refresh");
    expect(new Headers(fetchFn.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      `Basic ${btoa("client-id:client-secret")}`,
    );
    const body = new URLSearchParams(String(fetchFn.mock.calls[0]?.[1]?.body));
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("old-refresh");
  });

  it("deletes the official registration for both disconnect and account erasure", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    const setup = createGarminAuthSetup(fetchFn);
    await setup.revokeExistingTokens?.(authorization(), vi.fn());
    await setup.revokeTokensForAccountErasure?.(authorization(), vi.fn());
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(fetchFn).toHaveBeenCalledWith(
      `${API_BASE}/user/registration`,
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({ Authorization: "Bearer access-token" }),
      }),
    );
    expect(setup.reconnectStrategy).toBe("replace");
  });

  it.each([401, 403, 404, 500])(
    "does not treat deregistration HTTP %i as confirmed revocation",
    async (status) => {
      const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status }));
      await expect(
        createGarminAuthSetup(fetchFn).revokeExistingTokens?.(authorization(), vi.fn()),
      ).rejects.toThrow(String(status));
    },
  );

  it("refreshes an expired official access token before deregistering", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          access_token: "new-access",
          refresh_token: "new-refresh",
          expires_in: 86400,
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await createGarminAuthSetup(fetchFn).revokeExistingTokens?.(
      authorization(new Date(0)),
      vi.fn(),
    );
    expect(fetchFn.mock.calls[0]?.[0]).toBe(TOKEN_URL);
    expect(fetchFn).toHaveBeenNthCalledWith(
      2,
      `${API_BASE}/user/registration`,
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer new-access" }),
      }),
    );
  });

  it.each(["revokeExistingTokens", "revokeTokensForAccountErasure"] as const)(
    "%s durably preserves rotated credentials before a failed registration deletion",
    async (hook) => {
      const original = { ...authorization(new Date(0)), authorizationId: "current-grant" };
      let durableTokens: TokenSet = original;
      const fetchFn = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(
          Response.json({
            access_token: "rotated-access",
            refresh_token: "rotated-refresh",
            expires_in: 86400,
            scope: "PARTNER_READ",
          }),
        )
        .mockImplementationOnce(async () => {
          expect(durableTokens).toMatchObject({
            accessToken: "rotated-access",
            refreshToken: "rotated-refresh",
            providerAccountId: original.providerAccountId,
            authorizationId: "current-grant",
            scopes: original.scopes,
          });
          return new Response(null, { status: 503 });
        });
      await expect(
        createGarminAuthSetup(fetchFn)[hook]?.(original, async (tokens) => {
          durableTokens = tokens;
        }),
      ).rejects.toThrow("503");
      expect(durableTokens.expiresAt.getTime()).toBeGreaterThan(Date.now());
    },
  );

  it("does not delete registration when saving rotated credentials fails", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(tokenResponse());
    const persist = vi.fn().mockRejectedValue(new Error("credential write failed"));
    await expect(
      createGarminAuthSetup(fetchFn).revokeExistingTokens?.(authorization(new Date(0)), persist),
    ).rejects.toThrow("credential write failed");
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("requires durable persistence before consuming an expired token's refresh credential", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    await expect(
      createGarminAuthSetup(fetchFn).revokeExistingTokens?.(authorization(new Date(0))),
    ).rejects.toThrow("durable credential persistence");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("rejects an expired token without refresh credentials", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    await expect(
      createGarminAuthSetup(fetchFn).revokeExistingTokens?.(
        {
          ...authorization(new Date(0)),
          refreshToken: null,
        },
        vi.fn(),
      ),
    ).rejects.toThrow("refresh");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each(["revokeExistingTokens", "revokeTokensForAccountErasure"] as const)(
    "%s propagates invalid_grant instead of treating it as registration deletion",
    async (hook) => {
      const fetchFn = vi
        .fn<typeof fetch>()
        .mockResolvedValue(Response.json({ error: "invalid_grant" }, { status: 400 }));
      const persist = vi.fn();

      await expect(
        createGarminAuthSetup(fetchFn)[hook]?.(authorization(new Date(0)), persist),
      ).rejects.toThrow("invalid_grant");

      expect(fetchFn).toHaveBeenCalledOnce();
      expect(fetchFn.mock.calls[0]?.[0]).toBe(TOKEN_URL);
      expect(persist).not.toHaveBeenCalled();
    },
  );

  it("requires reconnect for legacy private credentials before using official endpoints", async () => {
    const fetchFn = vi.fn<typeof fetch>();
    const tokens = authorization();
    delete tokens.providerAccountId;
    await expect(
      createGarminAuthSetup(fetchFn).revokeExistingTokens?.(tokens, vi.fn()),
    ).rejects.toThrow("reconnect");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("can revoke a newly minted official grant when stable identity setup fails", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(Response.json({}))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const setup = createGarminAuthSetup(fetchFn);
    let issued: TokenSet | undefined;
    await expect(
      setup.exchangeCode?.("code", "verifier", (tokens) => {
        issued = tokens;
      }),
    ).rejects.toThrow();
    if (!issued) throw new Error("Token issuance was not reported");
    await expect(setup.revokeExistingTokens?.(issued, vi.fn())).resolves.toBeUndefined();
    expect(fetchFn.mock.calls[2]?.[0]).toBe(`${API_BASE}/user/registration`);
  });
});
