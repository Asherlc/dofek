import * as Sentry from "@sentry/node";
import { TRPCError } from "@trpc/server";
import { withAccountErasureUserWriteFence } from "dofek/db/account-erasure";
import { recordUserExternalEffect } from "dofek/db/user-external-effect";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { getStripeBillingConfig } from "../billing/config.ts";
import { resolveAccessWindow } from "../billing/entitlement.ts";
import { createStripeClient } from "../billing/stripe-client.ts";
import { executeWithSchema, timestampStringSchema } from "../lib/typed-sql.ts";
import { BillingRepository } from "../repositories/billing-repository.ts";
import { protectedProcedure, router } from "../trpc.ts";

const billingStatusRowSchema = z.object({
  id: z.string(),
  created_at: timestampStringSchema,
  paid_grant_reason: z.string().nullable(),
  stripe_subscription_status: z.string().nullable(),
  stripe_customer_id: z.string().nullable(),
});

export const billingRouter = router({
  status: protectedProcedure.query(async ({ ctx }) => {
    const rows = await executeWithSchema(
      ctx.db,
      billingStatusRowSchema,
      sql`SELECT
            profile.id,
            profile.created_at::text AS created_at,
            billing.paid_grant_reason,
            billing.stripe_subscription_status,
            billing.stripe_customer_id
          FROM fitness.user_profile profile
          LEFT JOIN fitness.user_billing billing ON billing.user_id = profile.id
          WHERE profile.id = ${ctx.userId}
          LIMIT 1`,
    );
    const row = rows[0];
    if (!row) {
      throw new Error(`Authenticated user ${ctx.userId} does not exist`);
    }

    const access = resolveAccessWindow({
      userCreatedAt: row.created_at,
      timezone: ctx.timezone,
      paidGrantReason: row.paid_grant_reason,
      stripeSubscriptionStatus: row.stripe_subscription_status,
    });

    return {
      hasFullAccess: access.kind === "full",
      access,
      stripeSubscriptionStatus: row.stripe_subscription_status,
      canManageBilling: row.stripe_customer_id !== null,
    };
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
