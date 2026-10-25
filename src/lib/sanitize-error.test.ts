import { describe, expect, it } from "vitest";
import { sanitizeErrorMessage } from "./sanitize-error.ts";

describe("sanitizeErrorMessage", () => {
  it("returns null for null input", () => {
    expect(sanitizeErrorMessage(null)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(sanitizeErrorMessage("")).toBeNull();
  });

  it("passes through safe error messages unchanged", () => {
    expect(sanitizeErrorMessage("Connect API authentication failed (401)")).toBe(
      "Connect API authentication failed (401)",
    );
    expect(sanitizeErrorMessage("No OAuth tokens found for Garmin")).toBe(
      "No OAuth tokens found for Garmin",
    );
    expect(sanitizeErrorMessage("Rate limit exceeded (429)")).toBe("Rate limit exceeded (429)");
  });

  it("redacts access_token values", () => {
    const message = "Failed: access_token=eyJhbGciOiJSUz rest of message";
    expect(sanitizeErrorMessage(message)).toBe("Failed: access_token=[REDACTED] rest of message");
  });

  it("redacts refresh_token values", () => {
    const message = "Error: refresh_token: abc123secret456";
    expect(sanitizeErrorMessage(message)).toBe("Error: refresh_token: [REDACTED]");
  });

  it("redacts password values", () => {
    expect(sanitizeErrorMessage("password=hunter2&user=bob")).toBe("password=[REDACTED]&user=bob");
  });

  it("redacts Authorization Bearer headers", () => {
    const message = "Authorization: Bearer eyJhbGciOiJSUzI1NiJ9.abc.xyz in request";
    expect(sanitizeErrorMessage(message)).toBe("Authorization: Bearer [REDACTED] in request");
  });

  it("redacts Authorization Basic headers", () => {
    const message = "authorization: basic dXNlcjpwYXNz in request";
    expect(sanitizeErrorMessage(message)).toBe("authorization: basic [REDACTED] in request");
  });

  it("strips query strings from URLs", () => {
    const message = "API error (401): https://connectapi.garmin.com/oauth?code=abc123&state=xyz";
    expect(sanitizeErrorMessage(message)).toBe(
      "API error (401): https://connectapi.garmin.com/oauth?[REDACTED]",
    );
  });

  it("preserves URLs without query strings", () => {
    const message = "Failed to reach https://connectapi.garmin.com/api/v1/activities";
    expect(sanitizeErrorMessage(message)).toBe(
      "Failed to reach https://connectapi.garmin.com/api/v1/activities",
    );
  });

  it("redacts api_key values", () => {
    expect(sanitizeErrorMessage("api_key=sk_live_abc123")).toBe("api_key=[REDACTED]");
  });

  it("redacts client_secret values", () => {
    expect(sanitizeErrorMessage("client_secret: my-secret-value")).toBe(
      "client_secret: [REDACTED]",
    );
  });

  it("does not false-positive on 'token expired' (noun usage)", () => {
    expect(sanitizeErrorMessage("OAuth token expired")).toBe("OAuth token expired");
  });
});
