import { beforeEach, describe, expect, it, vi } from "vitest";

const stripeMocks = vi.hoisted(() => ({
  executeWithSchema: vi.fn(),
  checkoutCreate: vi.fn(),
  checkoutExpire: vi.fn(),
  portalCreate: vi.fn(),
  customerCreate: vi.fn(),
  customerDelete: vi.fn(),
  captureException: vi.fn(),
  transactionExecute: vi.fn(),
  withUserWriteFence: vi.fn(),
  recordUserExternalEffect: vi.fn(),
}));

vi.mock("@sentry/node", () => ({
  captureException: stripeMocks.captureException,
}));

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{
      db: { execute: unknown; transaction: unknown };
      userId: string;
      timezone: string;
    }>()
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
    checkout: {
      sessions: {
        create: stripeMocks.checkoutCreate,
        expire: stripeMocks.checkoutExpire,
      },
    },
    billingPortal: { sessions: { create: stripeMocks.portalCreate } },
    customers: {
      create: stripeMocks.customerCreate,
      del: stripeMocks.customerDelete,
    },
  }),
}));

vi.mock("dofek/db/account-erasure", () => ({
  withAccountErasureUserWriteFence: stripeMocks.withUserWriteFence,
}));

vi.mock("dofek/db/user-external-effect", () => ({
  recordUserExternalEffect: stripeMocks.recordUserExternalEffect,
}));

import { billingRouter } from "./billing.ts";
import { createTestCallerFactory } from "./test-helpers.ts";

const createCaller = createTestCallerFactory(billingRouter);
const transaction = { execute: stripeMocks.transactionExecute };
const checkoutOperationId = "00000000-0000-4000-8000-000000000123";

function database() {
  return {
    execute: vi.fn(),
    transaction: vi.fn(),
  };
}

describe("billingRouter", () => {
  beforeEach(() => {
    stripeMocks.executeWithSchema.mockReset();
    stripeMocks.checkoutCreate.mockReset();
    stripeMocks.checkoutExpire.mockReset();
    stripeMocks.portalCreate.mockReset();
    stripeMocks.customerCreate.mockReset();
    stripeMocks.customerDelete.mockReset();
    stripeMocks.captureException.mockReset();
    stripeMocks.transactionExecute.mockReset();
    stripeMocks.withUserWriteFence.mockReset();
    stripeMocks.recordUserExternalEffect.mockReset();
    stripeMocks.recordUserExternalEffect.mockResolvedValue(undefined);
    stripeMocks.withUserWriteFence.mockImplementation(
      async (
        _database: unknown,
        _userId: string,
        operation: (database: typeof transaction) => Promise<unknown>,
      ) => operation(transaction),
    );
  });

  it("returns limited signup-week status for unpaid users", async () => {
    stripeMocks.executeWithSchema.mockResolvedValue([
      {
        id: "user-1",
        created_at: "2026-07-21T01:30:00.000Z",
        paid_grant_reason: null,
        stripe_subscription_status: null,
        stripe_customer_id: null,
      },
    ]);
    const caller = createCaller({
      db: database(),
      userId: "user-1",
      timezone: "America/Los_Angeles",
    });

    await expect(caller.status()).resolves.toEqual({
      hasFullAccess: false,
      access: {
        kind: "limited",
        paid: false,
        reason: "free_signup_week",
        startDate: "2026-07-20",
        endDateExclusive: "2026-07-27",
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
      id: "cs_123",
      url: "https://checkout.stripe.test/session",
    });
    const db = database();
    const caller = createCaller({ db, userId: "user-1", timezone: "UTC" });

    await expect(
      caller.createCheckoutSession({ operationId: checkoutOperationId }),
    ).resolves.toEqual({
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
      {
        idempotencyKey: expect.stringMatching(
          new RegExp(`^dofek-checkout-user-1-price_123-${checkoutOperationId}$`),
        ),
      },
    );
    expect(stripeMocks.checkoutCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: {
          dofekCheckoutOperationId: checkoutOperationId,
          userId: "user-1",
        },
      }),
      expect.any(Object),
    );
    expect(stripeMocks.customerCreate).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { userId: "user-1" } }),
      { idempotencyKey: "dofek-customer-user-1" },
    );
    expect(stripeMocks.withUserWriteFence).toHaveBeenCalledWith(db, "user-1", expect.any(Function));
    expect(stripeMocks.transactionExecute).toHaveBeenCalledOnce();
    expect(stripeMocks.recordUserExternalEffect).toHaveBeenCalledWith(transaction, {
      system: "stripe",
      resourceType: "customer",
      externalId: "cus_123",
      userId: "user-1",
    });
  });

  it("deletes a newly-created Stripe customer when ownership persistence fails", async () => {
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
    stripeMocks.customerCreate.mockResolvedValue({ id: "cus_orphan" });
    stripeMocks.recordUserExternalEffect.mockRejectedValue(new Error("persistence failed"));
    stripeMocks.customerDelete.mockResolvedValue({});
    const caller = createCaller({ db: database(), userId: "user-1", timezone: "UTC" });

    await expect(
      caller.createCheckoutSession({ operationId: checkoutOperationId }),
    ).rejects.toThrow("persistence failed");

    expect(stripeMocks.customerDelete).toHaveBeenCalledWith("cus_orphan");
    expect(stripeMocks.checkoutCreate).not.toHaveBeenCalled();
  });

  it("keeps Stripe resources valid when the fenced transaction commit is uncertain", async () => {
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
    stripeMocks.customerCreate.mockResolvedValue({ id: "cus_orphan" });
    stripeMocks.checkoutCreate.mockResolvedValue({
      id: "cs_orphan",
      url: "https://checkout.stripe.test/session",
    });
    stripeMocks.withUserWriteFence.mockImplementationOnce(
      async (
        _database: unknown,
        _userId: string,
        operation: (database: typeof transaction) => Promise<unknown>,
      ) => {
        await operation(transaction);
        throw new Error("commit failed");
      },
    );
    const caller = createCaller({
      db: database(),
      userId: "user-1",
      timezone: "UTC",
    });

    await expect(
      caller.createCheckoutSession({ operationId: checkoutOperationId }),
    ).rejects.toThrow("commit failed");

    expect(stripeMocks.checkoutExpire).not.toHaveBeenCalled();
    expect(stripeMocks.customerDelete).not.toHaveBeenCalled();
    expect(stripeMocks.captureException).not.toHaveBeenCalled();
  });

  it("reports the original Stripe cleanup errors when an operation fails before commit", async () => {
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
    stripeMocks.customerCreate.mockResolvedValue({ id: "cus_cleanup" });
    stripeMocks.checkoutCreate.mockResolvedValue({ id: "cs_cleanup", url: null });
    const checkoutCleanupError = new Error("raw Stripe cleanup error for cs_cleanup");
    const customerCleanupError = new Error("raw Stripe cleanup error for cus_cleanup");
    stripeMocks.checkoutExpire.mockRejectedValue(checkoutCleanupError);
    stripeMocks.customerDelete.mockRejectedValue(customerCleanupError);
    const caller = createCaller({ db: database(), userId: "user-1", timezone: "UTC" });

    await expect(
      caller.createCheckoutSession({ operationId: checkoutOperationId }),
    ).rejects.toThrow("Stripe Checkout did not return a session URL");

    expect(stripeMocks.captureException).toHaveBeenNthCalledWith(1, checkoutCleanupError, {
      tags: { source: "billing", operation: "expire-orphan-checkout-session" },
    });
    expect(stripeMocks.captureException).toHaveBeenNthCalledWith(2, customerCleanupError, {
      tags: { source: "billing", operation: "delete-orphan-stripe-customer" },
    });
  });

  it("reuses the checkout idempotency key when a response-loss retry keeps the operation ID", async () => {
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
    stripeMocks.checkoutCreate.mockResolvedValue({
      id: "cs_same",
      url: "https://checkout.stripe.test/session",
    });
    const caller = createCaller({
      db: database(),
      userId: "user-1",
      timezone: "UTC",
    });

    await caller.createCheckoutSession({ operationId: checkoutOperationId });
    await caller.createCheckoutSession({ operationId: checkoutOperationId });

    const expectedOptions = {
      idempotencyKey: `dofek-checkout-user-1-price_123-${checkoutOperationId}`,
    };
    expect(stripeMocks.checkoutCreate).toHaveBeenNthCalledWith(
      1,
      expect.any(Object),
      expectedOptions,
    );
    expect(stripeMocks.checkoutCreate).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
      expectedOptions,
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
      db: database(),
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
    expect(stripeMocks.withUserWriteFence).toHaveBeenCalledWith(
      expect.any(Object),
      "user-1",
      expect.any(Function),
    );
  });
});
