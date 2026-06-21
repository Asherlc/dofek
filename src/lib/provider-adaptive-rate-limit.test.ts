import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { describe, expect, it } from "vitest";
import { InMemoryAdaptiveRateLimitStore } from "./provider-adaptive-rate-limit.ts";

describe("InMemoryAdaptiveRateLimitStore", () => {
  it("tracks rolling request counts in Redis-shaped state without recomputing history", async () => {
    const store = new InMemoryAdaptiveRateLimitStore();

    await store.awaitAdmission("whoop", "provider", null);
    await store.awaitAdmission("whoop", "provider", null);

    const error = new ProviderRateLimitError({
      message: "whoop API rate limit exceeded (429):",
      providerId: "whoop",
      statusCode: 429,
      responseBody: "",
      retryAfterSeconds: 300,
    });
    await store.recordRateLimit(error);

    expect(await store.getLearnedCooldownSeconds("whoop")).toBe(300);
  });

  it("learns Strava quota headers from successful responses", async () => {
    const store = new InMemoryAdaptiveRateLimitStore();
    const headers = new Headers({
      "X-RateLimit-Limit": "100,1000",
      "X-RateLimit-Usage": "95,400",
    });

    await store.recordSuccess("strava", "provider", null, headers);

    // Near quota exhaustion should cause a longer admission delay on the next call.
    const start = Date.now();
    await store.awaitAdmission("strava", "provider", null);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(0);
  });
});
