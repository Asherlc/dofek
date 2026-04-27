import { beforeEach, describe, expect, it, vi } from "vitest";

const stripeMocks = vi.hoisted(() => ({
  executeWithSchema: vi.fn(),
  checkoutCreate: vi.fn(),
  portalCreate: vi.fn(),
  customerCreate: vi.fn(),
}));

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{ db: { execute: unknown }; userId: string; timezone: string }>()
    .create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
  };
});

vi.mock("../lib/typed-sql.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../lib/typed-sql.ts")>();
  return {
    ...original,
    executeWithSchema: stripeMocks.executeWithSchema,
  };
});

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
    checkout: { sessions: { create: stripeMocks.checkoutCreate } },
    billingPortal: { sessions: { create: stripeMocks.portalCreate } },
    customers: { create: stripeMocks.customerCreate },
  }),
}));

import { billingRouter } from "./billing.ts";
import { createTestCallerFactory } from "./test-helpers.ts";

const createCaller = createTestCallerFactory(billingRouter);

describe("billingRouter", () => {
  beforeEach(() => {
    stripeMocks.executeWithSchema.mockReset();
    stripeMocks.checkoutCreate.mockReset();
    stripeMocks.portalCreate.mockReset();
    stripeMocks.customerCreate.mockReset();
  });

  it("returns limited signup-week status for unpaid users", async () => {
    stripeMocks.executeWithSchema.mockResolvedValue([
      {
        id: "user-1",
        created_at: "2026-04-10T18:30:00.000Z",
        paid_grant_reason: null,
        stripe_subscription_status: null,
        stripe_customer_id: null,
      },
    ]);
    const caller = createCaller({
      db: { execute: vi.fn() },
      userId: "user-1",
      timezone: "UTC",
    });

    await expect(caller.status()).resolves.toEqual({
      hasFullAccess: false,
      access: {
        kind: "limited",
        paid: false,
        reason: "free_signup_week",
        startDate: "2026-04-10",
        endDateExclusive: "2026-04-17",
      },
      stripeSubscriptionStatus: null,
      canManageBilling: false,
    });
  });

  it("creates a checkout session for the configured subscription price", async () => {
    stripeMocks.executeWithSchema.mockResolvedValue([
      {
        id: "user-1",
        name: "Test User",
        email: "test@example.com",
        created_at: "2026-04-10T18:30:00.000Z",
        paid_grant_reason: null,
        stripe_subscription_status: null,
        stripe_customer_id: null,
      },
    ]);
    stripeMocks.customerCreate.mockResolvedValue({ id: "cus_123" });
    stripeMocks.checkoutCreate.mockResolvedValue({
      url: "https://checkout.stripe.test/session",
    });
    const execute = vi.fn(async () => []);
    const caller = createCaller({ db: { execute }, userId: "user-1", timezone: "UTC" });

    await expect(caller.createCheckoutSession()).resolves.toEqual({
      url: "https://checkout.stripe.test/session",
    });
    expect(stripeMocks.checkoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: "cus_123",
        mode: "subscription",
        line_items: [{ price: "price_123", quantity: 1 }],
        success_url: "https://app.example.com/settings?billing=success",
        cancel_url: "https://app.example.com/settings?billing=cancel",
        client_reference_id: "user-1",
      }),
    );
  });

  it("creates a portal session for an existing Stripe customer", async () => {
    stripeMocks.executeWithSchema.mockResolvedValue([
      {
        id: "user-1",
        name: "Test User",
        email: "test@example.com",
        created_at: "2026-04-10T18:30:00.000Z",
        paid_grant_reason: null,
        stripe_subscription_status: null,
        stripe_customer_id: "cus_123",
      },
    ]);
    stripeMocks.portalCreate.mockResolvedValue({
      url: "https://billing.stripe.test/session",
    });
    const caller = createCaller({
      db: { execute: vi.fn(async () => []) },
      userId: "user-1",
      timezone: "UTC",
    });

    await expect(caller.createPortalSession()).resolves.toEqual({
      url: "https://billing.stripe.test/session",
    });
    expect(stripeMocks.portalCreate).toHaveBeenCalledWith({
      customer: "cus_123",
      return_url: "https://app.example.com/settings",
    });
  });
});
