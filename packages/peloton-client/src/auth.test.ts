import { describe, expect, it, vi } from "vitest";
import {
  createPelotonAuthorization,
  exchangePelotonAuthorizationCode,
  parseAuth0FormHtml,
  pelotonAutomatedLogin,
  pelotonOAuthConfig,
  refreshPelotonAccessToken,
} from "./auth.ts";
import { PelotonResponseError } from "./errors.ts";

describe("pelotonOAuthConfig", () => {
  it("describes Peloton's public PKCE client", () => {
    expect(pelotonOAuthConfig()).toEqual({
      clientId: "WVoJxVDdPoFx4RNewvvg6ch2mZ7bwnsM",
      authorizeUrl: "https://auth.onepeloton.com/authorize",
      tokenUrl: "https://auth.onepeloton.com/oauth/token",
      redirectUri: "https://members.onepeloton.com/callback",
      scopes: ["offline_access", "openid", "peloton-api.members:default"],
      usePkce: true,
      audience: "https://api.onepeloton.com/",
    });
  });
});

describe("createPelotonAuthorization", () => {
  it("returns an authorization URL and the verifier needed for exchange", () => {
    const authorization = createPelotonAuthorization();
    const url = new URL(authorization.url);

    expect(authorization.codeVerifier.length).toBeGreaterThan(40);
    expect(url.origin).toBe("https://auth.onepeloton.com");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
  });
});

describe("Peloton token lifecycle", () => {
  it("exchanges an authorization code with its PKCE verifier", async () => {
    const fetchFn = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 3600,
        scope: "openid offline_access",
      }),
    );

    const tokens = await exchangePelotonAuthorizationCode("code", "verifier", fetchFn);

    expect(tokens.accessToken).toBe("access");
    expect(tokens.refreshToken).toBe("refresh");
    expect(tokens.scopes).toBe("openid offline_access");
    const init = fetchFn.mock.calls[0]?.[1];
    expect(init?.method).toBe("POST");
    expect(String(init?.body)).toContain("grant_type=authorization_code");
    expect(String(init?.body)).toContain("code_verifier=verifier");
  });

  it("refreshes an access token and retains a rotated refresh token", async () => {
    const fetchFn = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 7200,
      }),
    );

    const tokens = await refreshPelotonAccessToken("old-refresh", fetchFn);

    expect(tokens.accessToken).toBe("new-access");
    expect(tokens.refreshToken).toBe("new-refresh");
    const init = fetchFn.mock.calls[0]?.[1];
    expect(String(init?.body)).toContain("grant_type=refresh_token");
    expect(String(init?.body)).toContain("refresh_token=old-refresh");
  });

  it("rejects malformed successful token responses", async () => {
    const fetchFn: typeof globalThis.fetch = async () => Response.json({ expires_in: 3600 });

    await expect(refreshPelotonAccessToken("refresh", fetchFn)).rejects.toBeInstanceOf(
      PelotonResponseError,
    );
  });
});

describe("parseAuth0FormHtml", () => {
  it("extracts hidden fields regardless of attribute order", () => {
    const form = parseAuth0FormHtml(`
      <form method="POST" action="https://auth.onepeloton.com/login/callback">
        <input name="first" type="hidden" value="one" />
        <input value="two" name="second" type="hidden" />
        <input name="visible" type="text" value="ignored" />
      </form>
    `);

    expect(form).toEqual({
      action: "https://auth.onepeloton.com/login/callback",
      fields: { first: "one", second: "two" },
    });
  });

  it("decodes HTML entities in the form action", () => {
    const form = parseAuth0FormHtml(`
      <form method="POST" action="/login/callback?state=one&amp;connection=peloton">
        <input name="state" type="hidden" value="one" />
      </form>
    `);

    expect(form.action).toBe("/login/callback?state=one&connection=peloton");
  });
});

describe("pelotonAutomatedLogin", () => {
  it("completes the observed Auth0 form and callback flow", async () => {
    const encodedConfig = Buffer.from(
      JSON.stringify({
        extraParams: { state: "state", _csrf: "csrf", nonce: "nonce" },
      }),
    ).toString("base64");
    const fetchFn = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/authorize") || url.includes("/authorize?")) {
        return new Response(
          `<script>window.injectedConfig = window.atob("${encodedConfig}")</script>`,
        );
      }
      if (url.endsWith("/usernamepassword/login")) {
        expect(init?.body).toContain('"username":"rider@example.com"');
        return new Response(`
          <form action="https://auth.onepeloton.com/login/callback">
            <input type="hidden" name="wresult" value="&#34;signed&#34;" />
          </form>
        `);
      }
      if (url.endsWith("/login/callback")) {
        expect(init?.body).toContain("wresult=%22signed%22");
        return new Response(null, {
          status: 302,
          headers: {
            Location: "https://members.onepeloton.com/callback?code=authorization-code",
          },
        });
      }
      if (url.endsWith("/oauth/token")) {
        expect(init?.body).toContain("code=authorization-code");
        expect(init?.body).toContain("code_verifier=");
        return Response.json({
          access_token: "access",
          refresh_token: "refresh",
          expires_in: 3600,
        });
      }
      return new Response("unexpected URL", { status: 500 });
    });

    const tokens = await pelotonAutomatedLogin("rider@example.com", "password", fetchFn);

    expect(tokens.accessToken).toBe("access");
    expect(fetchFn).toHaveBeenCalledTimes(4);
  });
});
