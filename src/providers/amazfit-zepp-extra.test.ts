import { createRateLimitAwareFetch } from "@dofek/provider-http/rate-limit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AmazfitZeppProvider } from "./amazfit-zepp.ts";

vi.mock("@dofek/provider-http/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dofek/provider-http/rate-limit")>();
  return {
    ...actual,
    createRateLimitAwareFetch: vi.fn(actual.createRateLimitAwareFetch),
  };
});

describe("AmazfitZeppProvider auth extras", () => {
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
    expect(setup.oauthConfig.clientId).toBe("com.xiaomi.hm.health");
    expect(setup.apiBaseUrl).toContain("zepp.com");
    expect(setup.automatedLogin).toBeTypeOf("function");
  });

  it("authSetup.exchangeCode throws", async () => {
    const setup = new AmazfitZeppProvider().authSetup();
    await expect(setup.exchangeCode("code")).rejects.toThrow("automated login");
  });

  it("automatedLogin stores a one-year token expiry", async () => {
    const fetchFn: typeof globalThis.fetch = async (input) => {
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
      return new Response(
        JSON.stringify({
          token_info: {
            app_token: "app-token",
            user_id: "123",
            login_token: "login-token",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };

    const before = Date.now();
    const tokens = await new AmazfitZeppProvider(fetchFn)
      .authSetup()
      .automatedLogin?.("user@example.com", "password");
    const after = Date.now();

    expect(tokens?.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 364 * 24 * 60 * 60 * 1000);
    expect(tokens?.expiresAt.getTime()).toBeLessThanOrEqual(after + 366 * 24 * 60 * 60 * 1000);
    expect(tokens?.scopes).toBe("userId:123");
  });
});
