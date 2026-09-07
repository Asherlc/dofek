import { describe, expect, it } from "vitest";
import { userFacingErrorMessage } from "./user-facing-error.ts";

describe("userFacingErrorMessage", () => {
  it("preserves an actionable message authored for the user", () => {
    expect(userFacingErrorMessage(new Error("Token name is already in use"))).toBe(
      "Token name is already in use",
    );
  });

  it("reads error-like objects returned by query clients", () => {
    expect(userFacingErrorMessage({ message: "Reconnect your account and try again." })).toBe(
      "Reconnect your account and try again.",
    );
  });

  it.each(["Failed to fetch", "connection reset", "ECONNREFUSED 127.0.0.1:5432"])(
    "replaces a network diagnostic: %s",
    (message) => {
      expect(userFacingErrorMessage(message)).toBe(
        "We couldn't reach the server. Check your connection and try again.",
      );
    },
  );

  it("replaces validation details with the supplied action-specific fallback", () => {
    expect(
      userFacingErrorMessage(
        "Zod parse failed: Invalid input: expected string, received undefined",
        "Climbing data could not be loaded. Please try again.",
      ),
    ).toBe("Climbing data could not be loaded. Please try again.");
  });

  it("replaces runtime details with the default fallback", () => {
    expect(userFacingErrorMessage(new TypeError("Cannot read properties of undefined"))).toBe(
      "We couldn't complete this request. Please try again.",
    );
  });

  it.each([
    "Error: broken\n    at handler (/app/server.ts:1:1)",
    "Failed query: SELECT * FROM users\nparams: []",
    '{"code":"invalid_type"}',
  ])("replaces multiline and serialized diagnostics: %s", (message) => {
    expect(userFacingErrorMessage(message, "The data could not be loaded.")).toBe(
      "The data could not be loaded.",
    );
  });

  it("turns authentication codes into useful guidance", () => {
    expect(userFacingErrorMessage({ message: "UNAUTHORIZED" })).toBe(
      "Your session has expired. Sign in and try again.",
    );
    expect(userFacingErrorMessage("FORBIDDEN")).toBe("You don't have permission to do that.");
  });

  it("uses the supplied fallback for unknown values and unexpected diagnostics", () => {
    expect(userFacingErrorMessage({ reason: "broken" }, "Upload failed")).toBe("Upload failed");
    expect(userFacingErrorMessage("unexpected failure", "Upload failed")).toBe("Upload failed");
  });
});
