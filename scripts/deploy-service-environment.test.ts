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

const APPLICATION_ENVIRONMENT_KEYS = [
  "ACCOUNT_ERASURE_LEDGER_KEYRING_JSON",
  "APPLE_BUNDLE_ID",
  "APPLE_CLIENT_ID",
  "APPLE_KEY_ID",
  "APPLE_REDIRECT_URI",
  "APPLE_TEAM_ID",
  "BODYSPEC_CLIENT_ID",
  "BODYSPEC_CLIENT_SECRET",
  "BREVO_SMTP_KEY",
  "BREVO_SMTP_USER",
  "CONCEPT2_CLIENT_ID",
  "CONCEPT2_CLIENT_SECRET",
  "COROS_CLIENT_ID",
  "COROS_CLIENT_SECRET",
  "CREDENTIAL_ENCRYPTION_KEY_BASE64",
  "CREDENTIAL_ENCRYPTION_KEY_NAME",
  "CREDENTIAL_ENCRYPTION_KEY_NAMESPACE",
  "CYCLING_ANALYTICS_CLIENT_ID",
  "CYCLING_ANALYTICS_CLIENT_SECRET",
  "DECATHLON_CLIENT_ID",
  "DECATHLON_CLIENT_SECRET",
  "EXPORT_EMAIL_FROM",
  "FATSECRET_CONSUMER_KEY",
  "FATSECRET_CONSUMER_SECRET",
  "FITBIT_CLIENT_ID",
  "FITBIT_CLIENT_SECRET",
  "GOOGLE_CLIENT_ID",
  "GOOGLE_CLIENT_SECRET",
  "GOOGLE_REDIRECT_URI",
  "KOMOOT_CLIENT_ID",
  "KOMOOT_CLIENT_SECRET",
  "MAPMYFITNESS_CLIENT_ID",
  "MAPMYFITNESS_CLIENT_SECRET",
  "OAUTH_REDIRECT_URI",
  "OURA_CLIENT_ID",
  "OURA_CLIENT_SECRET",
  "POLAR_CLIENT_ID",
  "POLAR_CLIENT_SECRET",
  "R2_ACCESS_KEY_ID",
  "R2_ENDPOINT",
  "R2_SECRET_ACCESS_KEY",
  "RWGPS_CLIENT_ID",
  "RWGPS_CLIENT_SECRET",
  "SENTRY_DSN",
  "SENTRY_DSN_unencrypted",
  "STRAVA_CLIENT_ID",
  "STRAVA_CLIENT_SECRET",
  "STRIPE_PRICE_ID",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "SUUNTO_CLIENT_ID",
  "SUUNTO_CLIENT_SECRET",
  "SUUNTO_SUBSCRIPTION_KEY",
  "ULTRAHUMAN_API_TOKEN",
  "ULTRAHUMAN_EMAIL",
  "WAHOO_CLIENT_ID",
  "WAHOO_CLIENT_SECRET",
  "WGER_CLIENT_ID",
  "WGER_CLIENT_SECRET",
  "WITHINGS_CLIENT_ID",
  "WITHINGS_CLIENT_SECRET",
  "XERT_CLIENT_ID",
  "XERT_CLIENT_SECRET",
  "ZEPP_API_BASE_URL",
  "ZOHO_DESK_CLIENT_ID",
  "ZOHO_DESK_CLIENT_SECRET",
  "ZOHO_DESK_DATA_CENTER",
  "ZOHO_DESK_DEPARTMENT_ID",
  "ZOHO_DESK_ORG_ID",
  "ZOHO_DESK_REFRESH_TOKEN",
] as const;

const WEB_ONLY_ENVIRONMENT_KEYS = [
  "GEMINI_API_KEY",
  "MISTRAL_API_KEY",
] as const;

const CDC_ENVIRONMENT_KEYS = [
  "PEERDB_CDC_CLICKHOUSE_HOST",
  "PEERDB_CDC_CLICKHOUSE_PORT",
  "PEERDB_CDC_HOST",
  "PEERDB_CDC_PASSWORD",
  "PEERDB_CDC_PORT",
  "PEERDB_CDC_POSTGRES_HOST",
  "PEERDB_CDC_POSTGRES_PORT",
  "PEERDB_CDC_SQL_TEMPLATE_PATH",
  "PEERDB_PASSWORD",
  "PEERDB_UI_PORT",
  "POSTGRES_PASSWORD",
] as const;

const WORKER_ONLY_ENVIRONMENT_KEYS = [
  "AXIOM_API_TOKEN",
  "AXIOM_LOG_DATASET",
  "AXIOM_ORG_ID",
  "BREVO_API_KEY",
  "METRIC_STREAM_TOPIC",
  "PEERDB_STAGE_S3_ACCESS_KEY_ID",
  "PEERDB_STAGE_S3_BUCKET",
  "PEERDB_STAGE_S3_ENDPOINT",
  "POSTGRES_PASSWORD",
  "POSTHOG_API_HOST",
  "POSTHOG_PERSONAL_API_KEY",
  "POSTHOG_PROJECT_ID",
  "REDPANDA_BROKERS",
  "SENTRY_API_HOST",
  "SENTRY_AUTH_TOKEN",
  "SENTRY_ORG",
] as const;

const METRIC_STREAM_ENVIRONMENT_KEYS = ["METRIC_STREAM_TOPIC", "REDPANDA_BROKERS"] as const;

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "dofek-deploy-service-env-"));
  temporaryDirectories.push(directory);
  return directory;
}

function completeDeployEnvironment(): Record<string, string> {
  const runtimeKeys = new Set([
    ...APPLICATION_ENVIRONMENT_KEYS,
    ...WEB_ONLY_ENVIRONMENT_KEYS,
    ...CDC_ENVIRONMENT_KEYS,
    ...WORKER_ONLY_ENVIRONMENT_KEYS,
    "CLICKHOUSE_PASSWORD",
    "CREDENTIAL_ENCRYPTION_KEY_BASE64",
  ]);
  return {
    ...Object.fromEntries([...runtimeKeys].map((key) => [key, `${key.toLowerCase()}-value`])),
    CLOUDFLARE_API_TOKEN: "cloudflare-control-plane-token",
    OTA_PRIVATE_KEY_B64: "ota-private-key",
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
    expect(Object.keys(web).sort()).toEqual(
      [
        ...APPLICATION_ENVIRONMENT_KEYS,
        ...WEB_ONLY_ENVIRONMENT_KEYS,
        ...METRIC_STREAM_ENVIRONMENT_KEYS,
      ].sort(),
    );
    expect(web).not.toHaveProperty("BREVO_API_KEY");
    expect(web).not.toHaveProperty("CLOUDFLARE_API_TOKEN");
    expect(web).not.toHaveProperty("POSTGRES_PASSWORD");
    expect(web).not.toHaveProperty("POSTHOG_PERSONAL_API_KEY");
    expect(web).not.toHaveProperty("SENTRY_AUTH_TOKEN");

    const worker = parseEnv(readFileSync(paths.worker, "utf8"));
    expect(Object.keys(worker).sort()).toEqual(
      [...APPLICATION_ENVIRONMENT_KEYS, ...WORKER_ONLY_ENVIRONMENT_KEYS].sort(),
    );
    expect(worker).not.toHaveProperty("CLOUDFLARE_API_TOKEN");
    expect(worker).not.toHaveProperty("GEMINI_API_KEY");
    expect(worker).not.toHaveProperty("OTA_PRIVATE_KEY_B64");

    expect(parseEnv(readFileSync(paths.analyticsWorker, "utf8"))).toEqual({
      CLICKHOUSE_PASSWORD: "clickhouse_password-value",
      SENTRY_DSN: "sentry_dsn-value",
      SENTRY_DSN_unencrypted: "sentry_dsn_unencrypted-value",
    });
    expect(Object.keys(parseEnv(readFileSync(paths.cdcHealth, "utf8"))).sort()).toEqual(
      [...CDC_ENVIRONMENT_KEYS, "SENTRY_DSN", "SENTRY_DSN_unencrypted"].sort(),
    );
    expect(Object.keys(parseEnv(readFileSync(paths.cdcOperations, "utf8"))).sort()).toEqual(
      [...CDC_ENVIRONMENT_KEYS].sort(),
    );
    expect(parseEnv(readFileSync(paths.collector, "utf8"))).toEqual({
      AXIOM_API_TOKEN: "axiom_api_token-value",
    });
    expect(parseEnv(readFileSync(paths.databaseOperations, "utf8"))).toEqual({
      CREDENTIAL_ENCRYPTION_KEY_BASE64: "credential_encryption_key_base64-value",
      CREDENTIAL_ENCRYPTION_KEY_NAME: "credential_encryption_key_name-value",
      CREDENTIAL_ENCRYPTION_KEY_NAMESPACE: "credential_encryption_key_namespace-value",
      POSTGRES_PASSWORD: "postgres_password-value",
    });
    expect(parseEnv(readFileSync(paths.r2Operations, "utf8"))).toEqual({
      R2_ACCESS_KEY_ID: "r2_access_key_id-value",
      R2_ENDPOINT: "r2_endpoint-value",
      R2_SECRET_ACCESS_KEY: "r2_secret_access_key-value",
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

  it("fails before analytics startup when the ClickHouse password is missing", () => {
    const directory = makeTemporaryDirectory();
    const sourcePath = join(directory, "all.env");
    const environment = completeDeployEnvironment();
    delete environment.CLICKHOUSE_PASSWORD;
    writeFileSync(sourcePath, dotenv(environment));

    expect(() =>
      renderDeployServiceEnvironmentFiles(sourcePath, join(directory, "services")),
    ).toThrow("analyticsWorker deploy environment is missing required keys: CLICKHOUSE_PASSWORD");
  });

  it("fails before worker startup when a worker-only contract is incomplete", () => {
    const directory = makeTemporaryDirectory();
    const sourcePath = join(directory, "all.env");
    const environment = completeDeployEnvironment();
    delete environment.SENTRY_AUTH_TOKEN;
    writeFileSync(sourcePath, dotenv(environment));

    expect(() =>
      renderDeployServiceEnvironmentFiles(sourcePath, join(directory, "services")),
    ).toThrow("worker deploy environment is missing required keys: SENTRY_AUTH_TOKEN");
  });

  it("fails before web startup when the metric-stream contract is incomplete", () => {
    const directory = makeTemporaryDirectory();
    const sourcePath = join(directory, "all.env");
    const environment = completeDeployEnvironment();
    delete environment.METRIC_STREAM_TOPIC;
    delete environment.REDPANDA_BROKERS;
    writeFileSync(sourcePath, dotenv(environment));

    expect(() =>
      renderDeployServiceEnvironmentFiles(sourcePath, join(directory, "services")),
    ).toThrow(
      "web deploy environment is missing required keys: METRIC_STREAM_TOPIC, REDPANDA_BROKERS",
    );
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
