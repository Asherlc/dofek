import { describe, expect, it, vi } from "vitest";
import { eraseStripeAccount } from "./remote-revocation.ts";
import type { AccountErasureRemoteSnapshot } from "./remote-snapshot.ts";

const snapshot: AccountErasureRemoteSnapshot = {
  appleCredentials: [],
  authIdentities: [],
  externalEffects: [],
  localIdentifiers: {
    activityIds: [],
    exportObjects: [],
    fileUploads: [],
    processingOperationIds: [],
    sessionIds: [],
    sleepSessionIds: [],
    userId: "10000000-0000-4000-8000-000000001994",
  },
  posthogDistinctId: "10000000-0000-4000-8000-000000001994",
  processorEmails: [],
  providerConnections: [],
  slackInstallations: [],
  stripe: null,
  webhooks: [],
};

describe("Stripe account erasure pagination", () => {
  it("fails closed when a customer-list cursor does not advance", async () => {
    const list = vi.fn(async () => ({
      data: [{ id: "cus_repeated_cursor", metadata: {} }],
      has_more: true,
    }));
    const client = {
      customers: {
        del: vi.fn(async () => ({ deleted: true })),
        list,
      },
      subscriptions: {
        cancel: vi.fn(async () => ({ status: "canceled" })),
      },
    };

    await expect(eraseStripeAccount(snapshot, client)).rejects.toThrow(
      "Stripe customer reconciliation pagination did not advance",
    );
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("fails closed at the exhaustive-list safety bound", async () => {
    let pageNumber = 0;
    const list = vi.fn(async () => {
      pageNumber += 1;
      return {
        data: [{ id: `cus_page_${pageNumber}`, metadata: {} }],
        has_more: true,
      };
    });
    const client = {
      customers: {
        del: vi.fn(async () => ({ deleted: true })),
        list,
      },
      subscriptions: {
        cancel: vi.fn(async () => ({ status: "canceled" })),
      },
    };

    await expect(eraseStripeAccount(snapshot, client)).rejects.toThrow(
      "Stripe customer reconciliation exceeded the pagination safety limit",
    );
    expect(list).toHaveBeenCalledTimes(1_000);
  });
});
