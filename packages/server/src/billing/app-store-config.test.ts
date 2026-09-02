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
});
