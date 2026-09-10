import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { validateAccountErasureLedgerKeyring } from "../src/account-erasure/identity.ts";

const REQUIRED_DEPLOY_KEYS = [
  "APP_STORE_ISSUER_ID",
  "APP_STORE_KEY_ID",
  "APP_STORE_PRIVATE_KEY",
  "APP_STORE_APP_ID",
  "APP_STORE_BUNDLE_ID",
  "APP_STORE_SUBSCRIPTION_PRODUCT_ID",
  "APP_STORE_ROOT_CERTIFICATES_PEM",
  "AXIOM_API_TOKEN",
  "BREVO_API_KEY",
  "CREDENTIAL_ENCRYPTION_KEY_BASE64",
  "EXPO_APP_ID",
  "OTA_JWT_SECRET",
  "OTA_PRIVATE_KEY_B64",
  "OTA_PUBLIC_KEY_B64",
  "POSTHOG_PERSONAL_API_KEY",
  "POSTHOG_PROJECT_ID",
  "SENTRY_AUTH_TOKEN",
  "SENTRY_ORG",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_PRICE_ID",
  "R2_ENDPOINT",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "ACCOUNT_ERASURE_LEDGER_KEYRING_JSON",
] as const;

export function validateDeployEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): void {
  const missing = REQUIRED_DEPLOY_KEYS.flatMap((key) => {
    const value = environment[key];
    if (value === undefined) return [key];
    if (value.trim().length === 0) return [`${key} (empty)`];
    return [];
  });
  if (missing.length > 0) {
    throw new Error(`Rendered Infisical dotenv is missing required keys: ${missing.join(", ")}`);
  }
  const credentialEncryptionKey = environment.CREDENTIAL_ENCRYPTION_KEY_BASE64 ?? "";
  if (Buffer.from(credentialEncryptionKey, "base64").byteLength !== 32) {
    throw new Error("CREDENTIAL_ENCRYPTION_KEY_BASE64 must decode to exactly 32 bytes");
  }
  validateAccountErasureLedgerKeyring(environment.ACCOUNT_ERASURE_LEDGER_KEYRING_JSON);
}

function validateDeployEnvironmentFile(path: string): void {
  validateDeployEnvironment(parseEnv(readFileSync(path, "utf8")));
}

const commandPath = process.argv[1];
if (commandPath && import.meta.url === pathToFileURL(commandPath).href) {
  const environmentFile = process.argv[2];
  if (!environmentFile || process.argv.length !== 3) {
    throw new Error("Usage: validate-deploy-env.ts <rendered-dotenv-path>");
  }
  validateDeployEnvironmentFile(environmentFile);
  console.log("Validated required deploy secrets.");
}
