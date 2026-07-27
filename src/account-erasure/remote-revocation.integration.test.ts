import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CorosProvider } from "../providers/coros.ts";
import { DecathlonProvider } from "../providers/decathlon.ts";
import { FitbitProvider } from "../providers/fitbit/provider.ts";
import { KomootProvider } from "../providers/komoot.ts";
import { MapMyFitnessProvider } from "../providers/mapmyfitness.ts";
import { SuuntoProvider } from "../providers/suunto.ts";
import type { Provider } from "../providers/types.ts";
import { failOnUnhandledExternalRequest } from "../test/msw.ts";
import { eraseStripeAccount, revokeRemoteAccounts } from "./remote-revocation.ts";
import type { AccountErasureRemoteSnapshot } from "./remote-snapshot.ts";

async function generateTestKeyPem(): Promise<string> {
  const keyPair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const exported = await crypto.subtle.exportKey("pkcs8", keyPair.privateKey);
  const base64 = Buffer.from(exported).toString("base64");
  return `-----BEGIN PRIVATE KEY-----\n${base64}\n-----END PRIVATE KEY-----`;
}

const snapshot: AccountErasureRemoteSnapshot = {
  authIdentities: [],
  appleCredentials: [
    {
      accessToken: "apple-access",
      clientId: "com.dofek.app",
      providerAccountId: "apple-user",
      refreshToken: "apple-refresh",
    },
  ],
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
  processorEmails: ["erase@example.test"],
  posthogDistinctId: "10000000-0000-4000-8000-000000001994",
  providerConnections: [],
  slackInstallations: [],
  stripe: {
    customerId: "cus_erase",
    subscriptionId: "sub_erase",
  },
  webhooks: [],
};

const server = setupServer();

describe("remote account revocation (integration)", () => {
  beforeAll(async () => {
    server.listen({ onUnhandledRequest: failOnUnhandledExternalRequest });
    process.env.APPLE_TEAM_ID = "APPLE_TEAM";
    process.env.APPLE_KEY_ID = "APPLE_KEY";
    process.env.APPLE_PRIVATE_KEY = await generateTestKeyPem();
    process.env.COROS_CLIENT_ID = "coros-client";
    process.env.COROS_CLIENT_SECRET = "coros-secret";
    process.env.DECATHLON_CLIENT_ID = "decathlon-client";
    process.env.DECATHLON_CLIENT_SECRET = "decathlon-secret";
    process.env.FITBIT_CLIENT_ID = "fitbit-client";
    process.env.FITBIT_CLIENT_SECRET = "fitbit-secret";
    process.env.KOMOOT_CLIENT_ID = "komoot-client";
    process.env.KOMOOT_CLIENT_SECRET = "komoot-secret";
    process.env.MAPMYFITNESS_CLIENT_ID = "mapmyfitness-client";
    process.env.MAPMYFITNESS_CLIENT_SECRET = "mapmyfitness-secret";
    process.env.STRIPE_SECRET_KEY = "sk_test_erasure";
    process.env.SUUNTO_CLIENT_ID = "suunto-client";
    process.env.SUUNTO_CLIENT_SECRET = "suunto-secret";
  });

  afterEach(() => {
    server.resetHandlers();
  });

  afterAll(() => {
    server.close();
  });

  it("revokes Apple refresh credentials, cancels Stripe, and deletes the customer", async () => {
    const operations: string[] = [];
    server.use(
      http.post("https://appleid.apple.com/auth/revoke", async ({ request }) => {
        const body = new URLSearchParams(await request.text());
        expect(body.get("client_id")).toBe("com.dofek.app");
        expect(body.get("client_secret")?.split(".")).toHaveLength(3);
        expect(body.get("token")).toBe("apple-refresh");
        expect(body.get("token_type_hint")).toBe("refresh_token");
        operations.push("apple");
        return new HttpResponse(null, { status: 200 });
      }),
      http.get("https://api.stripe.com/v1/customers", () =>
        HttpResponse.json({
          data: [],
          has_more: false,
          object: "list",
          url: "/v1/customers",
        }),
      ),
      http.delete("https://api.stripe.com/v1/subscriptions/sub_erase", ({ request }) => {
        expect(request.headers.get("authorization")).toBe("Bearer sk_test_erasure");
        operations.push("stripe-subscription");
        return HttpResponse.json({ id: "sub_erase", status: "canceled" });
      }),
      http.delete("https://api.stripe.com/v1/customers/cus_erase", () => {
        operations.push("stripe-customer");
        return HttpResponse.json({ deleted: true, id: "cus_erase" });
      }),
    );

    await eraseStripeAccount(snapshot);
    await revokeRemoteAccounts(snapshot, []);

    expect(operations).toEqual(["stripe-subscription", "stripe-customer", "apple"]);
  });

  it("treats already-removed Stripe resources as an idempotent success", async () => {
    server.use(
      http.post(
        "https://appleid.apple.com/auth/revoke",
        () => new HttpResponse(null, { status: 200 }),
      ),
      http.get("https://api.stripe.com/v1/customers", () =>
        HttpResponse.json({
          data: [],
          has_more: false,
          object: "list",
          url: "/v1/customers",
        }),
      ),
      http.delete("https://api.stripe.com/v1/subscriptions/sub_erase", () =>
        HttpResponse.json(
          { error: { code: "resource_missing", message: "No such subscription" } },
          { status: 404 },
        ),
      ),
      http.delete("https://api.stripe.com/v1/customers/cus_erase", () =>
        HttpResponse.json(
          { error: { code: "resource_missing", message: "No such customer" } },
          { status: 404 },
        ),
      ),
    );

    await expect(eraseStripeAccount(snapshot)).resolves.toEqual({
      customersDeleted: 0,
      subscriptionsCanceled: 0,
    });
  });

  it("discovers a hard-kill orphan by exact metadata and proves replay is empty", async () => {
    const userId = snapshot.localIdentifiers.userId;
    const deletedCustomers = new Set<string>();
    server.use(
      http.get("https://api.stripe.com/v1/customers", ({ request }) => {
        const cursor = new URL(request.url).searchParams.get("starting_after");
        if (deletedCustomers.size > 0) {
          return HttpResponse.json({
            data: [
              {
                id: "cus_other_user",
                metadata: { userId: "90000000-0000-4000-8000-000000001994" },
              },
            ],
            has_more: false,
          });
        }
        if (cursor === null) {
          return HttpResponse.json({
            data: [
              {
                id: "cus_other_user",
                metadata: { userId: "90000000-0000-4000-8000-000000001994" },
              },
              {
                id: "cus_hard_kill_one",
                metadata: { userId },
              },
            ],
            has_more: true,
          });
        }
        expect(cursor).toBe("cus_hard_kill_one");
        return HttpResponse.json({
          data: [
            {
              id: "cus_hard_kill_two",
              metadata: { userId },
            },
          ],
          has_more: false,
        });
      }),
      http.delete("https://api.stripe.com/v1/customers/:customerId", ({ params }) => {
        deletedCustomers.add(String(params.customerId));
        return HttpResponse.json({ deleted: true, id: params.customerId });
      }),
    );
    const orphanedCustomerSnapshot: AccountErasureRemoteSnapshot = {
      ...snapshot,
      appleCredentials: [],
      stripe: null,
    };

    await expect(eraseStripeAccount(orphanedCustomerSnapshot)).resolves.toEqual({
      customersDeleted: 2,
      subscriptionsCanceled: 0,
    });
    await expect(eraseStripeAccount(orphanedCustomerSnapshot)).resolves.toEqual({
      customersDeleted: 0,
      subscriptionsCanceled: 0,
    });
    expect([...deletedCustomers]).toEqual(["cus_hard_kill_one", "cus_hard_kill_two"]);
  });

  it("deletes every recorded Stripe customer exactly once", async () => {
    const deletedCustomers: string[] = [];
    server.use(
      http.get("https://api.stripe.com/v1/customers", () =>
        HttpResponse.json({
          data: [
            {
              id: "cus_recorded",
              metadata: { userId: snapshot.localIdentifiers.userId },
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
    const recordedCustomerSnapshot: AccountErasureRemoteSnapshot = {
      ...snapshot,
      appleCredentials: [],
      externalEffects: [
        {
          contactEmail: null,
          externalId: "cus_recorded",
          resourceType: "customer",
          system: "stripe",
        },
        {
          contactEmail: null,
          externalId: "cus_external_effect",
          resourceType: "customer",
          system: "stripe",
        },
      ],
      stripe: {
        customerId: "cus_recorded",
        subscriptionId: null,
      },
    };

    await expect(eraseStripeAccount(recordedCustomerSnapshot)).resolves.toEqual({
      customersDeleted: 2,
      subscriptionsCanceled: 0,
    });
    expect(deletedCustomers).toEqual(["cus_recorded", "cus_external_effect"]);
  });

  it("fails closed when Apple reports an invalid grant instead of acknowledging revocation", async () => {
    server.use(
      http.post("https://appleid.apple.com/auth/revoke", () =>
        HttpResponse.json({ error: "invalid_grant" }, { status: 400 }),
      ),
      http.delete("https://api.stripe.com/v1/subscriptions/sub_erase", () =>
        HttpResponse.json({ deleted: true }),
      ),
      http.delete("https://api.stripe.com/v1/customers/cus_erase", () =>
        HttpResponse.json({ deleted: true }),
      ),
    );

    await expect(revokeRemoteAccounts(snapshot, [])).rejects.toThrow(
      "Apple credential revocation failed (400)",
    );
  });

  it("revokes only sole-member Slack installations", async () => {
    const revokedTokens: string[] = [];
    server.use(
      http.post("https://slack.com/api/auth.revoke", ({ request }) => {
        revokedTokens.push(request.headers.get("authorization") ?? "");
        return HttpResponse.json({ ok: true, revoked: true });
      }),
    );
    const slackSnapshot: AccountErasureRemoteSnapshot = {
      ...snapshot,
      appleCredentials: [],
      slackInstallations: [
        {
          botToken: "xoxb-sole-member",
          memberCount: 1,
          slackUserId: "U-SOLE",
          teamId: "T-SOLE",
        },
        {
          botToken: "xoxb-shared",
          memberCount: 2,
          slackUserId: "U-SHARED",
          teamId: "T-SHARED",
        },
      ],
      stripe: null,
    };

    await expect(revokeRemoteAccounts(slackSnapshot, [])).resolves.toEqual([]);
    expect(revokedTokens).toEqual(["Bearer xoxb-sole-member"]);
  });

  it("treats an already-revoked Slack installation as idempotent", async () => {
    server.use(
      http.post("https://slack.com/api/auth.revoke", () =>
        HttpResponse.json({ error: "token_revoked", ok: false }),
      ),
    );
    const slackSnapshot: AccountErasureRemoteSnapshot = {
      ...snapshot,
      appleCredentials: [],
      slackInstallations: [
        {
          botToken: "xoxb-already-revoked",
          memberCount: 1,
          slackUserId: "U-REVOKED",
          teamId: "T-REVOKED",
        },
      ],
      stripe: null,
    };

    await expect(revokeRemoteAccounts(slackSnapshot, [])).resolves.toEqual([]);
  });

  it("fails closed when Slack does not acknowledge revocation", async () => {
    server.use(
      http.post("https://slack.com/api/auth.revoke", () =>
        HttpResponse.json({ ok: true, revoked: false }),
      ),
    );
    const slackSnapshot: AccountErasureRemoteSnapshot = {
      ...snapshot,
      appleCredentials: [],
      slackInstallations: [
        {
          botToken: "xoxb-not-revoked",
          memberCount: 1,
          slackUserId: "U-NOT-REVOKED",
          teamId: "T-NOT-REVOKED",
        },
      ],
      stripe: null,
    };

    await expect(revokeRemoteAccounts(slackSnapshot, [])).rejects.toThrow(
      "Slack installation revocation failed",
    );
  });

  it("fails the phase when Apple revocation is not acknowledged", async () => {
    server.use(
      http.post("https://appleid.apple.com/auth/revoke", () =>
        HttpResponse.json({ error: "server_error" }, { status: 503 }),
      ),
    );
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    await expect(revokeRemoteAccounts(snapshot, [])).rejects.toThrow(
      "Apple credential revocation failed (503)",
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });

  it("fails closed when a provider has no explicitly reviewed revocation policy", async () => {
    const provider: Provider = {
      authSetup: () => ({}),
      id: "unreviewed-provider",
      importOnly: true,
      name: "Unreviewed Provider",
      validate: () => null,
    };
    const providerSnapshot: AccountErasureRemoteSnapshot = {
      ...snapshot,
      appleCredentials: [],
      providerConnections: [
        {
          accessToken: "access",
          disposition: "revocation_credentials",
          expiresAt: "2026-07-26T12:00:00.000Z",
          providerId: provider.id,
          refreshToken: null,
          scopes: null,
        },
      ],
      stripe: null,
    };

    await expect(revokeRemoteAccounts(providerSnapshot, [provider])).rejects.toThrow(
      "Provider unreviewed-provider has no account-erasure revocation policy",
    );
  });

  it("uses provider account-erasure semantics without weakening reconnect revocation", async () => {
    const revokeForAccountErasure = vi.fn(async () => undefined);
    const revokeExistingTokens = vi.fn(async () => undefined);
    const provider: Provider = {
      authSetup: () => ({
        revokeExistingTokens,
        revokeTokensForAccountErasure: revokeForAccountErasure,
      }),
      id: "durable-provider",
      importOnly: true,
      name: "Durable Provider",
      validate: () => null,
    };
    const providerSnapshot: AccountErasureRemoteSnapshot = {
      ...snapshot,
      appleCredentials: [],
      providerConnections: [
        {
          accessToken: "access",
          disposition: "revocation_credentials",
          expiresAt: "2026-07-26T12:00:00.000Z",
          providerAccountId: "provider-account-1",
          providerId: provider.id,
          refreshToken: null,
          scopes: null,
        },
      ],
      stripe: null,
    };

    await expect(revokeRemoteAccounts(providerSnapshot, [provider])).resolves.toEqual([
      {
        disposition: "remote_revoked",
        providerId: provider.id,
      },
    ]);
    expect(revokeForAccountErasure).toHaveBeenCalledWith(
      expect.objectContaining({ providerAccountId: "provider-account-1" }),
    );
    expect(revokeExistingTokens).not.toHaveBeenCalled();
  });

  it("revokes Fitbit access and refresh credentials through Fitbit's consent endpoint", async () => {
    const revokedTokens: string[] = [];
    server.use(
      http.post("https://api.fitbit.com/oauth2/revoke", async ({ request }) => {
        expect(request.headers.get("authorization")).toBe(
          `Basic ${Buffer.from("fitbit-client:fitbit-secret").toString("base64")}`,
        );
        const body = new URLSearchParams(await request.text());
        revokedTokens.push(body.get("token") ?? "");
        return new HttpResponse(null, { status: 200 });
      }),
    );
    const providerSnapshot: AccountErasureRemoteSnapshot = {
      ...snapshot,
      appleCredentials: [],
      providerConnections: [
        {
          accessToken: "historical-access",
          disposition: "revocation_credentials",
          expiresAt: "2026-07-26T12:00:00.000Z",
          providerId: "fitbit",
          refreshToken: "historical-refresh",
          scopes: null,
        },
      ],
      stripe: null,
    };

    await expect(revokeRemoteAccounts(providerSnapshot, [new FitbitProvider()])).resolves.toEqual([
      {
        disposition: "remote_revoked",
        providerId: "fitbit",
      },
    ]);
    expect(revokedTokens).toEqual(["historical-access", "historical-refresh"]);
  });

  it("replays each active provider's documented remote revocation request", async () => {
    const requests: string[] = [];
    server.use(
      http.delete("https://api.mapmyfitness.com/v7.1/oauth2/connection/", ({ request }) => {
        const url = new URL(request.url);
        expect(url.searchParams.get("user_id")).toBe("123456");
        expect(url.searchParams.get("client_id")).toBe("mapmyfitness-client");
        requests.push("mapmyfitness");
        return new HttpResponse(null, { status: 204 });
      }),
      http.delete(
        "https://auth-api.main.komoot.net/v1/clients/komoot-client/refresh_tokens/",
        ({ request }) => {
          expect(new URL(request.url).searchParams.get("refresh_token")).toBe("komoot-refresh");
          requests.push("komoot");
          return new HttpResponse(null, { status: 200 });
        },
      ),
      http.get("https://cloudapi-oauth.suunto.com/oauth/deauthorize", ({ request }) => {
        expect(new URL(request.url).searchParams.get("client_id")).toBe("suunto-client");
        requests.push("suunto");
        return new HttpResponse(null, { status: 200 });
      }),
    );
    const providerSnapshot: AccountErasureRemoteSnapshot = {
      ...snapshot,
      appleCredentials: [],
      providerConnections: [
        {
          accessToken: "mapmyfitness-access",
          disposition: "revocation_credentials",
          expiresAt: "2026-07-26T12:00:00.000Z",
          providerAccountId: "123456",
          providerId: "mapmyfitness",
          refreshToken: "mapmyfitness-refresh",
          scopes: "read",
        },
        {
          accessToken: "komoot-access",
          disposition: "revocation_credentials",
          expiresAt: "2026-07-26T12:00:00.000Z",
          providerId: "komoot",
          refreshToken: "komoot-refresh",
          scopes: "profile",
        },
        {
          accessToken: "suunto-access",
          disposition: "revocation_credentials",
          expiresAt: "2026-07-26T12:00:00.000Z",
          providerId: "suunto",
          refreshToken: "suunto-refresh",
          scopes: "workout",
        },
      ],
      stripe: null,
    };
    const providers = [new MapMyFitnessProvider(), new KomootProvider(), new SuuntoProvider()];

    await revokeRemoteAccounts(providerSnapshot, providers);
    await revokeRemoteAccounts(providerSnapshot, providers);

    expect(requests).toEqual([
      "mapmyfitness",
      "komoot",
      "suunto",
      "mapmyfitness",
      "komoot",
      "suunto",
    ]);
  });

  it("emits one explicit disposition for every snapshotted provider connection", async () => {
    const providerSnapshot: AccountErasureRemoteSnapshot = {
      ...snapshot,
      appleCredentials: [],
      providerConnections: [
        {
          disposition: "no_remote_authorization",
          providerId: "strong-csv",
        },
        {
          accessToken: "suunto-access",
          disposition: "revocation_credentials",
          expiresAt: "2026-07-26T12:00:00.000Z",
          providerId: "suunto",
          refreshToken: "suunto-refresh",
          scopes: "workout",
        },
      ],
      stripe: null,
    };
    server.use(
      http.get("https://cloudapi-oauth.suunto.com/oauth/deauthorize", () => {
        return new HttpResponse(null, { status: 200 });
      }),
    );

    await expect(revokeRemoteAccounts(providerSnapshot, [new SuuntoProvider()])).resolves.toEqual([
      {
        disposition: "no_remote_authorization",
        providerId: "strong-csv",
      },
      {
        disposition: "remote_revoked",
        providerId: "suunto",
      },
    ]);
  });

  it("does not treat active providers without revocation APIs as historical successes", async () => {
    for (const provider of [new CorosProvider(), new DecathlonProvider()]) {
      const providerSnapshot: AccountErasureRemoteSnapshot = {
        ...snapshot,
        appleCredentials: [],
        providerConnections: [
          {
            accessToken: "historical-access",
            disposition: "revocation_credentials",
            expiresAt: "2026-07-26T12:00:00.000Z",
            providerId: provider.id,
            refreshToken: "historical-refresh",
            scopes: null,
          },
        ],
        stripe: null,
      };

      await expect(revokeRemoteAccounts(providerSnapshot, [provider])).rejects.toThrow(
        `Provider ${provider.id} has no account-erasure revocation policy`,
      );
    }
  });
});
