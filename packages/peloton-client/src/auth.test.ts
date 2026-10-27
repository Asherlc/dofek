import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  createPelotonAuthorization,
  exchangePelotonAuthorizationCode,
  parseAuth0FormHtml,
  pelotonAutomatedLogin,
  pelotonOAuthConfig,
  refreshPelotonAccessToken,
} from "./auth.ts";
import { PelotonAuthFlowError, PelotonResponseError } from "./errors.ts";

function injectedConfig(extraParams: object = { state: "state", _csrf: "csrf" }): string {
  return Buffer.from(JSON.stringify({ extraParams })).toString("base64");
}

function loginPage(config = injectedConfig()): string {
  return `<script>window.injectedConfig=window.atob("${config}")</script>`;
}

function loginForm(): string {
  return `
    <form action="https://auth.onepeloton.com/login/callback">
      <input type="hidden" name="wresult" value="&#34;signed&#34;" />
    </form>
  `;
}

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
    expect(url.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(authorization.codeVerifier).digest("base64url"),
    );
    expect(url.searchParams.has("state")).toBe(false);
    expect(url.searchParams.has("nonce")).toBe(false);
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
    expect(new Headers(init?.headers).get("Content-Type")).toBe(
      "application/x-www-form-urlencoded",
    );
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

  it("preserves token failure diagnostics", async () => {
    const fetchFn: typeof globalThis.fetch = async () =>
      new Response("invalid grant", { status: 400 });

    const error = await refreshPelotonAccessToken("refresh", fetchFn).catch(
      (cause: unknown) => cause,
    );
    expect(error).toBeInstanceOf(PelotonAuthFlowError);
    expect(error).toMatchObject({
      stage: "token",
      statusCode: 400,
      responseBody: "invalid grant",
    });
  });

  it("tags token rate limits with the Peloton provider", async () => {
    const error = await refreshPelotonAccessToken(
      "refresh",
      async () => new Response("slow down", { status: 429 }),
    ).catch((cause: unknown) => cause);

    expect(error).toMatchObject({ providerId: "peloton", statusCode: 429 });
  });

  it("retains the old refresh token and null scope when omitted", async () => {
    const fetchFn: typeof globalThis.fetch = async () =>
      Response.json({ access_token: "access", expires_in: 60 });

    const tokens = await refreshPelotonAccessToken("old-refresh", fetchFn);
    expect(tokens.refreshToken).toBe("old-refresh");
    expect(tokens.scopes).toBeNull();
    expect(tokens.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });
});

describe("parseAuth0FormHtml", () => {
  it("extracts hidden fields regardless of attribute order", () => {
    const form = parseAuth0FormHtml(`
      <form method="POST" action="https://auth.onepeloton.com/login/callback">
        <input type="hidden" value="ignored-without-name" />
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

  it("rejects a response without a form action", () => {
    expect(() => parseAuth0FormHtml("<form></form>")).toThrow(PelotonAuthFlowError);
  });

  it("uses an empty value for hidden inputs without a value", () => {
    expect(
      parseAuth0FormHtml('<form action="/callback"><input type="hidden" name="state"></form>'),
    ).toEqual({ action: "/callback", fields: { state: "" } });
  });
});

describe("pelotonAutomatedLogin", () => {
  it("completes the observed Auth0 form and callback flow", async () => {
    const encodedConfig = injectedConfig({ state: "state", _csrf: "csrf", nonce: "nonce" });
    const fetchFn = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/authorize") || url.includes("/authorize?")) {
        return new Response(
          `<script>window.injectedConfig = window.atob("${encodedConfig}")</script>`,
        );
      }
      if (url.endsWith("/usernamepassword/login")) {
        expect(init?.body).toContain('"username":"rider@example.com"');
        expect(init?.body).toContain('"nonce":"nonce"');
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

  it("follows redirects, forwards cookies, and preserves request headers", async () => {
    let authorizeCalls = 0;
    const fetchFn = vi.fn<typeof globalThis.fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes("/authorize")) {
        const authorizeUrl = new URL(url);
        expect(authorizeUrl.searchParams.get("state")).toBeTruthy();
        expect(authorizeUrl.searchParams.get("nonce")).toBeTruthy();
        authorizeCalls++;
        if (authorizeCalls === 1) {
          return new Response(null, {
            status: 302,
            headers: { Location: "/continue", "Set-Cookie": "session=abc; Path=/" },
          });
        }
      }
      if (url.endsWith("/continue")) {
        expect(new Headers(init?.headers).get("Cookie")).toContain("session=abc");
        return new Response(loginPage());
      }
      if (url.endsWith("/usernamepassword/login")) {
        expect(new Headers(init?.headers).get("Content-Type")).toBe("application/json");
        return new Response(loginForm());
      }
      if (url.endsWith("/login/callback")) {
        expect(new Headers(init?.headers).get("Content-Type")).toBe(
          "application/x-www-form-urlencoded",
        );
        return new Response(null, {
          status: 302,
          headers: { Location: "/callback-step" },
        });
      }
      if (url.endsWith("/callback-step")) {
        return new Response(null, {
          status: 302,
          headers: { Location: `${pelotonOAuthConfig().redirectUri}?code=code` },
        });
      }
      if (url.endsWith("/oauth/token")) {
        return Response.json({ access_token: "access", expires_in: 60 });
      }
      return new Response("unexpected", { status: 500 });
    });

    await expect(pelotonAutomatedLogin("user", "password", fetchFn)).resolves.toMatchObject({
      accessToken: "access",
    });
  });

  it("rejects missing and malformed injected configuration", async () => {
    await expect(
      pelotonAutomatedLogin("user", "password", async () => new Response("<html></html>")),
    ).rejects.toMatchObject({ stage: "authorize" });

    await expect(
      pelotonAutomatedLogin("user", "password", async () => new Response(loginPage("bad-base64"))),
    ).rejects.toBeInstanceOf(PelotonResponseError);
  });

  it("preserves credential rejection diagnostics", async () => {
    const fetchFn: typeof globalThis.fetch = async (input) =>
      String(input).includes("/authorize")
        ? new Response(loginPage())
        : new Response("wrong password", { status: 401 });

    await expect(pelotonAutomatedLogin("user", "bad", fetchFn)).rejects.toMatchObject({
      stage: "credentials",
      statusCode: 401,
      responseBody: "wrong password",
    });
  });

  it.each([
    [null, "Auth0 redirect chain ended without a Location header"],
    ["?error=access_denied&error_description=Denied", "Auth0 returned error: Denied"],
    ["?state=code=", "Authorization code not found in callback URL"],
  ])("rejects invalid callback %s", async (callbackSuffix, message) => {
    const fetchFn: typeof globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.includes("/authorize")) return new Response(loginPage());
      if (url.endsWith("/usernamepassword/login")) return new Response(loginForm());
      if (url.endsWith("/login/callback")) {
        return new Response(null, {
          status: 302,
          headers: callbackSuffix
            ? { Location: `${pelotonOAuthConfig().redirectUri}${callbackSuffix}` }
            : {},
        });
      }
      return new Response("unexpected", { status: 500 });
    };

    await expect(pelotonAutomatedLogin("user", "password", fetchFn)).rejects.toThrow(message);
  });

  it("rejects an authorization redirect loop", async () => {
    const fetchFn: typeof globalThis.fetch = async () =>
      new Response(null, { status: 302, headers: { Location: "/loop" } });

    await expect(pelotonAutomatedLogin("user", "password", fetchFn)).rejects.toMatchObject({
      stage: "authorize",
    });
  });
});
