import { z } from "zod";
import { revokeAppleCredential } from "../auth/apple-credential-revocation.ts";
import { revokeToken } from "../auth/oauth.ts";
import { createStripeClient } from "../billing/stripe-client.ts";
import { isWebhookProvider, type Provider } from "../providers/types.ts";
import type { AccountErasureRemoteSnapshot } from "./remote-snapshot.ts";
import { withAccountErasureTracingSuppressed } from "./tracing.ts";

const stripeMissingResourceErrorSchema = z.object({
  code: z.literal("resource_missing"),
  statusCode: z.literal(404),
});
const stripeCustomerPageSchema = z.object({
  data: z.array(
    z.object({
      id: z.string().min(1),
      metadata: z.record(z.string(), z.string()),
    }),
  ),
  has_more: z.boolean(),
});
const STRIPE_CUSTOMER_PAGE_SIZE = 100;
const STRIPE_CUSTOMER_PAGE_LIMIT = 1_000;
function requiredEnvironmentValue(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for account erasure`);
  return value;
}

async function revokeAppleCredentials(
  credentials: AccountErasureRemoteSnapshot["appleCredentials"],
  fetchFn: typeof globalThis.fetch,
): Promise<void> {
  for (const credential of credentials) {
    await revokeAppleCredential(credential, fetchFn);
  }
}

interface AccountErasureStripeClient {
  customers: {
    del(customerId: string): Promise<unknown>;
    list(parameters: { limit: number; starting_after?: string }): Promise<unknown>;
  };
  subscriptions: {
    cancel(subscriptionId: string): Promise<unknown>;
  };
}

export interface StripeAccountErasureResult {
  customersDeleted: number;
  subscriptionsCanceled: number;
}

function sanitizedStripeErasureError(operation: string): Error {
  return new Error(`Stripe account erasure ${operation} failed`);
}

async function eraseStripeResource(
  operation: () => Promise<unknown>,
  operationName: string,
): Promise<boolean> {
  try {
    await operation();
    return true;
  } catch (error: unknown) {
    if (stripeMissingResourceErrorSchema.safeParse(error).success) return false;
    throw sanitizedStripeErasureError(operationName);
  }
}

async function listStripeCustomersForUser(
  client: AccountErasureStripeClient,
  userId: string,
): Promise<Set<string>> {
  const customerIds = new Set<string>();
  const seenCursors = new Set<string>();
  let startingAfter: string | undefined;
  for (let pageNumber = 0; pageNumber < STRIPE_CUSTOMER_PAGE_LIMIT; pageNumber += 1) {
    let response: unknown;
    try {
      response = await client.customers.list({
        limit: STRIPE_CUSTOMER_PAGE_SIZE,
        ...(startingAfter ? { starting_after: startingAfter } : {}),
      });
    } catch {
      throw sanitizedStripeErasureError("customer discovery");
    }
    const parsedPage = stripeCustomerPageSchema.safeParse(response);
    if (!parsedPage.success) {
      throw sanitizedStripeErasureError("customer discovery response validation");
    }
    const page = parsedPage.data;
    for (const customer of page.data) {
      if (customer.metadata.userId === userId) {
        customerIds.add(customer.id);
      }
    }
    if (!page.has_more) return customerIds;

    const nextCursor = page.data.at(-1)?.id;
    if (!nextCursor || nextCursor === startingAfter || seenCursors.has(nextCursor)) {
      throw new Error("Stripe customer reconciliation pagination did not advance");
    }
    seenCursors.add(nextCursor);
    startingAfter = nextCursor;
  }
  throw new Error("Stripe customer reconciliation exceeded the pagination safety limit");
}

export async function eraseStripeAccount(
  snapshot: AccountErasureRemoteSnapshot,
  stripeClient?: AccountErasureStripeClient,
): Promise<StripeAccountErasureResult> {
  return withAccountErasureTracingSuppressed(async () => {
    const client =
      stripeClient ?? createStripeClient(requiredEnvironmentValue("STRIPE_SECRET_KEY"));
    const subscriptionIds = new Set<string>();
    const customerIds = new Set<string>();
    if (snapshot.stripe?.subscriptionId) {
      subscriptionIds.add(snapshot.stripe.subscriptionId);
    }
    if (snapshot.stripe?.customerId) {
      customerIds.add(snapshot.stripe.customerId);
    }
    for (const effect of snapshot.externalEffects) {
      if (effect.system === "stripe") {
        customerIds.add(effect.externalId);
      }
    }
    const discoveredCustomerIds = await listStripeCustomersForUser(
      client,
      snapshot.localIdentifiers.userId,
    );
    for (const customerId of discoveredCustomerIds) {
      customerIds.add(customerId);
    }

    let subscriptionsCanceled = 0;
    for (const subscriptionId of subscriptionIds) {
      if (
        await eraseStripeResource(
          () => client.subscriptions.cancel(subscriptionId),
          "subscription cancellation",
        )
      ) {
        subscriptionsCanceled += 1;
      }
    }
    let customersDeleted = 0;
    for (const customerId of customerIds) {
      if (await eraseStripeResource(() => client.customers.del(customerId), "customer deletion")) {
        customersDeleted += 1;
      }
    }
    return { customersDeleted, subscriptionsCanceled };
  });
}

export type ProviderCredentialDisposition =
  | {
      disposition: "no_remote_authorization";
      providerId: string;
    }
  | {
      disposition: "remote_revoked";
      providerId: string;
    };

async function revokeProviderConnections(
  snapshot: AccountErasureRemoteSnapshot,
  providers: readonly Provider[],
  fetchFn: typeof globalThis.fetch,
): Promise<ProviderCredentialDisposition[]> {
  const dispositions: ProviderCredentialDisposition[] = [];
  for (const connection of snapshot.providerConnections) {
    if (connection.disposition === "no_remote_authorization") {
      dispositions.push(connection);
      continue;
    }
    const storedTokens = connection;
    const provider = providers.find((candidate) => candidate.id === storedTokens.providerId);
    if (!provider) {
      throw new Error(
        `Provider ${storedTokens.providerId} has no account-erasure revocation policy`,
      );
    }
    const setup = provider.authSetup?.();
    if (!setup) {
      throw new Error(
        `Provider ${storedTokens.providerId} has no account-erasure revocation policy`,
      );
    }
    const tokens = {
      accessToken: storedTokens.accessToken,
      expiresAt: new Date(storedTokens.expiresAt),
      ...(storedTokens.providerAccountId
        ? {
            providerAccountId: storedTokens.providerAccountId,
          }
        : {}),
      refreshToken: storedTokens.refreshToken,
      scopes: storedTokens.scopes,
    };

    if (setup.revokeTokensForAccountErasure) {
      await setup.revokeTokensForAccountErasure(tokens);
      dispositions.push({
        disposition: "remote_revoked",
        providerId: storedTokens.providerId,
      });
      continue;
    }

    if (setup.revokeExistingTokens) {
      try {
        await setup.revokeExistingTokens(tokens);
        dispositions.push({
          disposition: "remote_revoked",
          providerId: storedTokens.providerId,
        });
        continue;
      } catch (error: unknown) {
        if (!setup.oauthConfig?.revokeUrl) throw error;
      }
    }

    if (!setup.oauthConfig?.revokeUrl) {
      throw new Error(
        `Provider ${storedTokens.providerId} has no account-erasure revocation policy`,
      );
    }
    await revokeToken(setup.oauthConfig, tokens.accessToken, fetchFn);
    if (tokens.refreshToken) {
      await revokeToken(setup.oauthConfig, tokens.refreshToken, fetchFn);
    }
    dispositions.push({
      disposition: "remote_revoked",
      providerId: storedTokens.providerId,
    });
  }
  return dispositions;
}

async function unregisterUserWebhooks(
  snapshot: AccountErasureRemoteSnapshot,
  providers: readonly Provider[],
): Promise<void> {
  for (const webhook of snapshot.webhooks) {
    const provider = providers.find((candidate) => candidate.id === webhook.providerId);
    if (!provider || !isWebhookProvider(provider) || provider.webhookScope !== "user") {
      throw new Error(`Provider ${webhook.providerId} cannot unregister a user webhook`);
    }
    await provider.unregisterWebhook(webhook.subscriptionExternalId);
  }
}

export async function revokeRemoteAccounts(
  snapshot: AccountErasureRemoteSnapshot,
  providers: readonly Provider[],
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<ProviderCredentialDisposition[]> {
  return withAccountErasureTracingSuppressed(async () => {
    await unregisterUserWebhooks(snapshot, providers);
    await revokeAppleCredentials(snapshot.appleCredentials, fetchFn);
    return revokeProviderConnections(snapshot, providers, fetchFn);
  });
}
