import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { applyAppStoreNotification, BillingRepository } from "./billing-repository.ts";

const testUserId = "00000000-0000-0000-0000-000000000172";
const secondTestUserId = "00000000-0000-0000-0000-000000000173";
const tokenTestUserId = "00000000-0000-0000-0000-000000000174";
const secondTokenTestUserId = "00000000-0000-0000-0000-000000000175";
const testCustomerId = "cus_billing_webhook_test";
const firstAccountToken = "a0000000-0000-4000-8000-000000000001";
const secondAccountToken = "a0000000-0000-4000-8000-000000000002";
const appStoreNotificationUuid = "30000000-0000-4000-8000-000000000001";

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
    await testContext.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name)
          VALUES (${secondTestUserId}, 'Second Billing Webhook Test User')
          ON CONFLICT (id) DO NOTHING`,
    );
    await testContext.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name)
          VALUES
            (${tokenTestUserId}, 'App Store Token Test User'),
            (${secondTokenTestUserId}, 'Second App Store Token Test User')
          ON CONFLICT (id) DO NOTHING`,
    );
    await testContext.db.execute(
      sql`INSERT INTO fitness.user_billing (user_id, app_store_account_token)
          VALUES (${testUserId}, ${firstAccountToken}::uuid)
          ON CONFLICT (user_id) DO UPDATE
            SET app_store_account_token = EXCLUDED.app_store_account_token,
                app_store_original_transaction_id = NULL,
                app_store_transaction_id = NULL,
                app_store_product_id = NULL,
                app_store_subscription_status = NULL,
                app_store_expires_at = NULL,
                app_store_revocation_at = NULL,
                app_store_environment = NULL`,
    );
    await testContext.db.execute(
      sql`INSERT INTO fitness.user_billing (user_id, app_store_account_token)
          VALUES (${secondTestUserId}, ${secondAccountToken}::uuid)
          ON CONFLICT (user_id) DO UPDATE
            SET app_store_account_token = EXCLUDED.app_store_account_token,
                app_store_original_transaction_id = NULL,
                app_store_transaction_id = NULL,
                app_store_product_id = NULL,
                app_store_subscription_status = NULL,
                app_store_expires_at = NULL,
                app_store_revocation_at = NULL,
                app_store_environment = NULL`,
    );
  }, 120_000);

  afterAll(async () => {
    await testContext?.db.execute(
      sql`DELETE FROM fitness.app_store_notification
          WHERE notification_uuid = ${appStoreNotificationUuid}::uuid`,
    );
    await testContext?.cleanup();
  });

  beforeEach(async () => {
    await testContext.db.execute(
      sql`DELETE FROM fitness.app_store_notification
          WHERE notification_uuid = ${appStoreNotificationUuid}::uuid`,
    );
    await testContext.db.execute(
      sql`UPDATE fitness.user_billing
          SET app_store_original_transaction_id = NULL,
              app_store_transaction_id = NULL,
              app_store_product_id = NULL,
              app_store_subscription_status = NULL,
              app_store_expires_at = NULL,
              app_store_revocation_at = NULL,
              app_store_environment = NULL
          WHERE user_id IN (${testUserId}::uuid, ${secondTestUserId}::uuid)`,
    );
  });

  it("returns a stable token for one user and a distinct token for another", async () => {
    const firstToken = await repository.getOrCreateAppStoreAccountToken(tokenTestUserId);
    const repeatedToken = await repository.getOrCreateAppStoreAccountToken(tokenTestUserId);
    const otherUserToken = await repository.getOrCreateAppStoreAccountToken(secondTokenTestUserId);

    expect(repeatedToken).toBe(firstToken);
    expect(otherUserToken).not.toBe(firstToken);
    expect(firstToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(otherUserToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
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

  it("makes an exact App Store transaction replay a no-op", async () => {
    const currentUpdate = {
      accountToken: firstAccountToken,
      originalTransactionId: "100000000000001",
      transactionId: "100000000000002",
      productId: "com.dofek.premium.monthly" as const,
      status: "active" as const,
      expiresAt: new Date("2026-10-01T00:00:00.000Z"),
      revokedAt: null,
      environment: "Sandbox" as const,
    };

    await expect(repository.applyAppStoreSubscription(currentUpdate)).resolves.toEqual([
      testUserId,
    ]);
    await expect(repository.applyAppStoreSubscription(currentUpdate)).resolves.toEqual([]);
  });

  it("records a verified App Store notification and applies its state only once", async () => {
    const notification = {
      notificationUuid: appStoreNotificationUuid,
      signedDate: 1_789_488_000_000,
      subscription: {
        accountToken: firstAccountToken,
        originalTransactionId: "100000000000001",
        transactionId: "100000000000002",
        productId: "com.dofek.premium.monthly" as const,
        status: "active" as const,
        expiresAt: new Date("2026-10-01T00:00:00.000Z"),
        revokedAt: null,
        environment: "Sandbox" as const,
      },
    };

    await expect(applyAppStoreNotification(testContext.db, notification)).resolves.toEqual([
      testUserId,
    ]);
    await expect(
      applyAppStoreNotification(testContext.db, {
        ...notification,
        subscription: {
          ...notification.subscription,
          transactionId: "100000000000003",
          expiresAt: new Date("2026-11-01T00:00:00.000Z"),
        },
      }),
    ).resolves.toEqual([]);

    const rows = await testContext.db.execute<{
      app_store_transaction_id: string | null;
      notification_count: number;
    }>(
      sql`SELECT
            billing.app_store_transaction_id,
            (
              SELECT count(*)::integer
              FROM fitness.app_store_notification
              WHERE notification_uuid = ${appStoreNotificationUuid}::uuid
            ) AS notification_count
          FROM fitness.user_billing billing
          WHERE billing.user_id = ${testUserId}::uuid`,
    );
    expect(rows).toEqual([
      {
        app_store_transaction_id: "100000000000002",
        notification_count: 1,
      },
    ]);
  });

  it("does not let an older App Store expiry overwrite the stored subscription", async () => {
    const currentUpdate = {
      accountToken: firstAccountToken,
      originalTransactionId: "100000000000001",
      transactionId: "100000000000002",
      productId: "com.dofek.premium.monthly" as const,
      status: "active" as const,
      expiresAt: new Date("2026-10-01T00:00:00.000Z"),
      revokedAt: null,
      environment: "Sandbox" as const,
    };

    await expect(repository.applyAppStoreSubscription(currentUpdate)).resolves.toEqual([
      testUserId,
    ]);
    await expect(
      repository.applyAppStoreSubscription({
        ...currentUpdate,
        transactionId: "100000000000003",
        status: "expired",
        expiresAt: new Date("2026-09-01T00:00:00.000Z"),
      }),
    ).resolves.toEqual([]);

    const rows = await testContext.db.execute<{
      app_store_transaction_id: string | null;
      app_store_subscription_status: string | null;
      app_store_expires_at: string | null;
    }>(
      sql`SELECT
            app_store_transaction_id,
            app_store_subscription_status,
            app_store_expires_at::text AS app_store_expires_at
          FROM fitness.user_billing
          WHERE user_id = ${testUserId}::uuid`,
    );
    expect(rows[0]).toEqual({
      app_store_transaction_id: "100000000000002",
      app_store_subscription_status: "active",
      app_store_expires_at: "2026-10-01 00:00:00+00",
    });
  });

  it("records a same-expiry App Store revocation once", async () => {
    const currentUpdate = {
      accountToken: firstAccountToken,
      originalTransactionId: "100000000000001",
      transactionId: "100000000000002",
      productId: "com.dofek.premium.monthly" as const,
      status: "active" as const,
      expiresAt: new Date("2026-10-01T00:00:00.000Z"),
      revokedAt: null,
      environment: "Sandbox" as const,
    };
    const revokedUpdate = {
      ...currentUpdate,
      status: "revoked" as const,
      revokedAt: new Date("2026-09-20T00:00:00.000Z"),
    };

    await expect(repository.applyAppStoreSubscription(currentUpdate)).resolves.toEqual([
      testUserId,
    ]);
    await expect(repository.applyAppStoreSubscription(revokedUpdate)).resolves.toEqual([
      testUserId,
    ]);
    await expect(repository.applyAppStoreSubscription(revokedUpdate)).resolves.toEqual([]);

    const rows = await testContext.db.execute<{
      app_store_subscription_status: string | null;
      app_store_expires_at: string | null;
      app_store_revocation_at: string | null;
    }>(
      sql`SELECT
            app_store_subscription_status,
            app_store_expires_at::text AS app_store_expires_at,
            app_store_revocation_at::text AS app_store_revocation_at
          FROM fitness.user_billing
          WHERE user_id = ${testUserId}::uuid`,
    );
    expect(rows[0]).toEqual({
      app_store_subscription_status: "revoked",
      app_store_expires_at: "2026-10-01 00:00:00+00",
      app_store_revocation_at: "2026-09-20 00:00:00+00",
    });
  });

  it("rejects an App Store original transaction for another account token", async () => {
    const currentUpdate = {
      accountToken: firstAccountToken,
      originalTransactionId: "100000000000001",
      transactionId: "100000000000002",
      productId: "com.dofek.premium.monthly" as const,
      status: "active" as const,
      expiresAt: new Date("2026-10-01T00:00:00.000Z"),
      revokedAt: null,
      environment: "Sandbox" as const,
    };

    await expect(repository.applyAppStoreSubscription(currentUpdate)).resolves.toEqual([
      testUserId,
    ]);
    await expect(
      repository.applyAppStoreSubscription({
        ...currentUpdate,
        accountToken: secondAccountToken,
      }),
    ).resolves.toEqual([]);

    const rows = await testContext.db.execute<{
      user_id: string;
      app_store_original_transaction_id: string | null;
      app_store_transaction_id: string | null;
      app_store_expires_at: string | null;
    }>(
      sql`SELECT
            user_id,
            app_store_original_transaction_id,
            app_store_transaction_id,
            app_store_expires_at::text AS app_store_expires_at
          FROM fitness.user_billing
          WHERE user_id IN (${testUserId}::uuid, ${secondTestUserId}::uuid)
          ORDER BY user_id`,
    );
    expect(rows).toEqual([
      {
        user_id: testUserId,
        app_store_original_transaction_id: "100000000000001",
        app_store_transaction_id: "100000000000002",
        app_store_expires_at: "2026-10-01 00:00:00+00",
      },
      {
        user_id: secondTestUserId,
        app_store_original_transaction_id: null,
        app_store_transaction_id: null,
        app_store_expires_at: null,
      },
    ]);
  });
});
