import { createRateLimitAwareFetch } from "@dofek/provider-http/rate-limit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AmazfitZeppProvider,
  decodeZeppUserIdFromScopes,
  encodeZeppTokenScopes,
} from "./amazfit-zepp.ts";

vi.mock("@dofek/provider-http/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dofek/provider-http/rate-limit")>();
  return {
    ...actual,
    createRateLimitAwareFetch: vi.fn(actual.createRateLimitAwareFetch),
  };
});

function mockZeppLoginFetch(
  tokenInfo: { app_token: string; user_id: string; login_token?: string } = {
    app_token: "app-token-456",
    user_id: "987654321",
    login_token: "login-token-789",
  },
): typeof globalThis.fetch {
  return async (input) => {
    const url = String(input);
    if (url.includes("/registrations/")) {
      return new Response(null, {
        status: 302,
        headers: {
          Location:
            "https://s3-us-west-2.amazonaws.com/hm-registration/successsignin.html?access=access-code&country_code=US",
        },
      });
    }
    return new Response(JSON.stringify({ token_info: tokenInfo }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
}

describe("Zepp token scopes", () => {
  it("round-trips zepp user id through JSON scopes", () => {
    const scopes = encodeZeppTokenScopes("987654321");
    expect(scopes).toBe('{"zeppUserId":"987654321"}');
    expect(decodeZeppUserIdFromScopes(scopes)).toBe("987654321");
  });

  it("falls back to legacy userId: scopes", () => {
    expect(decodeZeppUserIdFromScopes("userId:legacy-user")).toBe("legacy-user");
  });

  it("returns null for missing scopes", () => {
    expect(decodeZeppUserIdFromScopes(null)).toBeNull();
    expect(decodeZeppUserIdFromScopes(undefined)).toBeNull();
    expect(decodeZeppUserIdFromScopes("")).toBeNull();
  });

  it("returns null when JSON scopes omit zeppUserId", () => {
    expect(decodeZeppUserIdFromScopes('{"other":"value"}')).toBeNull();
  });

  it("returns null when zeppUserId is not a string", () => {
    expect(decodeZeppUserIdFromScopes('{"zeppUserId":123}')).toBeNull();
  });

  it("returns null when zeppUserId is empty", () => {
    expect(decodeZeppUserIdFromScopes('{"zeppUserId":""}')).toBeNull();
  });

  it("returns null for JSON null literal scopes", () => {
    expect(decodeZeppUserIdFromScopes("null")).toBeNull();
  });

  it("returns null for non-object JSON scopes", () => {
    expect(decodeZeppUserIdFromScopes('"hello"')).toBeNull();
    expect(decodeZeppUserIdFromScopes("42")).toBeNull();
  });

  it("requires exact legacy userId: prefix match", () => {
    expect(decodeZeppUserIdFromScopes("prefix userId:legacy-user")).toBeNull();
    expect(decodeZeppUserIdFromScopes("userId:legacy-user suffix")).toBeNull();
  });

  it("returns null for unrelated scope strings", () => {
    expect(decodeZeppUserIdFromScopes("oauth:google")).toBeNull();
  });
});

describe("AmazfitZeppProvider auth", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("wraps fetch with amazfit-zepp rate limit config", () => {
    new AmazfitZeppProvider();
    expect(createRateLimitAwareFetch).toHaveBeenCalledWith(expect.any(Function), {
      providerId: "amazfit-zepp",
    });
  });

  it("authSetup returns credential configuration", () => {
    const setup = new AmazfitZeppProvider().authSetup();
    expect(setup.oauthConfig).toBeUndefined();
    expect(setup.exchangeCode).toBeUndefined();
    expect(setup.apiBaseUrl).toContain("zepp.com");
    expect(setup.automatedLogin).toBeTypeOf("function");
  });

  it("automatedLogin stores tokens with structured scopes and one-year expiry", async () => {
    const before = Date.now();
    const setup = new AmazfitZeppProvider(mockZeppLoginFetch()).authSetup();
    const tokens = await setup.automatedLogin?.("user@example.com", "password123");
    const after = Date.now();

    expect(tokens).toEqual({
      accessToken: "app-token-456",
      refreshToken: "login-token-789",
      expiresAt: expect.any(Date),
      scopes: encodeZeppTokenScopes("987654321"),
    });
    expect(tokens?.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 364 * 24 * 60 * 60 * 1000);
    expect(tokens?.expiresAt.getTime()).toBeLessThanOrEqual(after + 366 * 24 * 60 * 60 * 1000);
  });
});
