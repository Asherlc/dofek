import { describe, expect, it } from "vitest";
import { buildProblem } from "./api-problem.ts";
import {
  createOpaqueSecret,
  hashSecret,
  pkceS256,
  verifyPkce,
} from "./external-write-api-primitives.ts";

describe("external write API security primitives", () => {
  it("computes the RFC 7636 S256 challenge", () => {
    expect(pkceS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("accepts only the matching PKCE verifier", () => {
    const verifier = "a".repeat(43);
    const challenge = pkceS256(verifier);
    expect(verifyPkce(verifier, challenge)).toBe(true);
    expect(verifyPkce("b".repeat(43), challenge)).toBe(false);
    expect(verifyPkce("short", challenge)).toBe(false);
  });

  it("hashes raw secrets consistently", () => {
    expect(hashSecret("secret-value")).toBe(hashSecret("secret-value"));
    expect(hashSecret("secret-value")).not.toBe(hashSecret("different-value"));
  });

  it("creates a high-entropy opaque secret without returning its hash", () => {
    const secret = createOpaqueSecret();
    expect(secret.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(secret.hash).not.toBe(secret.value);
    expect(secret.hash).toHaveLength(64);
  });

  it("uses a privacy-safe problem envelope", () => {
    expect(buildProblem("ACCOUNT_ERASURE_ACTIVE", 423, "request-1")).toEqual({
      type: "https://api.dofek.example/problems/account-erasure-active",
      title: "Account erasure active",
      status: 423,
      code: "ACCOUNT_ERASURE_ACTIVE",
      message: "This Dofek account is being deleted. New writes are temporarily unavailable.",
      requestId: "request-1",
      details: [],
    });
  });

  it("uses a generic envelope for unmapped problem codes", () => {
    expect(buildProblem("UNMAPPED_CODE", 500, "request-2")).toEqual({
      type: "https://api.dofek.example/problems/unmapped-code",
      title: "Request failed",
      status: 500,
      code: "UNMAPPED_CODE",
      message: "The request failed.",
      requestId: "request-2",
      details: [],
    });
  });

  it.each([
    [
      "EXTERNAL_IDENTITY_ALREADY_LINKED",
      "External identity already linked",
      "This external identity is already linked to another Dofek account.",
    ],
    ["FORBIDDEN", "Forbidden", "The caller is not allowed to perform this action."],
    [
      "IDEMPOTENCY_KEY_REUSED",
      "Idempotency key reused",
      "The idempotency key was already used with a different request.",
    ],
    [
      "EXTERNAL_ID_ALREADY_EXISTS",
      "External ID already exists",
      "An entry with this external ID already exists for this account.",
    ],
    [
      "INVALID_CREDENTIALS",
      "Invalid credentials",
      "The supplied credentials are invalid or revoked.",
    ],
    ["INVALID_LINK_CODE", "Invalid link code", "The link code is invalid or expired."],
    ["NOT_FOUND", "Not found", "The requested resource was not found."],
    [
      "REQUEST_IN_PROGRESS",
      "Request in progress",
      "An equivalent request is already being processed.",
    ],
    ["SERVICE_UNAVAILABLE", "Service unavailable", "The request could not be completed right now."],
    ["VALIDATION_ERROR", "Validation failed", "The request is invalid."],
  ])("preserves the explicit problem message for %s", (code, title, message) => {
    expect(
      buildProblem(code, 400, "request-3", [{ path: ["field"], message: "invalid" }]),
    ).toMatchObject({
      code,
      title,
      message,
      details: [{ path: ["field"], message: "invalid" }],
    });
  });
});
