import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureException: vi.fn(),
  markMcpConnectedAppUsed: vi.fn(),
  validateMcpToken: vi.fn(),
}));
vi.mock("dofek/lib/error-reporting", () => ({ captureException: mocks.captureException }));
vi.mock("./token-repository.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./token-repository.ts")>()),
  markMcpConnectedAppUsed: mocks.markMcpConnectedAppUsed,
  validateMcpToken: mocks.validateMcpToken,
}));

import {
  isPersonalAccessToken,
  PERSONAL_TOKEN_PREFIX,
  verifyMcpAccessToken,
} from "./access-token-verifier.ts";

const resourceUrl = "https://app.example.test/api/mcp";
const find = vi.fn();
const options = {
  db: { execute: vi.fn() },
  provider: { AccessToken: { find } },
  resourceUrl,
};
const token = {
  accountId: "user-id",
  clientId: "oauth-client",
  jti: "access-token-id",
  grantId: "grant-id",
  scope: "health:read activity:read",
  aud: resourceUrl,
  exp: Math.floor(Date.now() / 1000) + 3600,
};
describe("verifyMcpAccessToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    find.mockResolvedValue(token);
    mocks.markMcpConnectedAppUsed.mockResolvedValue(true);
  });
  it("recognizes personal tokens and validates them through the repository", async () => {
    expect(isPersonalAccessToken(`${PERSONAL_TOKEN_PREFIX}secret`)).toBe(true);
    expect(isPersonalAccessToken("opaque-oauth-token")).toBe(false);
    mocks.validateMcpToken.mockResolvedValue({
      userId: "user-id",
      tokenId: "personal-id",
      scopes: ["health:read"],
      expiresAt: null,
    });
    await expect(verifyMcpAccessToken(`${PERSONAL_TOKEN_PREFIX}secret`, options)).resolves.toEqual({
      kind: "personal_token",
      userId: "user-id",
      tokenId: "personal-id",
      scopes: ["health:read"],
      expiresAt: null,
    });
    expect(mocks.validateMcpToken).toHaveBeenCalledWith(
      options.db,
      `${PERSONAL_TOKEN_PREFIX}secret`,
    );
    expect(find).not.toHaveBeenCalled();
  });
  it("accepts a library-validated opaque OAuth token for this resource", async () => {
    await expect(verifyMcpAccessToken("opaque-oauth-token", options)).resolves.toEqual({
      kind: "oauth",
      tokenId: token.jti,
      userId: token.accountId,
      clientId: token.clientId,
      scopes: ["health:read", "activity:read"],
      expiresAt: new Date(token.exp * 1000).toISOString(),
    });
    expect(find).toHaveBeenCalledWith("opaque-oauth-token");
    expect(mocks.markMcpConnectedAppUsed).toHaveBeenCalledWith(
      options.db,
      createHash("sha256").update(token.jti).digest("hex"),
    );
  });
  it("rejects unknown or expired tokens rejected by the library", async () => {
    find.mockResolvedValue(undefined);
    await expect(verifyMcpAccessToken("unknown-token", options)).resolves.toBeNull();
    expect(mocks.markMcpConnectedAppUsed).not.toHaveBeenCalled();
  });
  it("rejects a token whose grant was revoked", async () => {
    mocks.markMcpConnectedAppUsed.mockResolvedValue(false);
    await expect(verifyMcpAccessToken("opaque-oauth-token", options)).resolves.toBeNull();
  });
  it.each([
    { aud: "https://other.example.test/api/mcp" },
    { scope: "health:read unknown:scope" },
    { accountId: undefined },
    { clientId: undefined },
    { jti: undefined },
    { exp: undefined },
  ])("rejects invalid principal or audience data: %j", async (changes) => {
    find.mockResolvedValue({ ...token, ...changes });
    await expect(verifyMcpAccessToken("opaque-oauth-token", options)).resolves.toBeNull();
    expect(mocks.markMcpConnectedAppUsed).not.toHaveBeenCalled();
  });
  it("reports and propagates unexpected library failures", async () => {
    const failure = new Error("database unavailable");
    find.mockRejectedValue(failure);
    await expect(verifyMcpAccessToken("opaque-oauth-token", options)).rejects.toBe(failure);
    expect(mocks.captureException).toHaveBeenCalledWith(failure, {
      tags: { source: "mcp-access-token-verification" },
    });
  });
});
