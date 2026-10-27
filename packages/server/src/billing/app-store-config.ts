import { z } from "zod";
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

function requiredEnvironmentValue(name: string) {
  return z
    .string({ error: `${name} environment variable is required` })
    .min(1, { error: `${name} environment variable is required` });
}

const appStoreBillingConfigSchema = z.object({
  APP_STORE_ISSUER_ID: requiredEnvironmentValue("APP_STORE_ISSUER_ID"),
  APP_STORE_KEY_ID: requiredEnvironmentValue("APP_STORE_KEY_ID"),
  APP_STORE_PRIVATE_KEY: requiredEnvironmentValue("APP_STORE_PRIVATE_KEY"),
  APP_STORE_APP_ID: requiredEnvironmentValue("APP_STORE_APP_ID")
    .refine((value) => Number.isSafeInteger(Number(value)) && Number(value) > 0, {
      error: "APP_STORE_APP_ID environment variable must be a positive integer",
    })
    .transform(Number),
  APP_STORE_BUNDLE_ID: requiredEnvironmentValue("APP_STORE_BUNDLE_ID"),
  APP_STORE_SUBSCRIPTION_PRODUCT_ID: z.literal(APP_STORE_SUBSCRIPTION_PRODUCT_ID, {
    error: `APP_STORE_SUBSCRIPTION_PRODUCT_ID must be ${APP_STORE_SUBSCRIPTION_PRODUCT_ID}`,
  }),
  APP_STORE_ROOT_CERTIFICATES_PEM: requiredEnvironmentValue("APP_STORE_ROOT_CERTIFICATES_PEM"),
});

function normalizePem(value: string): string {
  return value.replaceAll("\\n", "\n");
}

export function getAppStoreBillingConfig(): AppStoreBillingConfig {
  const config = appStoreBillingConfigSchema.parse(process.env);

  return {
    issuerId: config.APP_STORE_ISSUER_ID,
    keyId: config.APP_STORE_KEY_ID,
    privateKey: normalizePem(config.APP_STORE_PRIVATE_KEY),
    appId: config.APP_STORE_APP_ID,
    bundleId: config.APP_STORE_BUNDLE_ID,
    subscriptionProductId: config.APP_STORE_SUBSCRIPTION_PRODUCT_ID,
    rootCertificatesPem: normalizePem(config.APP_STORE_ROOT_CERTIFICATES_PEM),
  };
}
