import { describe, expect, it } from "vitest";
import { appleSignInDiagnostic } from "./apple-auth-diagnostics";

describe("appleSignInDiagnostic", () => {
  it("extracts the native bridge marker into allowlisted context without retaining the original", () => {
    const original = Object.assign(
      new Error(
        "private-native-message\n→ Caused by: [dofek.apple-auth domain=com.apple.AuthenticationServices.AuthorizationError code=1000 underlyingDomain=AKAuthenticationError underlyingCode=-7026]",
      ),
      {
        code: "ERR_REQUEST_UNKNOWN",
        userInfo: { token: "private-token" },
      },
    );
    const result = appleSignInDiagnostic(original);
    expect(result?.context).toEqual({
      appleCode: "ERR_REQUEST_UNKNOWN",
      nativeDomain: "com.apple.AuthenticationServices.AuthorizationError",
      nativeCode: 1000,
      underlyingDomain: "AKAuthenticationError",
      underlyingCode: -7026,
    });
    expect(result?.error.message).toBe("Apple could not complete sign-in. Please try again.");
    expect(result?.error).not.toBe(original);
    expect(result?.error).not.toHaveProperty("cause");
    expect(JSON.stringify(result)).not.toContain("private-");
  });

  it.each([
    "[dofek.apple-auth domain=other code=-1]",
    "[dofek.apple-auth domain=NSCocoaErrorDomain code=513]",
  ])("accepts a sanitized marker without an underlying cause: %s", (marker) => {
    const result = appleSignInDiagnostic(
      Object.assign(new Error(marker), { code: "ERR_REQUEST_UNKNOWN" }),
    );
    expect(result?.context).toHaveProperty("nativeCode");
    expect(result?.context).not.toHaveProperty("underlyingCode");
  });

  it.each([
    "[dofek.apple-auth domain=private-account code=1]",
    "[dofek.apple-auth domain=other code=private-token]",
    "[dofek.apple-auth domain=other code=9007199254740992]",
    "[dofek.apple-auth domain=other code=1 underlyingDomain=private-account underlyingCode=2]",
    "private-native-message",
  ])("rejects malformed/untrusted marker fields: %s", (message) => {
    const result = appleSignInDiagnostic(
      Object.assign(new Error(message), { code: "ERR_REQUEST_UNKNOWN" }),
    );
    expect(result?.context).toEqual({ appleCode: "ERR_REQUEST_UNKNOWN" });
    expect(result?.error.message).not.toContain("private-");
  });

  it("leaves cancellation and non-native server errors to their existing handlers", () => {
    expect(
      appleSignInDiagnostic(Object.assign(new Error("cancel"), { code: "ERR_REQUEST_CANCELED" })),
    ).toBeUndefined();
    expect(
      appleSignInDiagnostic(
        new Error("Your Apple account is not linked. Sign in with your password."),
      ),
    ).toBeUndefined();
    expect(appleSignInDiagnostic({ code: "private-token" })).toBeUndefined();
  });
});
