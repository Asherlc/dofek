import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkPerUserAuthCompliance,
  isImportOnlyProvider,
  LEGACY_SERVER_SIDE_USER_AUTH_PROVIDER_IDS,
  requiresPerUserConnect,
} from "./provider-auth-policy.ts";
import type { Provider, ProviderAuthSetup } from "./types.ts";
import * as providerTypes from "./types.ts";

const dummyOAuthConfig = {
  clientId: "client",
  clientSecret: "secret",
  authorizeUrl: "https://example.com/auth",
  tokenUrl: "https://example.com/token",
  redirectUri: "https://example.com/callback",
  scopes: ["read"],
};

function stubProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: "test",
    name: "Test",
    validate: () => null,
    sync: async () => ({ provider: "test", recordsSynced: 0, errors: [], duration: 0 }),
    ...overrides,
  };
}

describe("requiresPerUserConnect", () => {
  it("exempts legacy and internal providers", () => {
    expect(requiresPerUserConnect("ultrahuman")).toBe(false);
    expect(requiresPerUserConnect("auto-supplements")).toBe(false);
    expect(requiresPerUserConnect("amazfit-zepp")).toBe(true);
  });
});

describe("isImportOnlyProvider", () => {
  it("detects import-only providers", () => {
    expect(
      isImportOnlyProvider(
        stubProvider({ id: "strong-csv", name: "Strong", importOnly: true as const }),
      ),
    ).toBe(true);
    expect(isImportOnlyProvider(stubProvider({ id: "strava", name: "Strava" }))).toBe(false);
  });
});

describe("checkPerUserAuthCompliance", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("accepts import-only providers without authSetup", () => {
    const provider = stubProvider({ id: "strong-csv", name: "Strong", importOnly: true as const });
    expect(checkPerUserAuthCompliance(provider)).toEqual({ ok: true });
  });

  it("accepts legacy server-side providers without authSetup", () => {
    const provider = stubProvider({ id: "ultrahuman", name: "Ultrahuman" });
    expect(checkPerUserAuthCompliance(provider)).toEqual({ ok: true });
  });

  it("accepts internal providers without authSetup", () => {
    const provider = stubProvider({ id: "auto-supplements", name: "Auto Supplements" });
    expect(checkPerUserAuthCompliance(provider)).toEqual({ ok: true });
  });

  it("rejects sync providers without authSetup", () => {
    const provider = stubProvider({ id: "new-provider", name: "New Provider" });
    expect(checkPerUserAuthCompliance(provider)).toEqual({
      ok: false,
      providerId: "new-provider",
      reason: expect.stringContaining("missing authSetup()"),
    });
  });

  it("rejects when authSetup throws", () => {
    const provider = stubProvider({
      id: "broken-provider",
      name: "Broken",
      authSetup: () => {
        throw new Error("missing client id");
      },
    });
    expect(checkPerUserAuthCompliance(provider)).toEqual({
      ok: false,
      providerId: "broken-provider",
      reason: "authSetup() threw: missing client id",
    });
  });

  it("rejects when authSetup returns undefined", () => {
    const provider = stubProvider({
      id: "unconfigured-provider",
      name: "Unconfigured",
      authSetup: () => undefined,
    });
    expect(checkPerUserAuthCompliance(provider)).toEqual({
      ok: false,
      providerId: "unconfigured-provider",
      reason: expect.stringContaining("returned undefined"),
    });
  });

  it("rejects when authType is none", () => {
    vi.spyOn(providerTypes, "getProviderAuthType").mockReturnValue("none");
    const provider = stubProvider({
      id: "no-flow-provider",
      name: "No Flow",
      authSetup: (): ProviderAuthSetup => ({
        oauthConfig: dummyOAuthConfig,
        exchangeCode: async () => ({
          accessToken: "token",
          refreshToken: null,
          expiresAt: new Date(),
          scopes: null,
        }),
      }),
    });
    expect(checkPerUserAuthCompliance(provider)).toEqual({
      ok: false,
      providerId: "no-flow-provider",
      reason: expect.stringContaining('authType is "none"'),
    });
  });

  it("accepts credential providers with automatedLogin", () => {
    const provider = stubProvider({
      id: "credential-provider",
      name: "Credential",
      authSetup: () => ({
        oauthConfig: dummyOAuthConfig,
        automatedLogin: async () => ({
          accessToken: "token",
          refreshToken: null,
          expiresAt: new Date(),
          scopes: null,
        }),
        exchangeCode: async () => {
          throw new Error("not supported");
        },
      }),
    });
    expect(checkPerUserAuthCompliance(provider)).toEqual({ ok: true });
  });
});

describe("LEGACY_SERVER_SIDE_USER_AUTH_PROVIDER_IDS", () => {
  it("only grandfathered ultrahuman", () => {
    expect([...LEGACY_SERVER_SIDE_USER_AUTH_PROVIDER_IDS]).toEqual(["ultrahuman"]);
  });
});
