import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { afterEach, describe, expect, it } from "vitest";
import { WgerProvider } from "./wger.ts";

describe("WgerProvider — rate-limit aware fetch wiring", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("surfaces a 429 as a ProviderRateLimitError tagged with providerId 'wger'", async () => {
    process.env.WGER_CLIENT_ID = "test-id";
    process.env.WGER_CLIENT_SECRET = "test-secret";

    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> =>
      new Response("rate limited", { status: 429, headers: { "Retry-After": "60" } });

    const provider = new WgerProvider(mockFetch);
    const setup = provider.authSetup();

    const err = await setup.exchangeCode!("any-code").catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(ProviderRateLimitError);
    if (err instanceof ProviderRateLimitError) {
      expect(err.providerId).toBe("wger");
      expect(err.statusCode).toBe(429);
    }
  });
});
