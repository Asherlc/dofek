/** Strip PEM headers/footers and base64-decode to raw PKCS#8 DER bytes. */
export function decodePemToDer(pem: string): Uint8Array {
  const base64 = pem
    .replace(/^["']|["']$/g, "")
    .replace(/-----BEGIN (?:EC )?PRIVATE KEY-----/g, "")
    .replace(/-----END (?:EC )?PRIVATE KEY-----/g, "")
    .replace(/\\r/g, "")
    .replace(/\\n/g, "")
    .replace(/\s/g, "");
  return new Uint8Array(Buffer.from(base64, "base64"));
}

/** Create the ES256 client_secret JWT required by Apple's token and revoke endpoints. */
export async function createAppleClientSecret(
  teamId: string,
  keyId: string,
  pkcs8PrivateKey: Uint8Array,
  clientId: string,
): Promise<string> {
  const privateKey = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8PrivateKey.slice().buffer,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const now = Math.floor(Date.now() / 1_000);
  const header = Buffer.from(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" })).toString(
    "base64url",
  );
  const payload = Buffer.from(
    JSON.stringify({
      iss: teamId,
      iat: now,
      exp: now + 5 * 60,
      aud: "https://appleid.apple.com",
      sub: clientId,
    }),
  ).toString("base64url");
  const signingInput = new TextEncoder().encode(`${header}.${payload}`);
  const signature = Buffer.from(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, signingInput),
  ).toString("base64url");
  return `${header}.${payload}.${signature}`;
}
