import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureException: vi.fn(),
  revokeToken: vi.fn(),
}));

vi.mock("@sentry/node", () => ({
  captureException: mocks.captureException,
}));

vi.mock("dofek/auth/oauth", () => ({
  revokeToken: mocks.revokeToken,
}));

import { revokeProviderCredentials } from "./provider-credential-revocation.ts";

const tokens = {
  accessToken: "access-token",
  refreshToken: "refresh-token",
  expiresAt: new Date("2027-01-01"),
  scopes: "read",
};
const onTokensRefreshed = vi.fn();

describe("revokeProviderCredentials", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.revokeToken.mockResolvedValue(undefined);
  });

  it("uses an authoritative provider-specific revoker", async () => {
    const revokeExistingTokens = vi.fn().mockResolvedValue(undefined);

    await revokeProviderCredentials({
      oauthConfig: { revokeUrl: "https://provider.example/revoke" },
      providerId: "wahoo",
      revokeExistingTokens,
      tokens,
      onTokensRefreshed,
    });

    expect(revokeExistingTokens).toHaveBeenCalledWith(tokens, onTokensRefreshed);
    expect(mocks.revokeToken).not.toHaveBeenCalled();
  });

  it("propagates an authoritative custom failure without forgetting its credentials", async () => {
    const customError = new Error("custom revocation unavailable");

    await expect(
      revokeProviderCredentials({
        oauthConfig: { revokeUrl: "https://provider.example/revoke" },
        providerId: "wahoo",
        revokeExistingTokens: vi.fn().mockRejectedValue(customError),
        tokens,
        onTokensRefreshed,
      }),
    ).rejects.toThrow(customError);

    expect(mocks.captureException).toHaveBeenCalledWith(
      customError,
      expect.objectContaining({
        tags: expect.objectContaining({ providerId: "wahoo" }),
      }),
    );
    expect(mocks.revokeToken).not.toHaveBeenCalled();
  });

  it("fails explicitly when the provider has no revocation policy", async () => {
    await expect(
      revokeProviderCredentials({
        oauthConfig: {},
        providerId: "provider-without-revocation",
        tokens,
        onTokensRefreshed,
      }),
    ).rejects.toThrow("Provider provider-without-revocation has no credential revocation policy");
  });

  it("attempts every token and reports an aggregate failure", async () => {
    const accessError = new Error("access revocation failed");
    mocks.revokeToken.mockRejectedValueOnce(accessError).mockResolvedValueOnce(undefined);

    await expect(
      revokeProviderCredentials({
        oauthConfig: { revokeUrl: "https://provider.example/revoke" },
        providerId: "strava",
        tokens,
        onTokensRefreshed,
      }),
    ).rejects.toThrow("Failed to revoke strava credentials");

    expect(mocks.revokeToken).toHaveBeenCalledTimes(2);
    expect(mocks.captureException).toHaveBeenCalledWith(
      accessError,
      expect.objectContaining({
        tags: expect.objectContaining({
          providerId: "strava",
          tokenType: "access",
        }),
      }),
    );
  });
});
