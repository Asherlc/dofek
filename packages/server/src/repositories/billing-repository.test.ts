import { describe, expect, it, vi } from "vitest";
import { BillingRepository } from "./billing-repository.ts";

function getQueryText(query: unknown): string {
  return JSON.stringify(query);
}

describe("BillingRepository", () => {
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
      expect(queryText).toContain("<");
    });
  });
});
