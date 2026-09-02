import { describe, expect, it, vi } from "vitest";
import { applyAppStoreNotification, BillingRepository } from "./billing-repository.ts";

function getQueryText(query: unknown): string {
  return JSON.stringify(query);
}

describe("BillingRepository", () => {
  it("atomically returns one stable App Store account token", async () => {
    const execute = vi.fn(async () => [
      { app_store_account_token: "a0000000-0000-4000-8000-000000000001" },
    ]);
    const repository = new BillingRepository({ execute });

    await expect(repository.getOrCreateAppStoreAccountToken("user-1")).resolves.toBe(
      "a0000000-0000-4000-8000-000000000001",
    );

    const queryText = getQueryText(execute.mock.calls[0]?.[0]);
    expect(queryText).toContain("gen_random_uuid");
    expect(queryText).toContain("COALESCE");
    expect(queryText).toContain("app_store_account_token");
  });

  it("fails when App Store account token creation returns no row", async () => {
    const repository = new BillingRepository({ execute: vi.fn(async () => []) });

    await expect(repository.getOrCreateAppStoreAccountToken("user-1")).rejects.toThrow(
      "Failed to create App Store account token for user user-1",
    );
  });

  it("returns no owner when an App Store account token is not found", async () => {
    const repository = new BillingRepository({ execute: vi.fn(async () => []) });

    await expect(
      repository.findUserIdByAppStoreAccountToken("a0000000-0000-4000-8000-000000000001"),
    ).resolves.toBeNull();
  });

  it("reports when Stripe billing can be managed", async () => {
    const repository = new BillingRepository({
      execute: vi.fn(async () => [
        {
          created_at: "2026-01-01T00:00:00.000Z",
          paid_grant_reason: null,
          stripe_subscription_status: null,
          stripe_customer_id: "cus_123",
          app_store_product_id: null,
          app_store_subscription_status: null,
          app_store_expires_at: null,
          app_store_revocation_at: null,
        },
      ]),
    });

    await expect(repository.getAccessStatus("user-1", "UTC")).resolves.toMatchObject({
      canManageBilling: true,
    });
  });

  it("applies a subscription after reserving a new notification UUID", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([{ notification_uuid: "30000000-0000-4000-8000-000000000001" }])
      .mockResolvedValueOnce([{ user_id: "user-1" }]);
    const db = {
      transaction: async (operation: (transaction: { execute: typeof execute }) => unknown) =>
        operation({ execute }),
    };

    await expect(
      applyAppStoreNotification(db, {
        notificationUuid: "30000000-0000-4000-8000-000000000001",
        signedDate: 1,
        subscription: {
          accountToken: "a0000000-0000-4000-8000-000000000001",
          originalTransactionId: "100000000000001",
          transactionId: "100000000000002",
          productId: "com.dofek.premium.monthly",
          status: "active",
          expiresAt: new Date("2026-10-01T00:00:00.000Z"),
          revokedAt: null,
          environment: "Sandbox",
        },
      }),
    ).resolves.toEqual(["user-1"]);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("does not look up an owner for a new test notification", async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([{ notification_uuid: "30000000-0000-4000-8000-000000000001" }]);
    const db = {
      transaction: async (operation: (transaction: { execute: typeof execute }) => unknown) =>
        operation({ execute }),
    };

    await expect(
      applyAppStoreNotification(db, {
        notificationUuid: "30000000-0000-4000-8000-000000000001",
        signedDate: 1,
        subscription: null,
      }),
    ).resolves.toEqual([]);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("returns null when a user has no billing row", async () => {
    const execute = vi.fn(async () => []);
    const repository = new BillingRepository({ execute });

    await expect(repository.findByUserId("user-1")).resolves.toBeNull();
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ queryChunks: expect.any(Array) }),
    );
  });

  it("upserts an existing-account paid grant", async () => {
    const execute = vi.fn(async () => []);
    const repository = new BillingRepository({ execute });

    await repository.upsertPaidGrant("user-1", "existing_account");

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ queryChunks: expect.any(Array) }),
    );
  });

  describe("subscription webhook updates", () => {
    it("records each event ID before applying it so duplicate deliveries are harmless", async () => {
      const execute = vi.fn(async () => []);
      const repository = new BillingRepository({ execute });

      await repository.updateSubscriptionForStripeCustomer({
        stripeEventId: "evt_duplicate",
        stripeEventCreated: 1_777_000_100,
        stripeCustomerId: "cus_123",
        stripeSubscriptionId: "sub_123",
        stripeSubscriptionStatus: "active",
        stripeCurrentPeriodEnd: null,
      });

      const queryText = getQueryText(execute.mock.calls[0]?.[0]);
      expect(queryText).toContain("stripe_webhook_event");
      expect(queryText).toContain("ON CONFLICT");
      expect(queryText).toContain("recorded_event");
      expect(queryText).toContain("evt_duplicate");
    });

    it("guards billing updates against older event timestamps", async () => {
      const execute = vi.fn(async () => []);
      const repository = new BillingRepository({ execute });

      await repository.updateSubscriptionForStripeCustomer({
        stripeEventId: "evt_older",
        stripeEventCreated: 1_777_000_099,
        stripeCustomerId: "cus_123",
        stripeSubscriptionId: "sub_123",
        stripeSubscriptionStatus: "canceled",
        stripeCurrentPeriodEnd: null,
      });

      const queryText = getQueryText(execute.mock.calls[0]?.[0]);
      expect(queryText).toContain("stripe_subscription_event_created");
      expect(queryText).toContain("<");
    });
  });

  describe("App Store subscription updates", () => {
    it("only updates the billing row that owns the verified account token", async () => {
      const execute = vi.fn(async () => []);
      const repository = new BillingRepository({ execute });

      await repository.applyAppStoreSubscription({
        accountToken: "a0000000-0000-4000-8000-000000000001",
        originalTransactionId: "100000000000001",
        transactionId: "100000000000002",
        productId: "com.dofek.premium.monthly",
        status: "active",
        expiresAt: new Date("2026-10-01T00:00:00.000Z"),
        revokedAt: null,
        environment: "Sandbox",
      });

      const queryText = getQueryText(execute.mock.calls[0]?.[0]);
      expect(queryText).toContain("app_store_account_token");
      expect(queryText).toContain("a0000000-0000-4000-8000-000000000001");
      expect(queryText).toContain("app_store_expires_at");
    });

    it("does not let an older App Store expiry replace the current subscription", async () => {
      const execute = vi.fn(async () => []);
      const repository = new BillingRepository({ execute });

      await repository.applyAppStoreSubscription({
        accountToken: "a0000000-0000-4000-8000-000000000001",
        originalTransactionId: "100000000000001",
        transactionId: "100000000000003",
        productId: "com.dofek.premium.monthly",
        status: "expired",
        expiresAt: new Date("2026-09-01T00:00:00.000Z"),
        revokedAt: null,
        environment: "Production",
      });

      const queryText = getQueryText(execute.mock.calls[0]?.[0]);
      expect(queryText).toContain("app_store_expires_at");
      expect(queryText).toContain("> app_store_expires_at");
    });

    it("permits a terminal status to replace an active subscription at the same expiry", async () => {
      const execute = vi.fn(async () => []);
      const repository = new BillingRepository({ execute });

      await repository.applyAppStoreSubscription({
        accountToken: "a0000000-0000-4000-8000-000000000001",
        originalTransactionId: "100000000000001",
        transactionId: "100000000000002",
        productId: "com.dofek.premium.monthly",
        status: "revoked",
        expiresAt: new Date("2026-10-01T00:00:00.000Z"),
        revokedAt: new Date("2026-09-20T00:00:00.000Z"),
        environment: "Sandbox",
      });

      const queryText = getQueryText(execute.mock.calls[0]?.[0]);
      expect(queryText).toContain("app_store_subscription_status <> 'revoked'");
      expect(queryText).toContain("<> 'active'");
    });

    it("permits a revocation to replace a subscription with a later expiry", async () => {
      const execute = vi.fn(async () => []);
      const repository = new BillingRepository({ execute });

      await repository.applyAppStoreSubscription({
        accountToken: "a0000000-0000-4000-8000-000000000001",
        originalTransactionId: "100000000000001",
        transactionId: "100000000000002",
        productId: "com.dofek.premium.monthly",
        status: "revoked",
        expiresAt: new Date("2026-09-01T00:00:00.000Z"),
        revokedAt: new Date("2026-09-20T00:00:00.000Z"),
        environment: "Sandbox",
      });

      const queryText = getQueryText(execute.mock.calls[0]?.[0]);
      expect(queryText).toContain("= 'revoked'");
    });
  });
});
