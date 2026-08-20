import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function pkceS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function verifyPkce(verifier: string, challenge: string): boolean {
  const actual = Buffer.from(pkceS256(verifier));
  const expected = Buffer.from(challenge);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createOpaqueSecret(): { value: string; hash: string } {
  const value = randomBytes(32).toString("base64url");
  return { value, hash: createHash("sha256").update(value).digest("hex") };
}

export function buildProblem(
  code: string,
  status: number,
  requestId: string,
  details: unknown[] = [],
) {
  const title = (code === "ACCOUNT_ERASURE_ACTIVE" ? "Account erasure active" : code)
    .toLowerCase()
    .split("_")
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join(" ");
  const messages: Record<string, string> = {
    ACCOUNT_ERASURE_ACTIVE:
      "This Dofek account is being deleted. New writes are temporarily unavailable.",
    INVALID_CREDENTIALS: "The supplied credentials are invalid or revoked.",
    VALIDATION_ERROR: "The request is invalid.",
  };
  return {
    type: `https://api.dofek.example/problems/${code.toLowerCase().replaceAll("_", "-")}`,
    title,
    status,
    code,
    message: messages[code] ?? "The request could not be completed.",
    requestId,
    details,
  };
}
