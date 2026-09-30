import {
  ProviderRequestTimeoutError,
  ProviderServiceUnavailableError,
} from "@dofek/provider-http/rate-limit";
import { describe, expect, it } from "vitest";
import { findProviderTransportError } from "./provider-transport-error.ts";

describe("findProviderTransportError", () => {
  it.each([
    new ProviderServiceUnavailableError({
      providerId: "openbeta",
      statusCode: 504,
      message: "timeout",
      responseBody: "timeout",
    }),
    new ProviderRequestTimeoutError({ providerId: "openbeta", timeoutMs: 120_000 }),
  ])("finds typed transport errors through wrapper causes", (error) => {
    expect(findProviderTransportError(new Error("sync failed", { cause: error }))).toBe(error);
  });

  it("does not classify an untyped error or cyclic cause as a provider timeout", () => {
    const error = new Error("timeout");
    error.cause = error;
    expect(findProviderTransportError(error)).toBeNull();
    expect(findProviderTransportError("timeout")).toBeNull();
  });
});
