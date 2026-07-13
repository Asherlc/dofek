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
  const baseUrl = value.trim().replace(/\/+$/, "");
  if (!baseUrl) {
    throw new Error("PUBLIC_URL environment variable is required");
  }
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("PUBLIC_URL environment variable must be a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("PUBLIC_URL environment variable must use http or https");
  }
  return baseUrl;
}

export function getStripeBillingConfig(): StripeBillingConfig {
  return {
    secretKey: requiredEnv("STRIPE_SECRET_KEY"),
    webhookSecret: requiredEnv("STRIPE_WEBHOOK_SECRET"),
    priceId: requiredEnv("STRIPE_PRICE_ID"),
    appBaseUrl: normalizeAppBaseUrl(requiredEnv("PUBLIC_URL")),
  };
}
