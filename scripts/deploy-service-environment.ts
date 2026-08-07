import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

const DEPLOY_SERVICE_NAMES = [
  "analyticsWorker",
  "cdcHealth",
  "cdcOperations",
  "collector",
  "databaseOperations",
  "r2Operations",
  "web",
  "worker",
] as const;

type DeployServiceName = (typeof DEPLOY_SERVICE_NAMES)[number];

export const DEPLOY_SERVICE_ENVIRONMENT_FILE_NAMES = {
  analyticsWorker: "analytics-worker.env",
  cdcHealth: "cdc-health.env",
  cdcOperations: "cdc-operations.env",
  collector: "collector.env",
  databaseOperations: "database-operations.env",
  r2Operations: "r2-operations.env",
  web: "web.env",
  worker: "worker.env",
} satisfies Record<DeployServiceName, string>;

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
  "SLACK_CLIENT_ID",
  "SLACK_CLIENT_SECRET",
  "SLACK_SIGNING_SECRET",
] as const;

const METRIC_STREAM_ENVIRONMENT_KEYS = ["METRIC_STREAM_TOPIC", "REDPANDA_BROKERS"] as const;

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

interface DeployServiceEnvironmentPolicy {
  allowedKeys: readonly string[];
  requiredKeys: readonly string[];
}

const COMMON_APPLICATION_REQUIRED_KEYS = [
  "ACCOUNT_ERASURE_LEDGER_KEYRING_JSON",
  "CREDENTIAL_ENCRYPTION_KEY_BASE64",
  "R2_ACCESS_KEY_ID",
  "R2_ENDPOINT",
  "R2_SECRET_ACCESS_KEY",
  "STRIPE_PRICE_ID",
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
] as const;

const DEPLOY_SERVICE_ENVIRONMENT_POLICIES = {
  analyticsWorker: {
    allowedKeys: ["CLICKHOUSE_PASSWORD", "SENTRY_DSN", "SENTRY_DSN_unencrypted"],
    requiredKeys: ["CLICKHOUSE_PASSWORD"],
  },
  cdcHealth: {
    allowedKeys: [...CDC_ENVIRONMENT_KEYS, "SENTRY_DSN", "SENTRY_DSN_unencrypted"],
    requiredKeys: ["POSTGRES_PASSWORD"],
  },
  cdcOperations: {
    allowedKeys: CDC_ENVIRONMENT_KEYS,
    requiredKeys: ["POSTGRES_PASSWORD"],
  },
  collector: {
    allowedKeys: ["AXIOM_API_TOKEN"],
    requiredKeys: ["AXIOM_API_TOKEN"],
  },
  databaseOperations: {
    allowedKeys: [
      "CREDENTIAL_ENCRYPTION_KEY_BASE64",
      "CREDENTIAL_ENCRYPTION_KEY_NAME",
      "CREDENTIAL_ENCRYPTION_KEY_NAMESPACE",
      "POSTGRES_PASSWORD",
    ],
    requiredKeys: ["CREDENTIAL_ENCRYPTION_KEY_BASE64", "POSTGRES_PASSWORD"],
  },
  r2Operations: {
    allowedKeys: ["R2_ACCESS_KEY_ID", "R2_ENDPOINT", "R2_SECRET_ACCESS_KEY"],
    requiredKeys: ["R2_ACCESS_KEY_ID", "R2_ENDPOINT", "R2_SECRET_ACCESS_KEY"],
  },
  web: {
    allowedKeys: [
      ...APPLICATION_ENVIRONMENT_KEYS,
      ...METRIC_STREAM_ENVIRONMENT_KEYS,
      ...WEB_ONLY_ENVIRONMENT_KEYS,
    ],
    requiredKeys: [...COMMON_APPLICATION_REQUIRED_KEYS, ...METRIC_STREAM_ENVIRONMENT_KEYS],
  },
  worker: {
    allowedKeys: [
      ...APPLICATION_ENVIRONMENT_KEYS,
      "AXIOM_API_TOKEN",
      "AXIOM_LOG_DATASET",
      "AXIOM_ORG_ID",
      "BREVO_API_KEY",
      ...METRIC_STREAM_ENVIRONMENT_KEYS,
      "PEERDB_STAGE_S3_ACCESS_KEY_ID",
      "PEERDB_STAGE_S3_BUCKET",
      "PEERDB_STAGE_S3_ENDPOINT",
      "POSTGRES_PASSWORD",
      "POSTHOG_API_HOST",
      "POSTHOG_PERSONAL_API_KEY",
      "POSTHOG_PROJECT_ID",
      "SENTRY_API_HOST",
      "SENTRY_AUTH_TOKEN",
      "SENTRY_ORG",
    ],
    requiredKeys: [
      ...COMMON_APPLICATION_REQUIRED_KEYS,
      "AXIOM_API_TOKEN",
      "BREVO_API_KEY",
      ...METRIC_STREAM_ENVIRONMENT_KEYS,
      "POSTGRES_PASSWORD",
      "POSTHOG_PERSONAL_API_KEY",
      "POSTHOG_PROJECT_ID",
      "SENTRY_AUTH_TOKEN",
      "SENTRY_ORG",
    ],
  },
} satisfies Record<DeployServiceName, DeployServiceEnvironmentPolicy>;

export interface DeployServiceEnvironmentPaths {
  analyticsWorker: string;
  cdcHealth: string;
  cdcOperations: string;
  collector: string;
  databaseOperations: string;
  r2Operations: string;
  web: string;
  worker: string;
}

function readRawAssignments(source: string): ReadonlyMap<string, string> {
  const assignments = new Map<string, string>();
  for (const line of source.split(/\r?\n/)) {
    if (line.length === 0 || line.startsWith("#")) continue;
    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      throw new Error("Rendered Infisical dotenv contains a malformed assignment");
    }
    assignments.set(line.slice(0, separatorIndex), line);
  }
  return assignments;
}

function resolvePaths(outputDirectory: string): DeployServiceEnvironmentPaths {
  return {
    analyticsWorker: join(outputDirectory, DEPLOY_SERVICE_ENVIRONMENT_FILE_NAMES.analyticsWorker),
    cdcHealth: join(outputDirectory, DEPLOY_SERVICE_ENVIRONMENT_FILE_NAMES.cdcHealth),
    cdcOperations: join(outputDirectory, DEPLOY_SERVICE_ENVIRONMENT_FILE_NAMES.cdcOperations),
    collector: join(outputDirectory, DEPLOY_SERVICE_ENVIRONMENT_FILE_NAMES.collector),
    databaseOperations: join(
      outputDirectory,
      DEPLOY_SERVICE_ENVIRONMENT_FILE_NAMES.databaseOperations,
    ),
    r2Operations: join(outputDirectory, DEPLOY_SERVICE_ENVIRONMENT_FILE_NAMES.r2Operations),
    web: join(outputDirectory, DEPLOY_SERVICE_ENVIRONMENT_FILE_NAMES.web),
    worker: join(outputDirectory, DEPLOY_SERVICE_ENVIRONMENT_FILE_NAMES.worker),
  };
}

export function renderDeployServiceEnvironmentFiles(
  sourcePath: string,
  outputDirectory: string,
): DeployServiceEnvironmentPaths {
  const source = readFileSync(sourcePath, "utf8");
  const environment = parseEnv(source);
  const assignments = readRawAssignments(source);

  for (const serviceName of DEPLOY_SERVICE_NAMES) {
    const missingKeys = DEPLOY_SERVICE_ENVIRONMENT_POLICIES[serviceName].requiredKeys.filter(
      (key) => !environment[key]?.trim(),
    );
    if (missingKeys.length > 0) {
      throw new Error(
        `${serviceName} deploy environment is missing required keys: ${missingKeys.join(", ")}`,
      );
    }
  }

  mkdirSync(outputDirectory, { mode: 0o700, recursive: true });
  chmodSync(outputDirectory, 0o700);
  const paths = resolvePaths(outputDirectory);

  for (const serviceName of DEPLOY_SERVICE_NAMES) {
    const lines = DEPLOY_SERVICE_ENVIRONMENT_POLICIES[serviceName].allowedKeys.flatMap((key) => {
      const assignment = assignments.get(key);
      return assignment === undefined ? [] : [assignment];
    });
    writeFileSync(paths[serviceName], lines.length === 0 ? "" : `${lines.join("\n")}\n`, {
      mode: 0o600,
    });
    chmodSync(paths[serviceName], 0o600);
  }

  return paths;
}
