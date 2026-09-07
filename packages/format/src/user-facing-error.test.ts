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

  it.each([
    "Failed to fetch",
    "fetch failed",
    "Network request failed",
    "Network connection was lost",
    "load failed",
    "connection reset",
    "connection refused",
    "connection lost",
    "ENOTFOUND example.com",
    "ECONNREFUSED 127.0.0.1:5432",
    "ECONNRESET",
    "ENETUNREACH",
    "EHOSTUNREACH",
  ])("replaces a network diagnostic: %s", (message) => {
    expect(userFacingErrorMessage(message)).toBe(
      "We couldn't reach the server. Check your connection and try again.",
    );
  });

  it.each(["ETIMEDOUT", "Request timed out", "request timeout", "Timeout exceeded"])(
    "replaces a timeout diagnostic: %s",
    (message) => {
      expect(userFacingErrorMessage(message)).toBe("The request took too long. Please try again.");
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
    "ZodError: bad input",
    "invalid_type",
    "invalid_format",
    "invalid_value",
    "Invalid input: expected number",
    "value is not a function",
    "Unexpected token < in JSON",
    "JSON.parse failed",
    "TypeError: boom",
    "ReferenceError: boom",
    "SyntaxError: boom",
    "DrizzleQueryError: boom",
    "PostgresError: boom",
    "ClickHouseError: boom",
    "Failed query: insert into users",
    "params: secret",
  ])("replaces a technical diagnostic: %s", (message) => {
    expect(userFacingErrorMessage(message, "The operation failed.")).toBe("The operation failed.");
  });

  it.each([
    "Error: broken\n    at handler (/app/server.ts:1:1)",
    "SELECT secret FROM users",
    '{"code":"broken"}',
    '  {"code":"broken"}  ',
    '["broken"]',
  ])("replaces multiline and serialized diagnostics: %s", (message) => {
    expect(userFacingErrorMessage(message, "The data could not be loaded.")).toBe(
      "The data could not be loaded.",
    );
  });

  it.each([
    "Select a provider",
    "Choose from the available providers",
    '{"code":"broken"',
    '"code":"broken"}',
    '["broken"',
    '"broken"]',
  ])("preserves a message that only resembles part of a diagnostic: %s", (message) => {
    expect(userFacingErrorMessage(message)).toBe(message);
  });

  it("turns authentication codes into useful guidance", () => {
    expect(userFacingErrorMessage({ message: "UNAUTHORIZED" })).toBe(
      "Your session has expired. Sign in and try again.",
    );
    expect(userFacingErrorMessage("FORBIDDEN")).toBe("You don't have permission to do that.");
  });

  it.each([
    "Request was UNAUTHORIZED",
    "UNAUTHORIZED request",
    "Request was FORBIDDEN",
    "FORBIDDEN request",
  ])("does not reinterpret an auth word embedded in a user-authored message: %s", (message) => {
    expect(userFacingErrorMessage(message)).toBe(message);
  });

  it.each(["preload failed", "load failed yesterday", "database connection reset"])(
    "preserves a user-authored message containing part of a network diagnostic: %s",
    (message) => {
      expect(userFacingErrorMessage(message)).toBe(message);
    },
  );

  it("trims user-authored messages and rejects blank text", () => {
    expect(userFacingErrorMessage("  Token name is already in use  ")).toBe(
      "Token name is already in use",
    );
    expect(userFacingErrorMessage("   ", "Try again")).toBe("Try again");
  });

  it.each([null, 42, { message: 42 }, { reason: "broken" }])(
    "uses the fallback for a value without a string message: %s",
    (error) => {
      expect(userFacingErrorMessage(error, "Upload failed")).toBe("Upload failed");
    },
  );

  it("uses the supplied fallback for unknown values and unexpected diagnostics", () => {
    expect(userFacingErrorMessage("unexpected failure", "Upload failed")).toBe("Upload failed");
  });
});
