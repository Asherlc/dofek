import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEPLOY_SERVICE_ENVIRONMENT_FILE_NAMES,
  renderDeployServiceEnvironmentFiles,
} from "./deploy-service-environment.ts";

const temporaryDirectories: string[] = [];

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "dofek-deploy-service-env-"));
  temporaryDirectories.push(directory);
  return directory;
}

function completeDeployEnvironment(): Record<string, string> {
  return {
    ACCOUNT_ERASURE_LEDGER_KEYRING_JSON: "ledger-keyring",
    APPLE_PRIVATE_KEY: "apple-private-key",
    AXIOM_API_TOKEN: "axiom-token",
    BREVO_API_KEY: "brevo-delete-token",
    CLOUDFLARE_API_TOKEN: "cloudflare-control-plane-token",
    CREDENTIAL_ENCRYPTION_KEY_BASE64: "credential-encryption-key",
    CREDENTIAL_ENCRYPTION_KEY_NAME: "credential-key-name",
    CREDENTIAL_ENCRYPTION_KEY_NAMESPACE: "credential-key-namespace",
    GEMINI_API_KEY: "gemini-key",
    OTA_PRIVATE_KEY_B64: "ota-private-key",
    POSTGRES_PASSWORD: "postgres-password",
    POSTHOG_PERSONAL_API_KEY: "posthog-delete-token",
    POSTHOG_PROJECT_ID: "posthog-project",
    R2_ACCESS_KEY_ID: "r2-access",
    R2_ENDPOINT: "https://example.r2.cloudflarestorage.com",
    R2_SECRET_ACCESS_KEY: "r2-secret",
    SENTRY_AUTH_TOKEN: "sentry-admin-token",
    SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
    SENTRY_ORG: "example-org",
    SLACK_CLIENT_SECRET: "slack-client-secret",
    STRIPE_PRICE_ID: "price_1",
    STRIPE_SECRET_KEY: "stripe-secret",
    STRIPE_WEBHOOK_SECRET: "stripe-webhook-secret",
    WAHOO_CLIENT_SECRET: "wahoo-secret",
    ZOHO_DESK_CLIENT_SECRET: "zoho-secret",
  };
}

function dotenv(environment: Readonly<Record<string, string>>): string {
  return `${Object.entries(environment)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("renderDeployServiceEnvironmentFiles", () => {
  it("writes least-privilege service files without leaking control-plane secrets", () => {
    const directory = makeTemporaryDirectory();
    const sourcePath = join(directory, "all.env");
    const outputDirectory = join(directory, "services");
    writeFileSync(sourcePath, dotenv(completeDeployEnvironment()));

    const paths = renderDeployServiceEnvironmentFiles(sourcePath, outputDirectory);

    const web = parseEnv(readFileSync(paths.web, "utf8"));
    expect(web).toMatchObject({
      ACCOUNT_ERASURE_LEDGER_KEYRING_JSON: "ledger-keyring",
      APPLE_PRIVATE_KEY: "apple-private-key",
      GEMINI_API_KEY: "gemini-key",
      R2_ACCESS_KEY_ID: "r2-access",
      SLACK_CLIENT_SECRET: "slack-client-secret",
      STRIPE_SECRET_KEY: "stripe-secret",
      WAHOO_CLIENT_SECRET: "wahoo-secret",
      ZOHO_DESK_CLIENT_SECRET: "zoho-secret",
    });
    expect(web).not.toHaveProperty("BREVO_API_KEY");
    expect(web).not.toHaveProperty("CLOUDFLARE_API_TOKEN");
    expect(web).not.toHaveProperty("POSTGRES_PASSWORD");
    expect(web).not.toHaveProperty("POSTHOG_PERSONAL_API_KEY");
    expect(web).not.toHaveProperty("SENTRY_AUTH_TOKEN");

    const worker = parseEnv(readFileSync(paths.worker, "utf8"));
    expect(worker).toMatchObject({
      AXIOM_API_TOKEN: "axiom-token",
      BREVO_API_KEY: "brevo-delete-token",
      POSTGRES_PASSWORD: "postgres-password",
      POSTHOG_PERSONAL_API_KEY: "posthog-delete-token",
      SENTRY_AUTH_TOKEN: "sentry-admin-token",
    });
    expect(worker).not.toHaveProperty("CLOUDFLARE_API_TOKEN");
    expect(worker).not.toHaveProperty("GEMINI_API_KEY");
    expect(worker).not.toHaveProperty("OTA_PRIVATE_KEY_B64");
    expect(worker).not.toHaveProperty("SLACK_CLIENT_SECRET");

    expect(parseEnv(readFileSync(paths.analyticsWorker, "utf8"))).toEqual({
      SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
    });
    expect(parseEnv(readFileSync(paths.cdcHealth, "utf8"))).toEqual({
      POSTGRES_PASSWORD: "postgres-password",
      SENTRY_DSN: "https://public@example.ingest.sentry.io/1",
    });
    expect(parseEnv(readFileSync(paths.cdcOperations, "utf8"))).toEqual({
      POSTGRES_PASSWORD: "postgres-password",
    });
    expect(parseEnv(readFileSync(paths.collector, "utf8"))).toEqual({
      AXIOM_API_TOKEN: "axiom-token",
    });
    expect(parseEnv(readFileSync(paths.databaseOperations, "utf8"))).toEqual({
      CREDENTIAL_ENCRYPTION_KEY_BASE64: "credential-encryption-key",
      CREDENTIAL_ENCRYPTION_KEY_NAME: "credential-key-name",
      CREDENTIAL_ENCRYPTION_KEY_NAMESPACE: "credential-key-namespace",
      POSTGRES_PASSWORD: "postgres-password",
    });
    expect(parseEnv(readFileSync(paths.r2Operations, "utf8"))).toEqual({
      R2_ACCESS_KEY_ID: "r2-access",
      R2_ENDPOINT: "https://example.r2.cloudflarestorage.com",
      R2_SECRET_ACCESS_KEY: "r2-secret",
    });

    for (const path of Object.values(paths)) {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
  });

  it("fails before deployment when a scoped service prerequisite is missing", () => {
    const directory = makeTemporaryDirectory();
    const sourcePath = join(directory, "all.env");
    const environment = completeDeployEnvironment();
    delete environment.POSTHOG_PERSONAL_API_KEY;
    writeFileSync(sourcePath, dotenv(environment));

    expect(() =>
      renderDeployServiceEnvironmentFiles(sourcePath, join(directory, "services")),
    ).toThrow("worker deploy environment is missing required keys: POSTHOG_PERSONAL_API_KEY");
  });

  it("uses stable file names for stack interpolation", () => {
    expect(DEPLOY_SERVICE_ENVIRONMENT_FILE_NAMES).toEqual({
      analyticsWorker: "analytics-worker.env",
      cdcHealth: "cdc-health.env",
      cdcOperations: "cdc-operations.env",
      collector: "collector.env",
      databaseOperations: "database-operations.env",
      r2Operations: "r2-operations.env",
      web: "web.env",
      worker: "worker.env",
    });
  });
});
