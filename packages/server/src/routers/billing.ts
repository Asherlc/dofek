import * as Sentry from "@sentry/node";
import { TRPCError } from "@trpc/server";
import type { Database } from "dofek/db";
import {
  AccountErasureUserFencedError,
  withAccountErasureUserWriteFence,
} from "dofek/db/account-erasure";
import { recordUserExternalEffect } from "dofek/db/user-external-effect";
import { invalidateAllUserQueries } from "dofek/lib/cache";
import { z } from "zod";
import { APP_STORE_SUBSCRIPTION_PRODUCT_ID } from "../billing/app-store-subscription.ts";
import { verifyAppStoreTransaction as verifySignedAppStoreTransaction } from "../billing/app-store-verifier.ts";
import { getStripeBillingConfig } from "../billing/config.ts";
import { createStripeClient } from "../billing/stripe-client.ts";
import {
  BillingProfileNotFoundError,
  BillingRepository,
} from "../repositories/billing-repository.ts";
import { protectedProcedure, router } from "../trpc.ts";

const accessWindowSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("full"),
    paid: z.literal(true),
    reason: z.enum(["paid_grant", "stripe_subscription", "app_store_subscription"]),
  }),
  z.object({
    kind: z.literal("limited"),
    paid: z.literal(false),
    reason: z.literal("free_signup_week"),
    startDate: z.string(),
    endDateExclusive: z.string(),
  }),
]);
const billingStatusSchema = z.object({
  hasFullAccess: z.boolean(),
  access: accessWindowSchema,
  stripeSubscriptionStatus: z.string().nullable(),
  canManageBilling: z.boolean(),
  appStoreSubscriptionStatus: z.string().nullable(),
  canManageAppStoreSubscription: z.boolean(),
});
const appStorePurchaseContextSchema = z.object({
  productId: z.literal(APP_STORE_SUBSCRIPTION_PRODUCT_ID),
  appAccountToken: z.uuid(),
});

async function getBillingStatus(db: Pick<Database, "execute">, userId: string, timezone: string) {
  let status: Awaited<ReturnType<BillingRepository["getAccessStatus"]>>;
  try {
    status = await new BillingRepository(db).getAccessStatus(userId, timezone);
  } catch (error) {
    if (error instanceof BillingProfileNotFoundError) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Authenticated user profile not found" });
    }
    throw error;
  }

  return {
    hasFullAccess: status.access.kind === "full",
    ...status,
  };
}

export const billingRouter = router({
  status: protectedProcedure
    .output(billingStatusSchema)
    .query(({ ctx }) => getBillingStatus(ctx.db, ctx.userId, ctx.timezone)),

  appStorePurchaseContext: protectedProcedure
    .output(appStorePurchaseContextSchema)
    .query(async ({ ctx }) => {
      try {
        const appAccountToken = await withAccountErasureUserWriteFence(
          ctx.db,
          ctx.userId,
          async (transaction) => {
            const billingRepository = new BillingRepository(transaction);
            return billingRepository.getOrCreateAppStoreAccountToken(ctx.userId);
          },
        );
        return {
          productId: APP_STORE_SUBSCRIPTION_PRODUCT_ID,
          appAccountToken,
        };
      } catch (error) {
        if (error instanceof AccountErasureUserFencedError) {
          throw new TRPCError({ code: "CONFLICT", message: error.message });
        }
        throw error;
      }
    }),

  verifyAppStoreTransaction: protectedProcedure
    .input(z.object({ signedTransaction: z.string().min(1) }))
    .output(billingStatusSchema)
    .mutation(async ({ ctx, input }) => {
      try {
        const status = await withAccountErasureUserWriteFence(
          ctx.db,
          ctx.userId,
          async (transaction) => {
            const billingRepository = new BillingRepository(transaction);
            const appAccountToken = await billingRepository.getOrCreateAppStoreAccountToken(
              ctx.userId,
            );
            const subscription = await verifySignedAppStoreTransaction(
              input.signedTransaction,
              appAccountToken,
            );
            await billingRepository.applyAppStoreSubscription(subscription);
            return getBillingStatus(transaction, ctx.userId, ctx.timezone);
          },
        );
        try {
          await invalidateAllUserQueries(ctx.userId);
        } catch (error) {
          Sentry.captureException(error, {
            tags: { source: "app-store-billing-cache-invalidation" },
          });
        }
        return status;
      } catch (error) {
        if (error instanceof AccountErasureUserFencedError) {
          throw new TRPCError({ code: "CONFLICT", message: error.message });
        }
        throw error;
      }
    }),

  createCheckoutSession: protectedProcedure
    .input(z.object({ operationId: z.uuid() }))
    .mutation(async ({ ctx, input }) => {
      const config = getStripeBillingConfig();
      const stripe = createStripeClient();
      let createdCustomerId: string | null = null;
      let createdCheckoutSessionId: string | null = null;
      let transactionWorkCompleted = false;
      try {
        return await withAccountErasureUserWriteFence(ctx.db, ctx.userId, async (transaction) => {
          const billingRepository = new BillingRepository(transaction);
          const profile = await billingRepository.findCustomerProfileByUserId(ctx.userId);
          if (!profile) {
            throw new TRPCError({
              code: "NOT_FOUND",
              message: "Authenticated user profile not found",
            });
          }

          let stripeCustomerId = profile.stripe_customer_id;
          if (!stripeCustomerId) {
            const customer = await stripe.customers.create(
              {
                email: profile.email ?? undefined,
                name: profile.name,
                metadata: { userId: ctx.userId },
              },
              { idempotencyKey: `dofek-customer-${ctx.userId}` },
            );
            stripeCustomerId = customer.id;
            createdCustomerId = customer.id;
            await recordUserExternalEffect(transaction, {
              system: "stripe",
              resourceType: "customer",
              externalId: stripeCustomerId,
              userId: ctx.userId,
            });
            await billingRepository.upsertStripeCustomerId(ctx.userId, stripeCustomerId);
          } else {
            await recordUserExternalEffect(transaction, {
              system: "stripe",
              resourceType: "customer",
              externalId: stripeCustomerId,
              userId: ctx.userId,
            });
          }

          const session = await stripe.checkout.sessions.create(
            {
              customer: stripeCustomerId,
              mode: "subscription",
              line_items: [{ price: config.priceId, quantity: 1 }],
              success_url: `${config.appBaseUrl}/settings?billing=success`,
              cancel_url: `${config.appBaseUrl}/settings?billing=cancel`,
              client_reference_id: ctx.userId,
              metadata: {
                dofekCheckoutOperationId: input.operationId,
                userId: ctx.userId,
              },
            },
            {
              idempotencyKey: `dofek-checkout-${ctx.userId}-${config.priceId}-${input.operationId}`,
            },
          );
          createdCheckoutSessionId = session.id;
          if (!session.url) {
            throw new TRPCError({
              code: "INTERNAL_SERVER_ERROR",
              message: "Stripe Checkout did not return a session URL",
            });
          }

          // Keep external resources valid if the database commit fails after this
          // callback returns. The client can retry with the same operation ID and
          // Stripe's idempotency key will return the existing checkout session.
          transactionWorkCompleted = true;
          return { url: session.url };
        });
      } catch (error: unknown) {
        if (transactionWorkCompleted) {
          throw error;
        }
        if (createdCheckoutSessionId) {
          try {
            await stripe.checkout.sessions.expire(createdCheckoutSessionId);
          } catch (cleanupError: unknown) {
            Sentry.captureException(cleanupError, {
              tags: { source: "billing", operation: "expire-orphan-checkout-session" },
            });
          }
        }
        if (createdCustomerId) {
          try {
            await stripe.customers.del(createdCustomerId);
          } catch (cleanupError: unknown) {
            Sentry.captureException(cleanupError, {
              tags: { source: "billing", operation: "delete-orphan-stripe-customer" },
            });
          }
        }
        throw error;
      }
    }),

  createPortalSession: protectedProcedure.mutation(async ({ ctx }) => {
    const config = getStripeBillingConfig();
    const stripe = createStripeClient();
    return withAccountErasureUserWriteFence(ctx.db, ctx.userId, async (transaction) => {
      const billingRepository = new BillingRepository(transaction);
      const profile = await billingRepository.findCustomerProfileByUserId(ctx.userId);
      if (!profile) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "Authenticated user profile not found",
        });
      }
      if (!profile.stripe_customer_id) {
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "Stripe customer not found. Subscribe before managing billing.",
        });
      }

      const session = await stripe.billingPortal.sessions.create({
        customer: profile.stripe_customer_id,
        return_url: `${config.appBaseUrl}/settings`,
      });

      return { url: session.url };
    });
  }),
});
