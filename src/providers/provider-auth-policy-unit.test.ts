import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkPerUserAuthCompliance,
  isImportOnlyProvider,
  requiresPerUserConnect,
} from "./provider-auth-policy.ts";
import type { Provider, ProviderAuthSetup } from "./types.ts";

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
  it("only exempts internal providers", () => {
    expect(requiresPerUserConnect("ultrahuman")).toBe(true);
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

  it("rejects when auth setup has no connect flow", () => {
    const provider = stubProvider({
      id: "no-flow-provider",
      name: "No Flow",
      authSetup: (): ProviderAuthSetup => ({}),
    });
    expect(checkPerUserAuthCompliance(provider)).toEqual({
      ok: false,
      providerId: "no-flow-provider",
      reason: expect.stringContaining('authType is "none"'),
    });
  });

  it("rejects OAuth providers without an exchangeCode handler", () => {
    const provider = stubProvider({
      id: "oauth-without-exchange-provider",
      name: "OAuth Without Exchange",
      authSetup: () => ({
        oauthConfig: {
          clientId: "client-id",
          clientSecret: "client-secret",
          redirectUri: "https://example.com/callback",
          authorizeUrl: "https://example.com/authorize",
          tokenUrl: "https://example.com/token",
          scopes: ["read"],
        },
      }),
    });
    expect(checkPerUserAuthCompliance(provider)).toEqual({
      ok: false,
      providerId: "oauth-without-exchange-provider",
      reason: expect.stringContaining('authType is "none"'),
    });
  });

  it("accepts credential providers with automatedLogin only", () => {
    const provider = stubProvider({
      id: "credential-provider",
      name: "Credential",
      authSetup: () => ({
        automatedLogin: async () => ({
          accessToken: "token",
          refreshToken: null,
          expiresAt: new Date(),
          scopes: null,
        }),
      }),
    });
    expect(checkPerUserAuthCompliance(provider)).toEqual({ ok: true });
  });

  it("accepts providers with a per-user manual token flow", () => {
    const provider = stubProvider({
      id: "token-provider",
      name: "Token Provider",
      authSetup: () => ({
        manualToken: {
          label: "Personal API token",
          instructionsUrl: "https://example.com/settings/token",
          exchangeToken: async () => ({
            accessToken: "token",
            refreshToken: null,
            expiresAt: new Date(),
            scopes: "read",
          }),
        },
      }),
    });
    expect(checkPerUserAuthCompliance(provider)).toEqual({ ok: true });
  });
});
