import { TRPCError } from "@trpc/server";
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

  createCheckoutSession: protectedProcedure.mutation(async ({ ctx }) => {
    const config = getStripeBillingConfig();
    const stripe = createStripeClient();
    const billingRepository = new BillingRepository(ctx.db);
    const profile = await billingRepository.findCustomerProfileByUserId(ctx.userId);
    if (!profile) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "Authenticated user profile not found",
      });
    }

    let stripeCustomerId = profile.stripe_customer_id;
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({
        email: profile.email ?? undefined,
        name: profile.name,
        metadata: { userId: ctx.userId },
      });
      stripeCustomerId = customer.id;
      await billingRepository.upsertStripeCustomerId(ctx.userId, stripeCustomerId);
    }

    const session = await stripe.checkout.sessions.create({
      customer: stripeCustomerId,
      mode: "subscription",
      line_items: [{ price: config.priceId, quantity: 1 }],
      success_url: `${config.appBaseUrl}/settings?billing=success`,
      cancel_url: `${config.appBaseUrl}/settings?billing=cancel`,
      client_reference_id: ctx.userId,
    });
    if (!session.url) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "Stripe Checkout did not return a session URL",
      });
    }

    return { url: session.url };
  }),

  createPortalSession: protectedProcedure.mutation(async ({ ctx }) => {
    const config = getStripeBillingConfig();
    const stripe = createStripeClient();
    const billingRepository = new BillingRepository(ctx.db);
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
  }),
});
