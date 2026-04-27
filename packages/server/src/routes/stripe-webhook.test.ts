import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createStripeWebhookRouter } from "./stripe-webhook.ts";

const stripeMocks = vi.hoisted(() => ({
  constructEvent: vi.fn(),
}));

vi.mock("../billing/config.ts", () => ({
  getStripeBillingConfig: () => ({
    secretKey: "sk_test_123",
    webhookSecret: "whsec_123",
    priceId: "price_123",
    appBaseUrl: "https://app.example.com",
  }),
}));

vi.mock("../billing/stripe-client.ts", () => ({
  createStripeClient: () => ({
    webhooks: { constructEvent: stripeMocks.constructEvent },
  }),
}));

describe("stripe webhook route", () => {
  beforeEach(() => {
    stripeMocks.constructEvent.mockReset();
  });

  it("updates local subscription state for customer.subscription.updated", async () => {
    stripeMocks.constructEvent.mockReturnValue({
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_123",
          customer: "cus_123",
          status: "active",
          current_period_end: 1_777_000_000,
        },
      },
    });
    const execute = vi.fn(async () => []);
    const app = express();
    app.use("/api/webhooks/stripe", createStripeWebhookRouter({ db: { execute } }));
    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === "string") {
      server.close();
      throw new Error("Test server did not bind to a port");
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/api/webhooks/stripe`, {
      method: "POST",
      headers: { "stripe-signature": "sig", "content-type": "application/json" },
      body: "{}",
    });
    server.close();

    expect(response.status).toBe(200);
    expect(execute).toHaveBeenCalled();
  });
});
