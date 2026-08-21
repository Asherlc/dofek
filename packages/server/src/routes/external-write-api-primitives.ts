import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function hashSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

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
  const problems: Record<string, { title: string; message: string }> = {
    ACCOUNT_ERASURE_ACTIVE: {
      title: "Account erasure active",
      message: "This Dofek account is being deleted. New writes are temporarily unavailable.",
    },
    EXTERNAL_IDENTITY_ALREADY_LINKED: {
      title: "External identity already linked",
      message: "This external identity is already linked to another Dofek account.",
    },
    FORBIDDEN: { title: "Forbidden", message: "The caller is not allowed to perform this action." },
    IDEMPOTENCY_KEY_REUSED: {
      title: "Idempotency key reused",
      message: "The idempotency key was already used with a different request.",
    },
    EXTERNAL_ID_ALREADY_EXISTS: {
      title: "External ID already exists",
      message: "An entry with this external ID already exists for this account.",
    },
    INVALID_CREDENTIALS: {
      title: "Invalid credentials",
      message: "The supplied credentials are invalid or revoked.",
    },
    INVALID_LINK_CODE: {
      title: "Invalid link code",
      message: "The link code is invalid or expired.",
    },
    NOT_FOUND: { title: "Not found", message: "The requested resource was not found." },
    REQUEST_IN_PROGRESS: {
      title: "Request in progress",
      message: "An equivalent request is already being processed.",
    },
    SERVICE_UNAVAILABLE: {
      title: "Service unavailable",
      message: "The request could not be completed right now.",
    },
    VALIDATION_ERROR: { title: "Validation failed", message: "The request is invalid." },
  };
  const problem = problems[code] ?? { title: "Request failed", message: "The request failed." };
  return {
    type: `https://api.dofek.example/problems/${code.toLowerCase().replaceAll("_", "-")}`,
    title: problem.title,
    status,
    code,
    message: problem.message,
    requestId,
    details,
  };
}
