import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { failOnUnhandledExternalRequest } from "../../../../src/test/msw.ts";
import { validateNativeAppleCallback } from "./providers.ts";

// Generate a real ES256 (P-256) key pair for testing
async function generateTestKeyPem(): Promise<{ pem: string; keyId: string }> {
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const exported = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const base64 = Buffer.from(exported).toString("base64");
  const pem = `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----`;
  return { pem, keyId: "TEST_KEY_123" };
}

/** Create a fake Apple ID token (unsigned — just needs to be decodable by arctic's decodeIdToken). */
function createFakeIdToken(sub: string, email: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(
    JSON.stringify({ sub, email, iss: "https://appleid.apple.com" }),
  ).toString("base64url");
  const fakeSignature = Buffer.from("fake-signature").toString("base64url");
  return `${header}.${payload}.${fakeSignature}`;
}

const mswServer = setupServer();

describe("validateNativeAppleCallback (integration)", () => {
  const originalEnv = { ...process.env };

  beforeAll(async () => {
    mswServer.listen({ onUnhandledRequest: failOnUnhandledExternalRequest });

    const { pem, keyId } = await generateTestKeyPem();
    process.env.APPLE_BUNDLE_ID = "com.dofek.app";
    process.env.APPLE_TEAM_ID = "TEST_TEAM";
    process.env.APPLE_KEY_ID = keyId;
    process.env.APPLE_PRIVATE_KEY = pem;
  });

  afterEach(() => {
    mswServer.resetHandlers();
  });

  afterAll(() => {
    mswServer.close();
    process.env = originalEnv;
  });

  it("exchanges auth code for user info via Apple token endpoint", async () => {
    const fakeIdToken = createFakeIdToken("apple-user-001", "alice@icloud.com");

    mswServer.use(
      http.post("https://appleid.apple.com/auth/token", async ({ request }) => {
        const bodyText = await request.text();
        const params = new URLSearchParams(bodyText);

        // Verify correct parameters are sent
        expect(params.get("grant_type")).toBe("authorization_code");
        expect(params.get("code")).toBe("test-auth-code");
        expect(params.get("client_id")).toBe("com.dofek.app");
        expect(params.get("client_secret")).toBeTruthy();
        // Critical: redirect_uri must NOT be present for native flow
        expect(params.has("redirect_uri")).toBe(false);

        return HttpResponse.json({
          access_token: "mock-access-token",
          token_type: "Bearer",
          expires_in: 3600,
          id_token: fakeIdToken,
        });
      }),
    );

    const result = await validateNativeAppleCallback("test-auth-code");

    expect(result.user.sub).toBe("apple-user-001");
    expect(result.user.email).toBe("alice@icloud.com");
    expect(result.user.name).toBeNull();
    expect(result.user.groups).toBeNull();
  });

  it("sends a valid ES256 JWT as client_secret", async () => {
    const fakeIdToken = createFakeIdToken("apple-user-002", "bob@icloud.com");
    let capturedClientSecret: string | null = null;

    mswServer.use(
      http.post("https://appleid.apple.com/auth/token", async ({ request }) => {
        const params = new URLSearchParams(await request.text());
        capturedClientSecret = params.get("client_secret");

        return HttpResponse.json({
          access_token: "mock-access-token",
          token_type: "Bearer",
          expires_in: 3600,
          id_token: fakeIdToken,
        });
      }),
    );

    await validateNativeAppleCallback("test-code");

    // client_secret should be a 3-part JWT
    expect(capturedClientSecret).toBeTruthy();
    if (!capturedClientSecret) throw new Error("Expected client_secret to be captured");
    const parts = capturedClientSecret.split(".");
    expect(parts).toHaveLength(3);

    // Decode and verify header
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString());
    expect(header.alg).toBe("ES256");
    expect(header.kid).toBe("TEST_KEY_123");
    expect(header.typ).toBe("JWT");

    // Decode and verify payload
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    expect(payload.iss).toBe("TEST_TEAM");
    expect(payload.sub).toBe("com.dofek.app");
    expect(payload.aud).toBe("https://appleid.apple.com");
    expect(payload.iat).toBeTypeOf("number");
    expect(payload.exp).toBe(payload.iat + 300);
  });

  it("throws when Apple returns an error response", async () => {
    mswServer.use(
      http.post("https://appleid.apple.com/auth/token", () => {
        return new HttpResponse(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
      }),
    );

    await expect(validateNativeAppleCallback("bad-code")).rejects.toThrow(
      "Apple token exchange failed (400)",
    );
  });

  it("throws when APPLE_BUNDLE_ID is not set", async () => {
    const savedBundleId = process.env.APPLE_BUNDLE_ID;
    delete process.env.APPLE_BUNDLE_ID;

    await expect(validateNativeAppleCallback("code")).rejects.toThrow("APPLE_BUNDLE_ID");

    process.env.APPLE_BUNDLE_ID = savedBundleId;
  });
});
