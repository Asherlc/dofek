import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { WhoopRateLimitError } from "@dofek/whoop/client";
import { describe, expect, it } from "vitest";
import { findWhoopRateLimitError, isWhoopRateLimitError } from "./rate-limit.ts";

describe("isWhoopRateLimitError", () => {
  it("recognizes WhoopRateLimitError", () => {
    expect(isWhoopRateLimitError(new WhoopRateLimitError("limited"))).toBe(true);
  });

  it("recognizes ProviderRateLimitError tagged with whoop", () => {
    const error = new ProviderRateLimitError({
      message: "whoop API rate limit exceeded (429):",
      providerId: "whoop",
      statusCode: 429,
      responseBody: "",
    });
    expect(isWhoopRateLimitError(error)).toBe(true);
  });

  it("rejects other provider rate-limit errors", () => {
    const error = new ProviderRateLimitError({
      message: "garmin API rate limit exceeded (429):",
      providerId: "garmin",
      statusCode: 429,
      responseBody: "",
    });
    expect(isWhoopRateLimitError(error)).toBe(false);
  });
});

describe("findWhoopRateLimitError", () => {
  it("returns the first whoop rate-limit error from sync errors", () => {
    const error = new ProviderRateLimitError({
      message: "whoop API rate limit exceeded (429):",
      providerId: "whoop",
      statusCode: 429,
      responseBody: "",
    });
    expect(findWhoopRateLimitError([{ cause: error }])).toBe(error);
  });
});
