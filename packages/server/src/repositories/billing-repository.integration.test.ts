import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { BillingRepository } from "./billing-repository.ts";

const testUserId = "00000000-0000-0000-0000-000000000172";
const testCustomerId = "cus_billing_webhook_test";

describe("BillingRepository subscription webhook updates (integration)", () => {
  let testContext: TestContext;
  let repository: BillingRepository;

  beforeAll(async () => {
    testContext = await setupTestDatabase();
    repository = new BillingRepository(testContext.db);
    await testContext.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name)
          VALUES (${testUserId}, 'Billing Webhook Test User')
          ON CONFLICT (id) DO NOTHING`,
    );
    await testContext.db.execute(
      sql`INSERT INTO fitness.user_billing (user_id, stripe_customer_id)
          VALUES (${testUserId}, ${testCustomerId})
          ON CONFLICT (user_id) DO UPDATE SET stripe_customer_id = EXCLUDED.stripe_customer_id`,
    );
  }, 120_000);

  afterAll(async () => {
    await testContext?.cleanup();
  });

  it("does not apply a duplicate event twice", async () => {
    const firstUpdatedUserIds = await repository.updateSubscriptionForStripeCustomer({
      stripeEventId: "evt_duplicate_integration",
      stripeEventCreated: 1_777_000_100,
      stripeCustomerId: testCustomerId,
      stripeSubscriptionId: "sub_first",
      stripeSubscriptionStatus: "active",
      stripeCurrentPeriodEnd: null,
    });
    const duplicateUpdatedUserIds = await repository.updateSubscriptionForStripeCustomer({
      stripeEventId: "evt_duplicate_integration",
      stripeEventCreated: 1_777_000_100,
      stripeCustomerId: testCustomerId,
      stripeSubscriptionId: "sub_second",
      stripeSubscriptionStatus: "canceled",
      stripeCurrentPeriodEnd: null,
    });
    expect(firstUpdatedUserIds).toEqual([testUserId]);
    expect(duplicateUpdatedUserIds).toEqual([]);

    const rows = await testContext.db.execute<{
      stripe_subscription_id: string;
      stripe_subscription_status: string;
    }>(
      sql`SELECT stripe_subscription_id, stripe_subscription_status
          FROM fitness.user_billing
          WHERE user_id = ${testUserId}`,
    );
    expect(rows[0]).toEqual({
      stripe_subscription_id: "sub_first",
      stripe_subscription_status: "active",
    });
  });

  it("does not let an older event overwrite the newer event", async () => {
    const newerUpdatedUserIds = await repository.updateSubscriptionForStripeCustomer({
      stripeEventId: "evt_newer_integration",
      stripeEventCreated: 1_777_000_200,
      stripeCustomerId: testCustomerId,
      stripeSubscriptionId: "sub_newer",
      stripeSubscriptionStatus: "canceled",
      stripeCurrentPeriodEnd: null,
    });
    const olderUpdatedUserIds = await repository.updateSubscriptionForStripeCustomer({
      stripeEventId: "evt_older_integration",
      stripeEventCreated: 1_777_000_100,
      stripeCustomerId: testCustomerId,
      stripeSubscriptionId: "sub_older",
      stripeSubscriptionStatus: "active",
      stripeCurrentPeriodEnd: null,
    });
    expect(newerUpdatedUserIds).toEqual([testUserId]);
    expect(olderUpdatedUserIds).toEqual([]);

    const rows = await testContext.db.execute<{
      stripe_subscription_id: string;
      stripe_subscription_status: string;
    }>(
      sql`SELECT stripe_subscription_id, stripe_subscription_status
          FROM fitness.user_billing
          WHERE user_id = ${testUserId}`,
    );
    expect(rows[0]).toEqual({
      stripe_subscription_id: "sub_newer",
      stripe_subscription_status: "canceled",
    });
  });
});
