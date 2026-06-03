import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { afterEach, describe, expect, it } from "vitest";
import { CyclingAnalyticsProvider } from "./cycling-analytics.ts";

describe("CyclingAnalyticsProvider — rate-limit aware fetch wiring", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("surfaces a 429 as a ProviderRateLimitError tagged with providerId 'cycling_analytics'", async () => {
    process.env.CYCLING_ANALYTICS_CLIENT_ID = "test-id";
    process.env.CYCLING_ANALYTICS_CLIENT_SECRET = "test-secret";

    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> =>
      new Response("rate limited", { status: 429, headers: { "Retry-After": "60" } });

    const provider = new CyclingAnalyticsProvider(mockFetch);
    const setup = provider.authSetup();

    const err = await setup.exchangeCode("any-code").catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(ProviderRateLimitError);
    if (err instanceof ProviderRateLimitError) {
      expect(err.providerId).toBe("cycling_analytics");
      expect(err.statusCode).toBe(429);
    }
  });
});
