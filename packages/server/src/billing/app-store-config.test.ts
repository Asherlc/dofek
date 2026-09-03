import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAppStoreBillingConfig } from "./app-store-config.ts";

const configuredEnvironment = {
  APP_STORE_ISSUER_ID: "issuer-id",
  APP_STORE_KEY_ID: "key-id",
  APP_STORE_PRIVATE_KEY: "private-key",
  APP_STORE_APP_ID: "123456789",
  APP_STORE_BUNDLE_ID: "com.dofek.app",
  APP_STORE_SUBSCRIPTION_PRODUCT_ID: "com.dofek.premium.monthly",
  APP_STORE_ROOT_CERTIFICATES_PEM: "certificate-chain",
} as const;

describe("getAppStoreBillingConfig", () => {
  beforeEach(() => {
    for (const [key, value] of Object.entries(configuredEnvironment)) {
      vi.stubEnv(key, value);
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("names APP_STORE_PRIVATE_KEY when it is absent", () => {
    delete process.env.APP_STORE_PRIVATE_KEY;

    expect(() => getAppStoreBillingConfig()).toThrow(
      "APP_STORE_PRIVATE_KEY environment variable is required",
    );
  });

  it.each(["0", "-1", "not-a-number"])("rejects an invalid APP_STORE_APP_ID of %s", (appId) => {
    vi.stubEnv("APP_STORE_APP_ID", appId);

    expect(() => getAppStoreBillingConfig()).toThrow(
      "APP_STORE_APP_ID environment variable must be a positive integer",
    );
  });

  it("normalizes escaped PEM line breaks from environment configuration", () => {
    vi.stubEnv(
      "APP_STORE_PRIVATE_KEY",
      "-----BEGIN PRIVATE KEY-----\\nkey\\n-----END PRIVATE KEY-----",
    );
    vi.stubEnv(
      "APP_STORE_ROOT_CERTIFICATES_PEM",
      "-----BEGIN CERTIFICATE-----\\ncertificate\\n-----END CERTIFICATE-----",
    );

    expect(getAppStoreBillingConfig()).toMatchObject({
      privateKey: "-----BEGIN PRIVATE KEY-----\nkey\n-----END PRIVATE KEY-----",
      rootCertificatesPem: "-----BEGIN CERTIFICATE-----\ncertificate\n-----END CERTIFICATE-----",
    });
  });
});
