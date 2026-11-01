import {
  ProviderRateLimitError,
  ProviderRequestTimeoutError,
  ProviderServiceUnavailableError,
} from "@dofek/provider-http/rate-limit";
import { describe, expect, it } from "vitest";
import {
  ProviderConnectionError,
  ProviderStoredIdentityInvalidError,
} from "../providers/auth-errors.ts";
import { shouldReportProviderError } from "./provider-error-reporting.ts";

describe("provider exception reporting", () => {
  it.each([
    new ProviderStoredIdentityInvalidError("Reconnect theCrag"),
    new Error("sync failed", { cause: new ProviderStoredIdentityInvalidError("Reconnect") }),
    new DOMException("cancelled", "AbortError"),
    new ProviderRequestTimeoutError({ providerId: "thecrag", timeoutMs: 120000 }),
    new ProviderServiceUnavailableError({
      message: "Mountain Project is temporarily unavailable",
      providerId: "mountain-project",
      statusCode: 503,
      responseBody: "maintenance",
    }),
    new ProviderRateLimitError({
      message: "theCrag limited this request",
      providerId: "thecrag",
      statusCode: 429,
      responseBody: "limited",
      scope: "provider",
    }),
  ])("leaves known operational outcomes in sync status and metrics: %s", (error) => {
    expect(shouldReportProviderError(error)).toBe(false);
  });

  it.each([
    new SyntaxError("Invalid response JSON"),
    new Error("Database is unavailable"),
    new Error("HTTP 403 with unknown cause"),
    new ProviderConnectionError("Garmin", "permissions", 403),
    "Unexpected thrown value",
    null,
  ])("retains unexpected failures and unexplained authorization errors: %s", (error) => {
    expect(shouldReportProviderError(error)).toBe(true);
  });

  it("terminates on cyclic unexpected causes", () => {
    const error = new Error("Unexpected failure");
    error.cause = error;
    expect(shouldReportProviderError(error)).toBe(true);
  });
});
