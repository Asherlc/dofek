import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupTestDatabase, type TestContext } from "../../../../src/db/test-helpers.ts";
import { WebhookSubscriptionRepository } from "./webhook-subscription-repository.ts";

async function pendingSubscriptionIds(
  repository: WebhookSubscriptionRepository,
  providerName: string,
): Promise<string[]> {
  const ids: string[] = [];
  for await (const subscription of repository.iteratePendingByProviderName(providerName)) {
    ids.push(subscription.id);
  }
  return ids;
}

describe("WebhookSubscriptionRepository transaction visibility", () => {
  let testContext: TestContext;

  beforeAll(async () => {
    testContext = await setupTestDatabase();
  });

  afterAll(async () => {
    await testContext.cleanup();
  });

  it("exposes a pending subscription to a validation request only after its transaction commits", async () => {
    const id = randomUUID();
    const providerName = `webhook-visibility-${id}`;
    const committedRepository = new WebhookSubscriptionRepository(testContext.db);

    await testContext.db.transaction(async (transaction) => {
      const transactionRepository = new WebhookSubscriptionRepository(transaction);
      await transactionRepository.createPendingSubscription(id, {
        userId: null,
        providerId: null,
        providerName,
        verifyToken: "verification-token",
        metadata: {},
      });

      await expect(pendingSubscriptionIds(committedRepository, providerName)).resolves.toEqual([]);
    });

    await expect(pendingSubscriptionIds(committedRepository, providerName)).resolves.toEqual([id]);
  });
});
