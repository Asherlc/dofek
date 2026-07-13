export interface StripeBillingConfig {
  secretKey: string;
  webhookSecret: string;
  priceId: string;
  appBaseUrl: string;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} environment variable is required`);
  return value;
}

function normalizeAppBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function getStripeBillingConfig(): StripeBillingConfig {
  return {
    secretKey: requiredEnv("STRIPE_SECRET_KEY"),
    webhookSecret: requiredEnv("STRIPE_WEBHOOK_SECRET"),
    priceId: requiredEnv("STRIPE_PRICE_ID"),
    appBaseUrl: normalizeAppBaseUrl(requiredEnv("PUBLIC_URL")),
  };
}
