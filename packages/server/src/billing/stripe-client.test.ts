import { describe, expect, it, vi } from "vitest";

const stripeConstructors = vi.hoisted(() => ({
  httpClient: {},
  createFetchHttpClient: vi.fn(),
  stripe: vi.fn(),
}));

stripeConstructors.createFetchHttpClient.mockReturnValue(stripeConstructors.httpClient);
Object.assign(stripeConstructors.stripe, {
  createFetchHttpClient: stripeConstructors.createFetchHttpClient,
});

vi.mock("stripe", () => ({
  default: stripeConstructors.stripe,
}));

vi.mock("./config.ts", () => ({
  getStripeBillingConfig: () => ({
    secretKey: "sk_test_123",
    webhookSecret: "whsec_123",
    priceId: "price_123",
    appBaseUrl: "https://app.example.com",
  }),
}));

const { createStripeClient } = await import("./stripe-client.ts");

describe("createStripeClient", () => {
  it("creates Stripe with the configured secret key", () => {
    createStripeClient();

    expect(stripeConstructors.createFetchHttpClient).toHaveBeenCalledOnce();
    expect(stripeConstructors.stripe).toHaveBeenCalledWith("sk_test_123", {
      httpClient: stripeConstructors.httpClient,
    });
  });
});
