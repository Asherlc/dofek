import { createStripeClient as createSharedStripeClient } from "dofek/billing/stripe-client";
import { getStripeBillingConfig } from "./config.ts";

export function createStripeClient() {
  const config = getStripeBillingConfig();
  return createSharedStripeClient(config.secretKey);
}
