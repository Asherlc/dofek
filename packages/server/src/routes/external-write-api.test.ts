import { describe, expect, it } from "vitest";
import { buildProblem, createOpaqueSecret, pkceS256, verifyPkce } from "./external-write-api.ts";

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
});
