import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import {
  isPersonalAccessToken,
  PERSONAL_TOKEN_PREFIX,
  verifyJwtAccessToken,
} from "./access-token-verifier.ts";

const ISSUER = "https://app.example.test";
const RESOURCE = "https://app.example.test/api/mcp";

describe("isPersonalAccessToken", () => {
  it("recognizes Dofek personal tokens by prefix", () => {
    expect(isPersonalAccessToken(`${PERSONAL_TOKEN_PREFIX}abc123`)).toBe(true);
  });

  it("does not recognize JWT-shaped tokens as personal", () => {
    expect(isPersonalAccessToken("eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1In0.sig")).toBe(false);
    expect(isPersonalAccessToken("not-a-dofek-token")).toBe(false);
  });
});

describe("verifyJwtAccessToken", () => {
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
    });

    const principal = await verifyJwtAccessToken(
      token,
      { issuer: ISSUER, resourceUrl: RESOURCE },
      getKey,
    );

    expect(principal).toEqual({
      kind: "oauth",
      userId: "user-id-123",
      clientId: "oauth-client",
      scopes: ["health:read", "activity:read"],
      expiresAt: expect.any(String),
    });
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
});
