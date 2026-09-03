import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import {
  type UpsertWebhookSubscriptionInput,
  WebhookSubscriptionRepository,
} from "./webhook-subscription-repository.ts";

vi.mock("dofek/security/credential-encryption", () => ({
  decryptCredentialValue: vi.fn(async (value: string) => value),
  encryptCredentialValue: vi.fn(async (value: string) => `encrypted:${value}`),
}));

const dialect = new PgDialect();

function makeRepository() {
  const execute = vi.fn().mockResolvedValue([]);
  return {
    execute,
    repository: new WebhookSubscriptionRepository({ execute }),
  };
}

function makeInput(
  overrides: Partial<UpsertWebhookSubscriptionInput> = {},
): UpsertWebhookSubscriptionInput {
  return {
    userId: null,
    providerId: null,
    providerName: "test-provider",
    subscriptionExternalId: "subscription-1",
    verifyToken: "verify-token",
    signingSecret: "signing-secret",
    expiresAt: null,
    metadata: {},
    ...overrides,
  };
}

describe("WebhookSubscriptionRepository", () => {
  it("creates a pending app subscription before provider validation", async () => {
    const { execute, repository } = makeRepository();

    await repository.createPendingSubscription("pending-id", {
      userId: null,
      providerId: null,
      providerName: "test-provider",
      verifyToken: "verify-token",
      metadata: { callbackUrl: "https://example.test/webhook" },
    });

    const query = dialect.sqlToQuery(execute.mock.calls[0]?.[0]);
    expect(query.sql).toContain("'pending'");
    expect(query.sql).toContain("INTERVAL '5 minutes'");
    expect(query.params).toContain("test-provider");
    expect(query.params).toContain("encrypted:verify-token");
    expect(query.params).not.toContain("verify-token");
  });

  it("promotes a pending subscription after provider validation", async () => {
    const { execute, repository } = makeRepository();
    execute.mockResolvedValue([{ id: "pending-id" }]);

    await repository.activatePendingSubscription("pending-id", "test-provider", {
      subscriptionExternalId: "subscription-1",
      signingSecret: null,
      expiresAt: null,
    });

    const query = dialect.sqlToQuery(execute.mock.calls[0]?.[0]);
    expect(query.sql).toContain("status = 'active'");
    expect(query.sql).toContain("expires_at > NOW()");
    expect(query.sql).toContain("subscription_external_id");
    expect(query.params).toContain("pending-id");
    expect(query.params).toContain("subscription-1");
  });

  it("returns expired pending subscriptions with persisted remote ids", async () => {
    const { execute, repository } = makeRepository();
    execute.mockResolvedValue([{ id: "pending-id", subscription_external_id: "remote-id" }]);

    const expired = repository.iterateExpiredPendingByProviderName("test-provider");
    await expect(expired.next()).resolves.toEqual({
      done: false,
      value: { id: "pending-id", subscriptionExternalId: "remote-id" },
    });

    const query = dialect.sqlToQuery(execute.mock.calls[0]?.[0]);
    expect(query.sql).toContain("subscription_external_id");
    expect(query.sql).toContain("expires_at <= NOW()");
  });

  it("persists the remote subscription id while a row is pending", async () => {
    const { execute, repository } = makeRepository();

    await repository.recordPendingSubscriptionExternalId("pending-id", "remote-id");

    const query = dialect.sqlToQuery(execute.mock.calls[0]?.[0]);
    expect(query.sql).toContain("subscription_external_id");
    expect(query.sql).toContain("status = 'pending'");
    expect(query.params).toContain("pending-id");
    expect(query.params).toContain("remote-id");
  });

  it("deletes a pending lifecycle row by id regardless of status", async () => {
    const { execute, repository } = makeRepository();

    await repository.deletePendingSubscription("pending-id");

    const query = dialect.sqlToQuery(execute.mock.calls[0]?.[0]);
    expect(query.sql).toContain("DELETE FROM fitness.webhook_subscription");
    expect(query.sql).not.toContain("status = 'pending'");
    expect(query.params).toContain("pending-id");
  });

  it("rejects activation when the pending subscription no longer exists", async () => {
    const { repository } = makeRepository();

    await expect(
      repository.activatePendingSubscription("pending-id", "test-provider", {
        subscriptionExternalId: "subscription-1",
        signingSecret: null,
        expiresAt: null,
      }),
    ).rejects.toThrow("Pending webhook subscription was not found");
  });

  it.each([
    { userId: "user-1", providerId: null },
    { userId: null, providerId: "provider-1" },
  ])("rejects a partial user/provider identity: %o", async (identity) => {
    const { execute, repository } = makeRepository();

    await expect(repository.upsertActiveSubscription(makeInput(identity))).rejects.toThrow(
      "Webhook subscriptions require both userId and providerId, or neither",
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("uses the user-scoped conflict key when both identity fields are present", async () => {
    const { execute, repository } = makeRepository();

    await repository.upsertActiveSubscription(
      makeInput({ userId: "user-1", providerId: "provider-1" }),
    );

    const query = dialect.sqlToQuery(execute.mock.calls[0]?.[0]);
    expect(query.sql).toContain("user_id, provider_id");
    expect(query.sql).toContain("ON CONFLICT (user_id, provider_id)");
    expect(query.params).toContain("user-1");
    expect(query.params).toContain("provider-1");
  });

  it("uses the app-scoped conflict key when both identity fields are absent", async () => {
    const { execute, repository } = makeRepository();

    await repository.upsertActiveSubscription(makeInput());

    const query = dialect.sqlToQuery(execute.mock.calls[0]?.[0]);
    expect(query.sql).not.toContain("user_id, provider_id");
    expect(query.sql).toContain("ON CONFLICT (provider_name)");
  });
});
