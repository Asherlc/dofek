import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderAuthorizationFailedError } from "../auth-errors.ts";
import {
  createTrailforksAuthSetup,
  TRAILFORKS_MCP_RESOURCE,
  trailforksOAuthConfig,
  validateTrailforksAuthConfiguration,
} from "./auth.ts";

describe("Trailforks OAuth configuration", () => {
  beforeEach(() => {
    vi.stubEnv("TRAILFORKS_CLIENT_ID", "trailforks-public-client-id");
    vi.stubEnv("OAUTH_REDIRECT_URI", "https://dofek.example.com/callback");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds the public-client PKCE config from TRAILFORKS_CLIENT_ID", () => {
    const config = trailforksOAuthConfig();

    expect(config).toEqual({
      clientId: "trailforks-public-client-id",
      authorizeUrl: "https://www.trailforks.com/mcp/oauth/authorize/",
      tokenUrl: "https://www.trailforks.com/mcp/oauth/token/",
      revokeUrl: "https://www.trailforks.com/mcp/oauth/revoke/",
      redirectUri: "https://dofek.example.com/callback",
      scopes: ["activities:read"],
      usePkce: true,
      resource: TRAILFORKS_MCP_RESOURCE,
    });
  });

  it("uses the shared host-derived callback URL when a host is provided", () => {
    const config = trailforksOAuthConfig({ host: "app.dofek.example.com" });

    expect(config?.redirectUri).toBe("https://app.dofek.example.com/callback");
  });

  it("returns undefined when TRAILFORKS_CLIENT_ID is missing", () => {
    delete process.env.TRAILFORKS_CLIENT_ID;

    expect(validateTrailforksAuthConfiguration()).toBe("TRAILFORKS_CLIENT_ID is not set");
    expect(trailforksOAuthConfig()).toBeUndefined();
    expect(createTrailforksAuthSetup()).toBeUndefined();
  });

  it("requires the callback PKCE verifier before contacting the token endpoint", async () => {
    const fetchFn = vi.fn<typeof globalThis.fetch>();
    const setup = createTrailforksAuthSetup(undefined, fetchFn);
    if (!setup?.exchangeCode) throw new Error("Expected Trailforks exchangeCode");

    await expect(setup.exchangeCode("authorization-code")).rejects.toThrow(
      "Trailforks OAuth code exchange requires a PKCE verifier",
    );
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("sanitizes token exchange failures without attaching the remote body", async () => {
    const remoteBodyMarker = "REMOTE_BODY_MARKER_private_activity_payload";
    const fetchFn = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(remoteBodyMarker, { status: 400 }));
    const setup = createTrailforksAuthSetup(undefined, fetchFn);
    if (!setup?.exchangeCode) throw new Error("Expected Trailforks exchangeCode");

    let caught: unknown;
    try {
      await setup.exchangeCode("authorization-code", "pkce-verifier");
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ProviderAuthorizationFailedError);
    expect(caught).toMatchObject({
      authFailureReason: "authorization_failed",
      message: "Trailforks authorization failed.",
    });
    expect(String(caught)).not.toContain(remoteBodyMarker);
    expect(caught instanceof Error ? caught.cause : undefined).toBeUndefined();
    expect(fetchFn).toHaveBeenCalledOnce();
  });
});
