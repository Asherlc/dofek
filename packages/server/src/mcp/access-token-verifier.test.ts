import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { createLocalJWKSet, decodeJwt, exportJWK, generateKeyPair, SignJWT } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { captureException } = vi.hoisted(() => ({ captureException: vi.fn() }));
const tokenRepositoryMocks = vi.hoisted(() => ({
  markMcpConnectedAppUsed: vi.fn(),
  validateMcpToken: vi.fn(),
}));
vi.mock("dofek/lib/error-reporting", () => ({ captureException }));
vi.mock("./token-repository.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./token-repository.ts")>()),
  markMcpConnectedAppUsed: tokenRepositoryMocks.markMcpConnectedAppUsed,
  validateMcpToken: tokenRepositoryMocks.validateMcpToken,
}));

import {
  getSharedJwtGetKey,
  isPersonalAccessToken,
  PERSONAL_TOKEN_PREFIX,
  verifyJwtAccessToken,
  verifyMcpAccessToken,
} from "./access-token-verifier.ts";

const ISSUER = "https://app.example.test";
const RESOURCE = "https://app.example.test/api/mcp";

describe("isPersonalAccessToken", () => {
  it("recognizes Dofek personal tokens by prefix", () => {
    expect(isPersonalAccessToken(`${PERSONAL_TOKEN_PREFIX}abc123`)).toBe(true);
  });

  it("does not recognize JWT-shaped tokens as personal", () => {
    expect(isPersonalAccessToken("header.payload.signature")).toBe(false);
    expect(isPersonalAccessToken("not-a-dofek-token")).toBe(false);
  });
});

describe("getSharedJwtGetKey", () => {
  it("caches a remote key resolver per JWKS URI", () => {
    const first = getSharedJwtGetKey("https://issuer-one.example.test/jwks");
    const sameIssuer = getSharedJwtGetKey("https://issuer-one.example.test/jwks");
    const second = getSharedJwtGetKey("https://issuer-two.example.test/jwks");

    expect(sameIssuer).toBe(first);
    expect(second).not.toBe(first);
  });
});

describe("verifyJwtAccessToken", () => {
  beforeEach(() => captureException.mockReset());

  async function makeSignedJwt(claims: Record<string, unknown>, key: CryptoKey): Promise<string> {
    return new SignJWT(claims)
      .setProtectedHeader({ alg: "ES256" })
      .setIssuer(ISSUER)
      .setAudience(RESOURCE)
      .setExpirationTime("2h")
      .setIssuedAt()
      .sign(key);
  }

  async function localKeySet(): Promise<{
    jwks: { keys: unknown[] };
    sign(claims: Record<string, unknown>): Promise<string>;
  }> {
    const { publicKey, privateKey } = await generateKeyPair("ES256");
    const publicJwk = await exportJWK(publicKey);
    return {
      jwks: { keys: [{ ...publicJwk, alg: "ES256", use: "sig" }] },
      sign: (claims: Record<string, unknown>) => makeSignedJwt(claims, privateKey),
    };
  }

  it("verifies a valid JWT and maps sub/client_id/scope", async () => {
    const keys = await localKeySet();
    const getKey = createLocalJWKSet(keys.jwks);
    const token = await keys.sign({
      sub: "user-id-123",
      client_id: "oauth-client",
      scope: "health:read activity:read",
      jti: "access-token-id",
    });

    const principal = await verifyJwtAccessToken(
      token,
      { issuer: ISSUER, resourceUrl: RESOURCE },
      getKey,
    );
    const expiration = decodeJwt(token).exp;
    if (typeof expiration !== "number") throw new Error("expected the signed token to expire");

    expect(principal).toEqual({
      kind: "oauth",
      tokenId: "access-token-id",
      userId: "user-id-123",
      clientId: "oauth-client",
      scopes: ["health:read", "activity:read"],
      expiresAt: new Date(expiration * 1000).toISOString(),
    });
  });

  it.each(["sub", "client_id", "jti"] as const)(
    "rejects a token without its required %s claim",
    async (claim) => {
      const keys = await localKeySet();
      const getKey = createLocalJWKSet(keys.jwks);
      const claims = {
        sub: "user-id",
        client_id: "oauth-client",
        scope: "health:read",
        jti: "access-token-id",
      };
      delete claims[claim];

      await expect(
        verifyJwtAccessToken(
          await keys.sign(claims),
          { issuer: ISSUER, resourceUrl: RESOURCE },
          getKey,
        ),
      ).resolves.toBeNull();
    },
  );

  it("normalizes repeated scope separators and rejects unknown scopes", async () => {
    const keys = await localKeySet();
    const getKey = createLocalJWKSet(keys.jwks);
    const token = await keys.sign({
      sub: "user-id",
      client_id: "oauth-client",
      scope: "health:read  activity:read",
      jti: "access-token-id",
    });

    await expect(
      verifyJwtAccessToken(token, { issuer: ISSUER, resourceUrl: RESOURCE }, getKey),
    ).resolves.toMatchObject({ scopes: ["health:read", "activity:read"] });
  });

  it("rejects an OAuth access token without an expiration claim", async () => {
    const { publicKey, privateKey } = await generateKeyPair("ES256");
    const getKey = createLocalJWKSet({
      keys: [{ ...(await exportJWK(publicKey)), alg: "ES256", use: "sig" }],
    });
    const token = await new SignJWT({
      sub: "user-id",
      client_id: "oauth-client",
      scope: "health:read",
      jti: "access-token-id",
    })
      .setProtectedHeader({ alg: "ES256" })
      .setIssuer(ISSUER)
      .setAudience(RESOURCE)
      .sign(privateKey);

    await expect(
      verifyJwtAccessToken(token, { issuer: ISSUER, resourceUrl: RESOURCE }, getKey),
    ).resolves.toBeNull();
  });

  it("rejects a token with the wrong audience", async () => {
    const { publicKey, privateKey } = await generateKeyPair("ES256");
    const getKey = createLocalJWKSet({
      keys: [{ ...(await exportJWK(publicKey)), alg: "ES256", use: "sig" }],
    });
    const token = await new SignJWT({
      sub: "user-id",
      client_id: "oauth-client",
      scope: "health:read",
      jti: "access-token-id",
    })
      .setProtectedHeader({ alg: "ES256" })
      .setIssuer(ISSUER)
      .setAudience("https://other.example.test/api/mcp")
      .setExpirationTime("2h")
      .sign(privateKey);

    await expect(
      verifyJwtAccessToken(token, { issuer: ISSUER, resourceUrl: RESOURCE }, getKey),
    ).resolves.toBeNull();
  });

  it("rejects an expired token", async () => {
    const { publicKey, privateKey } = await generateKeyPair("ES256");
    const getKey = createLocalJWKSet({
      keys: [{ ...(await exportJWK(publicKey)), alg: "ES256", use: "sig" }],
    });
    const token = await new SignJWT({
      sub: "user-id",
      client_id: "oauth-client",
      scope: "health:read",
      jti: "access-token-id",
    })
      .setProtectedHeader({ alg: "ES256" })
      .setIssuer(ISSUER)
      .setAudience(RESOURCE)
      .setExpirationTime(1)
      .sign(privateKey);

    await expect(
      verifyJwtAccessToken(token, { issuer: ISSUER, resourceUrl: RESOURCE }, getKey),
    ).resolves.toBeNull();
  });

  it("rejects a JWT with an unrecognized scope", async () => {
    const keys = await localKeySet();
    const getKey = createLocalJWKSet(keys.jwks);
    const token = await keys.sign({
      sub: "user-id-123",
      client_id: "oauth-client",
      scope: "health:read not:a:scope",
    });

    await expect(
      verifyJwtAccessToken(token, { issuer: ISSUER, resourceUrl: RESOURCE }, getKey),
    ).resolves.toBeNull();
  });

  it("rejects a JWT signed by an unknown key", async () => {
    const { privateKey } = await generateKeyPair("ES256");
    const keys = await localKeySet();
    const getKey = createLocalJWKSet(keys.jwks);
    const token = await makeSignedJwt(
      { sub: "user-id", client_id: "oauth-client", scope: "health:read" },
      privateKey,
    );

    await expect(
      verifyJwtAccessToken(token, { issuer: ISSUER, resourceUrl: RESOURCE }, getKey),
    ).resolves.toBeNull();
  });

  it("reports and propagates remote JWKS fetch failures", async () => {
    const keys = await localKeySet();
    const token = await keys.sign({
      sub: "user-id",
      client_id: "oauth-client",
      scope: "health:read",
      jti: "access-token-id",
    });
    const failure = new TypeError("JWKS fetch failed");

    await expect(
      verifyJwtAccessToken(token, { issuer: ISSUER, resourceUrl: RESOURCE }, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(captureException).toHaveBeenCalledWith(
      failure,
      expect.objectContaining({ tags: { source: "mcp-jwks-verification" } }),
    );
  });
});

describe("verifyMcpAccessToken", () => {
  beforeEach(() => {
    tokenRepositoryMocks.markMcpConnectedAppUsed.mockReset().mockResolvedValue(true);
    tokenRepositoryMocks.validateMcpToken.mockReset();
  });

  it("validates personal tokens through the existing token repository", async () => {
    const db = { execute: vi.fn() };
    tokenRepositoryMocks.validateMcpToken.mockResolvedValue({
      userId: "user-id",
      tokenId: "personal-token-id",
      scopes: ["health:read"],
      expiresAt: null,
    });

    await expect(
      verifyMcpAccessToken(`${PERSONAL_TOKEN_PREFIX}secret`, {
        db,
        issuer: ISSUER,
        resourceUrl: RESOURCE,
      }),
    ).resolves.toEqual({
      kind: "personal_token",
      userId: "user-id",
      tokenId: "personal-token-id",
      scopes: ["health:read"],
      expiresAt: null,
    });
    expect(tokenRepositoryMocks.validateMcpToken).toHaveBeenCalledWith(
      db,
      `${PERSONAL_TOKEN_PREFIX}secret`,
    );
    expect(tokenRepositoryMocks.markMcpConnectedAppUsed).not.toHaveBeenCalled();
  });

  it("rejects an OAuth token whose connected-app grant is no longer active", async () => {
    const { publicKey, privateKey } = await generateKeyPair("ES256");
    const publicJwk = await exportJWK(publicKey);
    const server = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ keys: [{ ...publicJwk, alg: "ES256", use: "sig" }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("expected a TCP test server");
    const jwksUri = `http://127.0.0.1:${address.port}/jwks`;
    const db = { execute: vi.fn() };
    const token = await new SignJWT({
      sub: "user-id",
      client_id: "oauth-client",
      scope: "health:read",
      jti: "access-token-id",
    })
      .setProtectedHeader({ alg: "ES256" })
      .setIssuer(ISSUER)
      .setAudience(RESOURCE)
      .setExpirationTime("2h")
      .sign(privateKey);
    tokenRepositoryMocks.markMcpConnectedAppUsed.mockResolvedValue(false);

    try {
      await expect(
        verifyMcpAccessToken(token, {
          db,
          issuer: ISSUER,
          resourceUrl: RESOURCE,
          jwksUri,
        }),
      ).resolves.toBeNull();
      const tokenIdHash = createHash("sha256").update("access-token-id").digest("hex");
      expect(tokenRepositoryMocks.markMcpConnectedAppUsed).toHaveBeenCalledWith(db, tokenIdHash);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});
