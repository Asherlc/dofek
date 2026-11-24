import {
  ProviderRateLimitError,
  ProviderRequestTimeoutError,
  ProviderServiceUnavailableError,
} from "@dofek/provider-http/rate-limit";
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

  it("classifies confirmed invalid_grant on 400 as authorization failure without remote details", async () => {
    const remoteBodyMarker = "REMOTE_BODY_MARKER_private_activity_payload";
    const fetchFn = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json(
        {
          error: "invalid_grant",
          error_description: remoteBodyMarker,
          private_cause: remoteBodyMarker,
        },
        { status: 400 },
      ),
    );
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

  it("treats an ambiguous 400 token response as a safe generic exchange failure", async () => {
    const remoteBodyMarker = "REMOTE_BODY_MARKER_ambiguous_400_payload";
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

    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(ProviderAuthorizationFailedError);
    expect(caught).not.toBeInstanceOf(ProviderServiceUnavailableError);
    expect(caught).toMatchObject({ message: "Trailforks token exchange failed." });
    expect(String(caught)).not.toContain(remoteBodyMarker);
    expect(caught instanceof Error ? caught.cause : undefined).toBeUndefined();
  });

  it("maps a direct 503 token response to a sanitized service outage", async () => {
    const remoteBodyMarker = "REMOTE_BODY_MARKER_503_payload";
    const fetchFn = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(new Response(remoteBodyMarker, { status: 503 }));
    const setup = createTrailforksAuthSetup(undefined, fetchFn);
    if (!setup?.exchangeCode) throw new Error("Expected Trailforks exchangeCode");

    let caught: unknown;
    try {
      await setup.exchangeCode("authorization-code", "pkce-verifier");
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ProviderServiceUnavailableError);
    expect(caught).toMatchObject({
      providerId: "trailforks",
      statusCode: 503,
      message: "Trailforks is temporarily unavailable (503). Try again.",
      responseBody: "",
    });
    expect(String(caught)).not.toContain(remoteBodyMarker);
    expect(caught instanceof Error ? caught.cause : undefined).toBeUndefined();
  });

  it("maps a fetch rejection without HTTP status to a fixed cause-free transport error", async () => {
    const remoteBodyMarker = "REMOTE_BODY_MARKER_network_rejection";
    const fetchFn = vi
      .fn<typeof globalThis.fetch>()
      .mockRejectedValue(new Error(`socket hang up: ${remoteBodyMarker}`));
    const setup = createTrailforksAuthSetup(undefined, fetchFn);
    if (!setup?.exchangeCode) throw new Error("Expected Trailforks exchangeCode");

    let caught: unknown;
    try {
      await setup.exchangeCode("authorization-code", "pkce-verifier");
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(ProviderServiceUnavailableError);
    expect(caught).not.toBeInstanceOf(ProviderAuthorizationFailedError);
    expect(caught).toMatchObject({
      name: "TrailforksTokenTransportError",
      message: "Trailforks is temporarily unavailable. Try again.",
    });
    expect(String(caught)).not.toContain(remoteBodyMarker);
    expect(caught instanceof Error ? caught.cause : undefined).toBeUndefined();
  });

  it("returns tokens from a successful token exchange", async () => {
    const fetchFn = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({
        access_token: "tf-access",
        refresh_token: "tf-refresh",
        expires_in: 3600,
        token_type: "Bearer",
      }),
    );
    const setup = createTrailforksAuthSetup(undefined, fetchFn);
    if (!setup?.exchangeCode) throw new Error("Expected Trailforks exchangeCode");

    const tokens = await setup.exchangeCode("authorization-code", "pkce-verifier");

    expect(tokens).toMatchObject({
      accessToken: "tf-access",
      refreshToken: "tf-refresh",
    });
    expect(tokens.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(fetchFn).toHaveBeenCalledOnce();
  });

  it("preserves sanitized typed rate-limit, timeout, and service outages from the injected fetch", async () => {
    const privateMarker = "PRIVATE_TRANSPORT_BODY";
    const cases = [
      new ProviderRateLimitError({
        providerId: "trailforks",
        statusCode: 429,
        message: privateMarker,
        responseBody: privateMarker,
        retryAfterSeconds: 12,
      }),
      new ProviderRequestTimeoutError({
        providerId: "trailforks",
        timeoutMs: 1_000,
        cause: new Error(privateMarker),
      }),
      new ProviderServiceUnavailableError({
        providerId: "trailforks",
        statusCode: 503,
        message: privateMarker,
        responseBody: privateMarker,
        retryAfterSeconds: 9,
      }),
    ] as const;

    for (const injected of cases) {
      const fetchFn = vi.fn<typeof globalThis.fetch>().mockRejectedValue(injected);
      const setup = createTrailforksAuthSetup(undefined, fetchFn);
      if (!setup?.exchangeCode) throw new Error("Expected Trailforks exchangeCode");

      let caught: unknown;
      try {
        await setup.exchangeCode("authorization-code", "pkce-verifier");
      } catch (error: unknown) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(injected.constructor);
      expect(caught).not.toBe(injected);
      expect(caught).not.toBeInstanceOf(ProviderAuthorizationFailedError);
      expect(String(caught)).not.toContain(privateMarker);
      expect(caught instanceof Error ? caught.cause : undefined).toBeUndefined();
      if (caught instanceof ProviderRateLimitError) {
        expect(caught).toMatchObject({
          responseBody: "",
          retryAfterSeconds: 12,
          message: "Trailforks rate limit exceeded.",
        });
      }
      if (caught instanceof ProviderRequestTimeoutError) {
        expect(caught).toMatchObject({ timeoutMs: 1_000 });
      }
      if (caught instanceof ProviderServiceUnavailableError) {
        expect(caught).toMatchObject({
          statusCode: 503,
          responseBody: "",
          retryAfterSeconds: 9,
          message: "Trailforks is temporarily unavailable (503). Try again.",
        });
      }
    }
  });
});
