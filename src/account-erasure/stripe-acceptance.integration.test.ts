import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { setupTestDatabase, type TestContext } from "../db/test-helpers.ts";
import { failOnUnhandledExternalRequest } from "../test/msw.ts";
import { createEncryptedAccountErasureSnapshot } from "./remote-snapshot.ts";
import { eraseStripeForAcceptedAccountErasure } from "./stripe-acceptance.ts";

const server = setupServer();

describe("Stripe erasure at account-deletion acceptance (integration)", () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await setupTestDatabase();
    process.env.STRIPE_SECRET_KEY = "sk_test_acceptance";
    server.listen({ onUnhandledRequest: failOnUnhandledExternalRequest });
  }, 120_000);

  afterEach(() => {
    server.resetHandlers();
  });

  afterAll(async () => {
    server.close();
    await context?.cleanup();
  });

  async function createRequest(
    userId: string,
    requestId: string,
    options: { includeBilling?: boolean } = {},
  ): Promise<void> {
    await context.db.execute(
      sql`INSERT INTO fitness.user_profile (id, name)
          VALUES (${userId}::uuid, 'Stripe Acceptance User')`,
    );
    if (options.includeBilling !== false) {
      await context.db.execute(
        sql`INSERT INTO fitness.user_billing (
              user_id, stripe_customer_id, stripe_subscription_id
            )
            VALUES (
              ${userId}::uuid,
              ${`cus_${userId.slice(0, 8)}`},
              ${`sub_${userId.slice(0, 8)}`}
            )`,
      );
    }
    const encryptedRemoteSnapshot = await context.db.transaction((transaction) =>
      createEncryptedAccountErasureSnapshot(transaction, userId),
    );
    await context.db.execute(
      sql`INSERT INTO fitness.account_erasure_request (
            id,
            user_id,
            user_hash,
            user_hash_key_id,
            write_fence_hash,
            status_token_hash,
            encrypted_remote_snapshot,
            replay_retained_until,
            completion_deadline
          )
          VALUES (
            ${requestId}::uuid,
            ${userId}::uuid,
            ${randomUUID().replaceAll("-", "").padEnd(64, "0")},
            'test-key',
            ${randomUUID().replaceAll("-", "").padEnd(64, "1")},
            ${randomUUID().replaceAll("-", "").padEnd(64, "2")},
            ${encryptedRemoteSnapshot},
            now() + interval '7 days',
            now() + interval '30 days'
          )`,
    );
  }

  it("cancels billing and durably checkpoints before returning, once", async () => {
    const userId = "10000000-0000-4000-8000-000000001995";
    const requestId = "20000000-0000-4000-8000-000000001995";
    await createRequest(userId, requestId);
    const operations: string[] = [];
    server.use(
      http.get("https://api.stripe.com/v1/customers", () =>
        HttpResponse.json({
          data: [],
          has_more: false,
        }),
      ),
      http.delete("https://api.stripe.com/v1/subscriptions/sub_10000000", () => {
        operations.push("subscription");
        return HttpResponse.json({ id: "sub_10000000", status: "canceled" });
      }),
      http.delete("https://api.stripe.com/v1/customers/cus_10000000", () => {
        operations.push("customer");
        return HttpResponse.json({ deleted: true, id: "cus_10000000" });
      }),
    );

    await eraseStripeForAcceptedAccountErasure(context.db, requestId);
    await eraseStripeForAcceptedAccountErasure(context.db, requestId);

    expect(operations).toEqual(["subscription", "customer"]);
    const checkpoints = await context.db.execute(
      sql`SELECT phase
          FROM fitness.account_erasure_checkpoint
          WHERE request_id = ${requestId}::uuid`,
    );
    expect(checkpoints).toEqual([{ phase: "stripe_erasure" }]);
  });

  it("claims the request before remote Stripe erasure so concurrent workers share one effect", async () => {
    const userId = "11000000-0000-4000-8000-000000001995";
    const requestId = "21000000-0000-4000-8000-000000001995";
    await createRequest(userId, requestId);

    let releaseFirstCall: () => void = () => {
      throw new Error("Stripe erasure release was not initialized");
    };
    let reportFirstCallStarted: () => void = () => {
      throw new Error("Stripe erasure start signal was not initialized");
    };
    const firstCallStarted = new Promise<void>((resolve) => {
      reportFirstCallStarted = resolve;
    });
    const firstCallReleased = new Promise<void>((resolve) => {
      releaseFirstCall = resolve;
    });
    const eraseStripe = vi.fn(async () => {
      reportFirstCallStarted();
      await firstCallReleased;
      return { customersDeleted: 0, subscriptionsCanceled: 0 };
    });

    const first = eraseStripeForAcceptedAccountErasure(context.db, requestId, eraseStripe);
    await firstCallStarted;
    const second = eraseStripeForAcceptedAccountErasure(context.db, requestId, eraseStripe);
    await Promise.resolve();
    await Promise.resolve();
    expect(eraseStripe).toHaveBeenCalledTimes(1);

    releaseFirstCall();
    await Promise.all([first, second]);
    expect(eraseStripe).toHaveBeenCalledTimes(1);
  });

  it("does not checkpoint a failed cancellation and retries the same durable request", async () => {
    const userId = "30000000-0000-4000-8000-000000001995";
    const requestId = "40000000-0000-4000-8000-000000001995";
    await createRequest(userId, requestId);
    server.use(
      http.get("https://api.stripe.com/v1/customers", () =>
        HttpResponse.json({
          data: [],
          has_more: false,
        }),
      ),
      http.delete("https://api.stripe.com/v1/subscriptions/sub_30000000", () =>
        HttpResponse.json(
          { error: { code: "account_invalid", message: "Stripe account unavailable" } },
          { status: 400 },
        ),
      ),
    );

    let cancellationFailure: unknown;
    try {
      await eraseStripeForAcceptedAccountErasure(context.db, requestId);
    } catch (error: unknown) {
      cancellationFailure = error;
    }
    expect(cancellationFailure).toBeInstanceOf(Error);
    if (!(cancellationFailure instanceof Error)) {
      throw new Error("Expected a sanitized Stripe cancellation failure");
    }
    expect(cancellationFailure.message).toBe(
      "Stripe account erasure subscription cancellation failed",
    );
    expect(cancellationFailure.message).not.toContain("account_invalid");
    expect(cancellationFailure.message).not.toContain("sub_30000000");
    const failedCheckpoints = await context.db.execute(
      sql`SELECT phase
          FROM fitness.account_erasure_checkpoint
          WHERE request_id = ${requestId}::uuid`,
    );
    expect(failedCheckpoints).toEqual([]);

    server.resetHandlers();
    const operations = vi.fn();
    server.use(
      http.get("https://api.stripe.com/v1/customers", () =>
        HttpResponse.json({
          data: [],
          has_more: false,
        }),
      ),
      http.delete("https://api.stripe.com/v1/subscriptions/sub_30000000", () => {
        operations("subscription");
        return HttpResponse.json({ id: "sub_30000000", status: "canceled" });
      }),
      http.delete("https://api.stripe.com/v1/customers/cus_30000000", () => {
        operations("customer");
        return HttpResponse.json({ deleted: true, id: "cus_30000000" });
      }),
    );

    await expect(
      eraseStripeForAcceptedAccountErasure(context.db, requestId),
    ).resolves.toBeUndefined();
    expect(operations).toHaveBeenCalledTimes(2);
  });

  it("discovers and deletes a customer created before a hard kill could persist ownership", async () => {
    const userId = "50000000-0000-4000-8000-000000001995";
    const requestId = "60000000-0000-4000-8000-000000001995";
    await createRequest(userId, requestId, { includeBilling: false });
    const deletedCustomers: string[] = [];
    server.use(
      http.get("https://api.stripe.com/v1/customers", () =>
        HttpResponse.json({
          data: [
            {
              id: "cus_hard_kill_without_persistence",
              metadata: { userId },
            },
            {
              id: "cus_different_owner",
              metadata: { userId: "70000000-0000-4000-8000-000000001995" },
            },
          ],
          has_more: false,
        }),
      ),
      http.delete("https://api.stripe.com/v1/customers/:customerId", ({ params }) => {
        deletedCustomers.push(String(params.customerId));
        return HttpResponse.json({ deleted: true, id: params.customerId });
      }),
    );

    await expect(
      eraseStripeForAcceptedAccountErasure(context.db, requestId),
    ).resolves.toBeUndefined();

    expect(deletedCustomers).toEqual(["cus_hard_kill_without_persistence"]);
    const localStripeState = await context.db.execute(
      sql`SELECT
            EXISTS (
              SELECT 1 FROM fitness.user_billing WHERE user_id = ${userId}::uuid
            ) AS has_billing,
            EXISTS (
              SELECT 1 FROM fitness.user_external_effect WHERE user_id = ${userId}::uuid
            ) AS has_external_effect`,
    );
    expect(localStripeState).toEqual([
      {
        has_billing: false,
        has_external_effect: false,
      },
    ]);
    const checkpoints = await context.db.execute(
      sql`SELECT phase
          FROM fitness.account_erasure_checkpoint
          WHERE request_id = ${requestId}::uuid`,
    );
    expect(checkpoints).toEqual([{ phase: "stripe_erasure" }]);
  });
});
