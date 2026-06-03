import { ProviderRateLimitError } from "@dofek/provider-http/rate-limit";
import { describe, expect, it } from "vitest";
import { signInToXert, XertProvider } from "./xert.ts";

const rateLimitedFetch: typeof globalThis.fetch = async (): Promise<Response> =>
  new Response("rate limited", { status: 429, headers: { "Retry-After": "60" } });

describe("XertProvider — rate-limit aware fetch wiring", () => {
  it("surfaces a 429 from automatedLogin as a ProviderRateLimitError tagged 'xert'", async () => {
    const provider = new XertProvider(rateLimitedFetch);
    const setup = provider.authSetup();

    const err = await setup
      .automatedLogin?.("user@example.com", "password")
      .catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(ProviderRateLimitError);
    if (err instanceof ProviderRateLimitError) {
      expect(err.providerId).toBe("xert");
      expect(err.statusCode).toBe(429);
    }
  });

  it("surfaces a 429 from signInToXert as a ProviderRateLimitError tagged 'xert'", async () => {
    const err = await signInToXert("user@example.com", "password", rateLimitedFetch).catch(
      (caught: unknown) => caught,
    );
    expect(err).toBeInstanceOf(ProviderRateLimitError);
    if (err instanceof ProviderRateLimitError) {
      expect(err.providerId).toBe("xert");
      expect(err.statusCode).toBe(429);
    }
  });
});
