import Stripe from "stripe";
import { getStripeBillingConfig } from "./config.ts";

export function createStripeClient(): Stripe {
  const config = getStripeBillingConfig();
  return new Stripe(config.secretKey);
}
