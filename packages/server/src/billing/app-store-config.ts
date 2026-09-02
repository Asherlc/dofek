import { APP_STORE_SUBSCRIPTION_PRODUCT_ID } from "./app-store-subscription.ts";

export interface AppStoreBillingConfig {
  issuerId: string;
  keyId: string;
  privateKey: string;
  appId: number;
  bundleId: string;
  subscriptionProductId: typeof APP_STORE_SUBSCRIPTION_PRODUCT_ID;
  rootCertificatesPem: string;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} environment variable is required`);
  return value;
}

function requiredPositiveIntegerEnv(name: string): number {
  const value = requiredEnv(name);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} environment variable must be a positive integer`);
  }
  return parsed;
}

export function getAppStoreBillingConfig(): AppStoreBillingConfig {
  const subscriptionProductId = requiredEnv("APP_STORE_SUBSCRIPTION_PRODUCT_ID");
  if (subscriptionProductId !== APP_STORE_SUBSCRIPTION_PRODUCT_ID) {
    throw new Error(
      `APP_STORE_SUBSCRIPTION_PRODUCT_ID must be ${APP_STORE_SUBSCRIPTION_PRODUCT_ID}`,
    );
  }

  return {
    issuerId: requiredEnv("APP_STORE_ISSUER_ID"),
    keyId: requiredEnv("APP_STORE_KEY_ID"),
    privateKey: requiredEnv("APP_STORE_PRIVATE_KEY"),
    appId: requiredPositiveIntegerEnv("APP_STORE_APP_ID"),
    bundleId: requiredEnv("APP_STORE_BUNDLE_ID"),
    subscriptionProductId,
    rootCertificatesPem: requiredEnv("APP_STORE_ROOT_CERTIFICATES_PEM"),
  };
}
