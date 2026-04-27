import type { Database } from "dofek/db";
import { Router, raw } from "express";
import { z } from "zod";
import { getStripeBillingConfig } from "../billing/config.ts";
import { createStripeClient } from "../billing/stripe-client.ts";
import { BillingRepository } from "../repositories/billing-repository.ts";

const stripeCustomerReferenceSchema = z
  .union([z.string(), z.object({ id: z.string() })])
  .transform((value) => (typeof value === "string" ? value : value.id));

const stripeSubscriptionObjectSchema = z.object({
  id: z.string(),
  customer: stripeCustomerReferenceSchema,
  status: z.string(),
  current_period_end: z.number().nullable().optional(),
});

interface StripeWebhookRouterDeps {
  db: Pick<Database, "execute">;
}

export function createStripeWebhookRouter({ db }: StripeWebhookRouterDeps): Router {
  const router = Router();
  router.post("/", raw({ type: "*/*", limit: "1mb" }), async (req, res, next) => {
    try {
      const signature = req.header("stripe-signature");
      if (!signature) {
        res.status(400).send("Missing Stripe signature");
        return;
      }

      const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.from(String(req.body));
      const config = getStripeBillingConfig();
      const stripe = createStripeClient();
      const event = stripe.webhooks.constructEvent(rawBody, signature, config.webhookSecret);

      if (
        event.type === "customer.subscription.created" ||
        event.type === "customer.subscription.updated" ||
        event.type === "customer.subscription.deleted"
      ) {
        const subscription = stripeSubscriptionObjectSchema.parse(event.data.object);
        const billingRepository = new BillingRepository(db);
        await billingRepository.updateSubscriptionForStripeCustomer({
          stripeCustomerId: subscription.customer,
          stripeSubscriptionId: subscription.id,
          stripeSubscriptionStatus: subscription.status,
          stripeCurrentPeriodEnd:
            subscription.current_period_end === null ||
            subscription.current_period_end === undefined
              ? null
              : new Date(subscription.current_period_end * 1000),
        });
      }

      res.status(200).send("OK");
    } catch (error) {
      next(error);
    }
  });

  return router;
}
