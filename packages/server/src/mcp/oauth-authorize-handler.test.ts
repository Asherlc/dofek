import type { AddressInfo } from "node:net";
import { ServerError } from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import express, { response as expressResponse, type Response } from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addIss,
  authorizationHandler,
  withIssOnCallbackRedirect,
} from "./oauth-authorize-handler.ts";

const issuer = "https://app.example.test/";
const redirectUri = "https://claude.ai/api/mcp/auth_callback";

function makeClient(): OAuthClientInformationFull {
  return {
    client_id: "client-1",
    client_name: "Claude",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "client_secret_post",
  };
}

describe("addIss", () => {
  it("appends the iss parameter to a URL string", () => {
    expect(addIss(redirectUri, issuer)).toBe(`${redirectUri}?iss=${encodeURIComponent(issuer)}`);
  });

  it("appends the iss parameter to a URL object", () => {
    expect(addIss(new URL(redirectUri), issuer)).toBe(
      `${redirectUri}?iss=${encodeURIComponent(issuer)}`,
    );
  });

  it("is idempotent when iss is already present", () => {
    const alreadyIssued = `${redirectUri}?iss=${encodeURIComponent(issuer)}`;
    expect(addIss(alreadyIssued, issuer)).toBe(alreadyIssued);
  });
});

describe("withIssOnCallbackRedirect", () => {
  function makeResponse(): { response: Response; redirect: ReturnType<typeof vi.fn> } {
    const redirect = vi.fn<(location: string) => void>();
    const response: Response = Object.create(expressResponse);
    Object.assign(response, { redirect });
    return { response, redirect };
  }

  it("appends iss to a redirect targeting the callback origin and path", () => {
    const { response, redirect } = makeResponse();
    withIssOnCallbackRedirect(response, redirectUri, issuer);

    response.redirect(`${redirectUri}?code=abc&state=s`);

    const target = String(redirect.mock.calls[0]?.[0] ?? "");
    expect(target).toContain("code=abc");
    expect(target).toContain(`iss=${encodeURIComponent(issuer)}`);
  });

  it("does not append iss to a redirect targeting a different origin", () => {
    const { response, redirect } = makeResponse();
    withIssOnCallbackRedirect(response, redirectUri, issuer);

    response.redirect("https://evil.example/callback?code=abc");

    const target = String(redirect.mock.calls[0]?.[0] ?? "");
    expect(target).not.toContain("iss=");
  });
});

describe("authorizationHandler issuer on redirects", () => {
  let server: ReturnType<import("express").Express["listen"]>;
  let baseUrl: string;

  function mount(provider: OAuthServerProvider): Promise<void> {
    const app = express();
    app.use(
      "/authorize",
      authorizationHandler({ provider, issuerUrl: new URL(issuer), rateLimit: false }),
    );
    return new Promise((resolve, reject) => {
      server = app.listen(0, () => {
        const address = server.address();
        if (address === null || typeof address !== "object") {
          reject(new Error("Server address is not an object"));
          return;
        }
        baseUrl = `http://localhost:${(address satisfies AddressInfo).port}`;
        resolve();
      });
      server.on("error", reject);
    });
  }

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (!server) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
  });

  function makeProvider(authorize: OAuthServerProvider["authorize"]): OAuthServerProvider {
    return {
      clientsStore: { getClient: async () => makeClient() },
      authorize,
      challengeForAuthorizationCode: async () => "",
      exchangeAuthorizationCode: async () => {
        throw new ServerError("unused");
      },
      exchangeRefreshToken: async () => {
        throw new ServerError("unused");
      },
      verifyAccessToken: async () => {
        throw new ServerError("unused");
      },
    };
  }

  const authorizeParameters = new URLSearchParams({
    client_id: "client-1",
    code_challenge: "challenge",
    code_challenge_method: "S256",
    redirect_uri: redirectUri,
    resource: "https://app.example.test/api/mcp",
    response_type: "code",
    scope: "health:read",
    state: "state-value",
  });

  it("includes iss on the success authorization-code redirect", async () => {
    const provider = makeProvider(async (_client, _params, response) => {
      response.redirect(`${redirectUri}?code=abc`);
    });
    await mount(provider);

    const res = await fetch(`${baseUrl}/authorize?${authorizeParameters}`, {
      redirect: "manual",
    });

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("code=abc");
    expect(location).toContain(`iss=${encodeURIComponent(issuer)}`);
  });

  it("includes iss on the deny/access_denied redirect", async () => {
    const provider = makeProvider(async (_client, _params, response) => {
      response.redirect(`${redirectUri}?error=access_denied&state=state-value`);
    });
    await mount(provider);

    const res = await fetch(`${baseUrl}/authorize?${authorizeParameters}`, {
      redirect: "manual",
    });

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("error=access_denied");
    expect(location).toContain(`iss=${encodeURIComponent(issuer)}`);
  });

  it("includes iss on validation-error redirects", async () => {
    // Invalid scope triggers a post-redirect error path in the provider.
    const provider = makeProvider(async () => {
      throw new ServerError("Internal Server Error");
    });
    await mount(provider);

    const res = await fetch(`${baseUrl}/authorize?${authorizeParameters}`, {
      redirect: "manual",
    });

    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toContain("error=");
    expect(location).toContain(`iss=${encodeURIComponent(issuer)}`);
  });
});
