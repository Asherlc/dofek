import { describe, expect, it } from "vitest";
import { validateDeployEnvironment } from "./validate-deploy-env.ts";

function validEnvironment(): Record<string, string> {
  return {
    ACCOUNT_ERASURE_LEDGER_KEYRING_JSON: JSON.stringify({
      activeKeyId: "2026-07",
      keys: {
        "2026-07": Buffer.alloc(32, 1).toString("base64"),
      },
    }),
    AXIOM_API_TOKEN: "axiom-token",
    BREVO_API_KEY: "brevo-token",
    CREDENTIAL_ENCRYPTION_KEY_BASE64: Buffer.alloc(32, 3).toString("base64"),
    EXPO_APP_ID: "expo-project-id",
    OTA_JWT_SECRET: "ota-jwt-secret",
    OTA_PRIVATE_KEY_B64: "ota-private-key",
    OTA_PUBLIC_KEY_B64: "ota-public-key",
    POSTHOG_PERSONAL_API_KEY: "posthog-token",
    POSTHOG_PROJECT_ID: "12345",
    R2_ACCESS_KEY_ID: "r2-access",
    R2_ENDPOINT: "https://example.r2.cloudflarestorage.com",
    R2_SECRET_ACCESS_KEY: "r2-secret",
    SENTRY_AUTH_TOKEN: "sentry-token",
    SENTRY_ORG: "east-bay-software",
    STRIPE_PRICE_ID: "price_1",
    STRIPE_SECRET_KEY: "sk_test",
    STRIPE_WEBHOOK_SECRET: "whsec_test",
  };
}

describe("validateDeployEnvironment", () => {
  it("accepts every required value and the production account-erasure parser", () => {
    expect(() => validateDeployEnvironment(validEnvironment())).not.toThrow();
  });

  it("reports all missing and empty deploy prerequisites without exposing values", () => {
    const environment = validEnvironment();
    delete environment.R2_ENDPOINT;
    environment.STRIPE_SECRET_KEY = "   ";

    expect(() => validateDeployEnvironment(environment)).toThrow(
      "Rendered Infisical dotenv is missing required keys: STRIPE_SECRET_KEY (empty), R2_ENDPOINT",
    );
  });

  it("requires the processor erasure and retention credentials", () => {
    const environment = validEnvironment();
    delete environment.BREVO_API_KEY;
    delete environment.CREDENTIAL_ENCRYPTION_KEY_BASE64;
    environment.POSTHOG_PERSONAL_API_KEY = "";
    delete environment.SENTRY_AUTH_TOKEN;

    expect(() => validateDeployEnvironment(environment)).toThrow(
      "Rendered Infisical dotenv is missing required keys: BREVO_API_KEY, CREDENTIAL_ENCRYPTION_KEY_BASE64, POSTHOG_PERSONAL_API_KEY (empty), SENTRY_AUTH_TOKEN",
    );
  });

  it("requires the OTA server application identifier", () => {
    const environment: Record<string, string | undefined> = {
      ...validEnvironment(),
      EXPO_APP_ID: undefined,
    };

    expect(() => validateDeployEnvironment(environment)).toThrow(
      "Rendered Infisical dotenv is missing required keys: EXPO_APP_ID",
    );
  });

  it("requires the OTA server JWT and signing key secrets", () => {
    const environment: Record<string, string | undefined> = {
      ...validEnvironment(),
      OTA_JWT_SECRET: undefined,
      OTA_PRIVATE_KEY_B64: undefined,
      OTA_PUBLIC_KEY_B64: undefined,
    };

    expect(() => validateDeployEnvironment(environment)).toThrow(
      "Rendered Infisical dotenv is missing required keys: OTA_JWT_SECRET, OTA_PRIVATE_KEY_B64, OTA_PUBLIC_KEY_B64",
    );
  });

  it("rejects a credential encryption key that does not decode to exactly 32 bytes", () => {
    const environment = validEnvironment();
    environment.CREDENTIAL_ENCRYPTION_KEY_BASE64 = Buffer.alloc(31, 3).toString("base64");

    expect(() => validateDeployEnvironment(environment)).toThrow(
      "CREDENTIAL_ENCRYPTION_KEY_BASE64 must decode to exactly 32 bytes",
    );
  });

  it("rejects a malformed retained ledger key through the production parser", () => {
    const environment = validEnvironment();
    environment.ACCOUNT_ERASURE_LEDGER_KEYRING_JSON = JSON.stringify({
      activeKeyId: "new",
      keys: {
        new: Buffer.alloc(32, 1).toString("base64"),
        old: Buffer.alloc(31, 2).toString("base64"),
      },
    });

    expect(() => validateDeployEnvironment(environment)).toThrow(
      "old must decode to exactly 32 bytes",
    );
  });
});
