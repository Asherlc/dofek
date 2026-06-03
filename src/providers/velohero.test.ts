import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { describe, expect, it } from "vitest";
import { VeloHeroProvider } from "./velohero.ts";

describe("VeloHeroProvider — rate-limit aware fetch wiring", () => {
  it("surfaces a 429 as a ProviderRateLimitError tagged with providerId 'velohero'", async () => {
    const mockFetch: typeof globalThis.fetch = async (): Promise<Response> =>
      new Response("rate limited", { status: 429, headers: { "Retry-After": "60" } });

    const provider = new VeloHeroProvider(mockFetch);
    const setup = provider.authSetup();

    const err = await setup
      .automatedLogin?.("user@example.com", "password")
      .catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(ProviderRateLimitError);
    if (err instanceof ProviderRateLimitError) {
      expect(err.providerId).toBe("velohero");
      expect(err.statusCode).toBe(429);
    }
  });
});
