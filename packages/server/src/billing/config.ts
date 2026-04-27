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

export function getStripeBillingConfig(): StripeBillingConfig {
  return {
    secretKey: requiredEnv("STRIPE_SECRET_KEY"),
    webhookSecret: requiredEnv("STRIPE_WEBHOOK_SECRET"),
    priceId: requiredEnv("STRIPE_PRICE_ID"),
    appBaseUrl: requiredEnv("APP_BASE_URL"),
  };
}
