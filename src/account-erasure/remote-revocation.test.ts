import { afterEach, describe, expect, it, vi } from "vitest";

const remoteMocks = vi.hoisted(() => ({
  revokeAppleCredential: vi.fn(async () => undefined),
  revokeToken: vi.fn(async () => undefined),
}));

vi.mock("../auth/apple-credential-revocation.ts", () => ({
  revokeAppleCredential: remoteMocks.revokeAppleCredential,
}));
vi.mock("../auth/oauth.ts", () => ({
  revokeToken: remoteMocks.revokeToken,
}));

import type { Provider, ProviderAuthSetup } from "../providers/types.ts";
import { eraseStripeAccount, revokeRemoteAccounts } from "./remote-revocation.ts";
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
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("discovers, deduplicates, cancels, and deletes Stripe resources", async () => {
    const list = vi
      .fn()
      .mockResolvedValueOnce({
        data: [
          { id: "cus-match-1", metadata: { userId: snapshot.localIdentifiers.userId } },
          { id: "cus-other", metadata: { userId: "other-user" } },
        ],
        has_more: true,
      })
      .mockResolvedValueOnce({
        data: [{ id: "cus-match-2", metadata: { userId: snapshot.localIdentifiers.userId } }],
        has_more: false,
      });
    const del = vi
      .fn()
      .mockResolvedValueOnce({ deleted: true })
      .mockRejectedValueOnce({ code: "resource_missing", statusCode: 404 });
    const cancel = vi.fn(async () => ({ status: "canceled" }));
    const client = {
      customers: { del, list },
      subscriptions: { cancel },
    };
    const stripeSnapshot: AccountErasureRemoteSnapshot = {
      ...snapshot,
      externalEffects: [
        {
          contactEmail: null,
          externalId: "cus-effect",
          resourceType: "customer",
          system: "stripe",
        },
      ],
      stripe: { customerId: "cus-snapshot", subscriptionId: "sub-snapshot" },
    };

    await expect(eraseStripeAccount(stripeSnapshot, client)).resolves.toEqual({
      customersDeleted: 3,
      subscriptionsCanceled: 1,
    });
    expect(cancel).toHaveBeenCalledWith("sub-snapshot");
    expect(del).toHaveBeenCalledTimes(4);
    expect(list).toHaveBeenNthCalledWith(1, { limit: 100 });
    expect(list).toHaveBeenNthCalledWith(2, { limit: 100, starting_after: "cus-other" });
  });

  it("redacts Stripe failures and requires credentials when no client is supplied", async () => {
    const client = {
      customers: {
        del: vi.fn(async () => {
          throw new Error("provider failure");
        }),
        list: vi.fn(async () => ({ data: [], has_more: false })),
      },
      subscriptions: { cancel: vi.fn(async () => ({ status: "canceled" })) },
    };
    const stripeSnapshot: AccountErasureRemoteSnapshot = {
      ...snapshot,
      stripe: { customerId: "cus-failure", subscriptionId: null },
    };
    await expect(eraseStripeAccount(stripeSnapshot, client)).rejects.toThrow(
      "Stripe account erasure customer deletion failed",
    );

    vi.stubEnv("STRIPE_SECRET_KEY", "");
    await expect(eraseStripeAccount(snapshot)).rejects.toThrow(
      "STRIPE_SECRET_KEY is required for account erasure",
    );
  });
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

describe("remote account revocation", () => {
  const tokenSet = {
    accessToken: "access",
    expiresAt: new Date("2026-07-26T12:00:00.000Z"),
    providerAccountId: "provider-account",
    refreshToken: "refresh",
    scopes: "read",
  };

  function providerWithSetup(id: string, setup: ProviderAuthSetup): Provider {
    return {
      authSetup: () => setup,
      id,
      importOnly: true,
      name: id,
      validate: () => null,
    };
  }

  it("revokes Apple, Slack, webhooks, and every provider token policy", async () => {
    remoteMocks.revokeAppleCredential.mockClear();
    remoteMocks.revokeToken.mockClear();
    const directRevoke = vi.fn(async () => undefined);
    const existingRevoke = vi.fn(async () => undefined);
    const fallbackRevoke = vi.fn(async () => {
      throw new Error("provider-specific revocation unavailable");
    });
    const unregisterWebhook = vi.fn(async () => undefined);
    const webhookProvider = Object.assign(providerWithSetup("webhook-provider", {}), {
      registerWebhook: async () => ({ subscriptionId: "unused" }),
      unregisterWebhook,
      verifyWebhookSignature: () => true,
      parseWebhookPayload: () => [],
      webhookScope: "user",
    });
    const providers = [
      webhookProvider,
      providerWithSetup("direct-provider", { revokeTokensForAccountErasure: directRevoke }),
      providerWithSetup("existing-provider", { revokeExistingTokens: existingRevoke }),
      providerWithSetup("fallback-provider", {
        oauthConfig: {
          authorizeUrl: "https://provider.test/authorize",
          clientId: "client",
          redirectUri: "https://app.test/callback",
          revokeUrl: "https://provider.test/revoke",
          scopes: [],
          tokenUrl: "https://provider.test/token",
        },
        revokeExistingTokens: fallbackRevoke,
      }),
    ];
    const providerSnapshot: AccountErasureRemoteSnapshot = {
      ...snapshot,
      appleCredentials: [
        {
          accessToken: "apple-access",
          clientId: "com.dofek.app",
          providerAccountId: "apple-account",
          refreshToken: "apple-refresh",
        },
      ],
      providerConnections: [
        { disposition: "no_remote_authorization", providerId: "none" },
        {
          ...tokenSet,
          disposition: "revocation_credentials",
          providerId: "direct-provider",
          expiresAt: tokenSet.expiresAt.toISOString(),
        },
        {
          ...tokenSet,
          disposition: "revocation_credentials",
          providerId: "existing-provider",
          expiresAt: tokenSet.expiresAt.toISOString(),
        },
        {
          ...tokenSet,
          disposition: "revocation_credentials",
          providerId: "fallback-provider",
          expiresAt: tokenSet.expiresAt.toISOString(),
        },
      ],
      slackInstallations: [
        { botToken: "multi-member", memberCount: 2, slackUserId: "U1", teamId: "T1" },
        { botToken: "sole-member", memberCount: 1, slackUserId: "U2", teamId: "T2" },
      ],
      webhooks: [{ providerId: "webhook-provider", subscriptionExternalId: "sub-1" }],
    };
    const fetchFn: typeof globalThis.fetch = async (_input, init) => {
      expect(init?.method).toBe("POST");
      return Response.json({ ok: true, revoked: true });
    };

    await expect(revokeRemoteAccounts(providerSnapshot, providers, fetchFn)).resolves.toEqual([
      { disposition: "no_remote_authorization", providerId: "none" },
      { disposition: "remote_revoked", providerId: "direct-provider" },
      { disposition: "remote_revoked", providerId: "existing-provider" },
      { disposition: "remote_revoked", providerId: "fallback-provider" },
    ]);
    expect(remoteMocks.revokeAppleCredential).toHaveBeenCalledOnce();
    expect(directRevoke).toHaveBeenCalledWith(
      expect.objectContaining({ providerAccountId: "provider-account" }),
    );
    expect(existingRevoke).toHaveBeenCalledOnce();
    expect(fallbackRevoke).toHaveBeenCalledOnce();
    expect(remoteMocks.revokeToken).toHaveBeenCalledTimes(2);
    expect(unregisterWebhook).toHaveBeenCalledWith("sub-1");
  });

  it.each([
    "account_inactive",
    "already_revoked",
    "token_revoked",
  ])("accepts an idempotent Slack revocation error: %s", async (error) => {
    const slackSnapshot: AccountErasureRemoteSnapshot = {
      ...snapshot,
      slackInstallations: [
        { botToken: "sole-member", memberCount: 1, slackUserId: "U1", teamId: "T1" },
      ],
    };
    await expect(
      revokeRemoteAccounts(slackSnapshot, [], async () =>
        Response.json({ error, ok: false }, { status: 200 }),
      ),
    ).resolves.toEqual([]);
  });

  it("fails closed when a Slack installation is not revoked", async () => {
    const slackSnapshot: AccountErasureRemoteSnapshot = {
      ...snapshot,
      slackInstallations: [
        { botToken: "sole-member", memberCount: 1, slackUserId: "U1", teamId: "T1" },
      ],
    };
    await expect(
      revokeRemoteAccounts(slackSnapshot, [], async () =>
        Response.json({ error: "not_allowed", ok: false }, { status: 200 }),
      ),
    ).rejects.toThrow("Slack installation revocation failed: not_allowed");
  });
});
