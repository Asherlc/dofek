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
  "BREVO_API_KEY",
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
  "GARMIN_CLIENT_ID",
  "GARMIN_CLIENT_SECRET",
  "GARMIN_WEBHOOK_SECRET",
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
  "ZIVA_CLIENT_ID",
  "ZIVA_CLIENT_SECRET",
  "ZOHO_DESK_CLIENT_ID",
  "ZOHO_DESK_CLIENT_SECRET",
  "ZOHO_DESK_DATA_CENTER",
  "ZOHO_DESK_DEPARTMENT_ID",
  "ZOHO_DESK_ORG_ID",
  "ZOHO_DESK_REFRESH_TOKEN",
] as const;

const WEB_ONLY_ENVIRONMENT_KEYS = ["MCP_OIDC_COOKIE_KEY", "OPENAI_APPS_CHALLENGE_TOKEN"] as const;

const APP_STORE_ENVIRONMENT_KEYS = [
  "APP_STORE_ISSUER_ID",
  "APP_STORE_KEY_ID",
  "APP_STORE_PRIVATE_KEY",
  "APP_STORE_APP_ID",
  "APP_STORE_BUNDLE_ID",
  "APP_STORE_SUBSCRIPTION_PRODUCT_ID",
  "APP_STORE_ROOT_CERTIFICATES_PEM",
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
  "METRIC_STREAM_LEGACY_TOPIC",
  "AXIOM_API_TOKEN",
  "AXIOM_LOG_DATASET",
  "AXIOM_ORG_ID",
  "CLICKHOUSE_PASSWORD",
  "METRIC_STREAM_LIVE_TOPIC",
  "METRIC_STREAM_HISTORY_TOPIC",
  "PEERDB_STAGE_S3_ACCESS_KEY_ID",
  "PEERDB_STAGE_S3_BUCKET",
  "PEERDB_STAGE_S3_ENDPOINT",
  "POSTGRES_PASSWORD",
  "POSTHOG_API_HOST",
  "POSTHOG_PERSONAL_API_KEY",
  "POSTHOG_PROJECT_ID",
  "KAFKA_BROKERS",
  "SENTRY_API_HOST",
  "SENTRY_AUTH_TOKEN",
  "SENTRY_ORG",
] as const;

const METRIC_STREAM_ENVIRONMENT_KEYS = [
  "METRIC_STREAM_LIVE_TOPIC",
  "METRIC_STREAM_HISTORY_TOPIC",
  "KAFKA_BROKERS",
] as const;

function makeTemporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "dofek-deploy-service-env-"));
  temporaryDirectories.push(directory);
  return directory;
}

function completeDeployEnvironment(): Record<string, string> {
  const runtimeKeys = new Set([
    ...APPLICATION_ENVIRONMENT_KEYS,
    ...APP_STORE_ENVIRONMENT_KEYS,
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
    KAFKA_BROKERS: "kafka:9092",
    METRIC_STREAM_TRANSPORT_EPOCH: "transport-epoch-fixture",
    METRIC_STREAM_LEGACY_TOPIC: "metric-stream-v2",
    METRIC_STREAM_LIVE_TOPIC: "metric-stream-live-v2",
    METRIC_STREAM_HISTORY_TOPIC: "metric-stream-history-v2",
    METRIC_STREAM_R2_BUCKET: "dofek-metric-stream-archive",
    KAFKA_CLUSTER_ID: "MkU3OEVBNTcwNTJENDM2Qk",
    KAFKA_TIERED_STORAGE_BUCKET: "dofek-kafka-ts-offload",
    KAFKA_TIERED_STORAGE_ENDPOINT: "https://example.r2.cloudflarestorage.com",
    KAFKA_TIERED_STORAGE_REGION: "auto",
    KAFKA_TIERED_STORAGE_ACCESS_KEY_ID: "kafka-ts-access-key-id",
    KAFKA_TIERED_STORAGE_SECRET_ACCESS_KEY: "kafka-ts-secret-access-key",
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
  it("gives only the migration-phase web artifact the explicit legacy producer topic", () => {
    const directory = makeTemporaryDirectory();
    const sourcePath = join(directory, "all.env");
    writeFileSync(
      sourcePath,
      dotenv({
        ...completeDeployEnvironment(),
        METRIC_STREAM_TOPIC: "unassigned-topic",
      }),
    );
    const paths = renderDeployServiceEnvironmentFiles(sourcePath, join(directory, "services"));
    const web = parseEnv(readFileSync(paths.web, "utf8"));
    const migrationWeb = parseEnv(
      readFileSync(join(directory, "services", "web-pre-migration.env"), "utf8"),
    );

    expect(migrationWeb).toEqual({
      ...web,
      METRIC_STREAM_TOPIC: "metric-stream-v2",
    });
    expect(migrationWeb).toMatchObject({
      METRIC_STREAM_LIVE_TOPIC: "metric-stream-live-v2",
      METRIC_STREAM_HISTORY_TOPIC: "metric-stream-history-v2",
    });
    expect(web).not.toHaveProperty("METRIC_STREAM_TOPIC");
    expect(web.MCP_OIDC_COOKIE_KEY).toBe("mcp_oidc_cookie_key-value");
    expect(migrationWeb.MCP_OIDC_COOKIE_KEY).toBe("mcp_oidc_cookie_key-value");
    expect(parseEnv(readFileSync(paths.worker, "utf8"))).not.toHaveProperty("MCP_OIDC_COOKIE_KEY");
    expect(parseEnv(readFileSync(paths.analyticsWorker, "utf8"))).not.toHaveProperty(
      "MCP_OIDC_COOKIE_KEY",
    );
    expect(migrationWeb).not.toHaveProperty("METRIC_STREAM_CONSUMER_GROUP");
    expect(migrationWeb).not.toHaveProperty("METRIC_STREAM_SUBSCRIPTION");
  });

  it("renders each sink and archive with KAFKA_BROKERS and no REDPANDA_/PULSAR_ aliases", () => {
    const directory = makeTemporaryDirectory();
    const sourcePath = join(directory, "all.env");
    writeFileSync(
      sourcePath,
      dotenv({
        ...completeDeployEnvironment(),
        METRIC_STREAM_TOPIC: "unassigned-topic",
        METRIC_STREAM_CONSUMER_GROUP: "unassigned-group",
        METRIC_STREAM_SUBSCRIPTION: "unassigned-subscription",
      }),
    );
    renderDeployServiceEnvironmentFiles(sourcePath, join(directory, "services"));

    for (const [service, topic] of [
      ["metric-stream-clickhouse-sink", "metric-stream-v2"],
      ["metric-stream-live-clickhouse-sink", "metric-stream-live-v2"],
      ["metric-stream-history-clickhouse-sink", "metric-stream-history-v2"],
      ["metric-stream-r2-archive", "metric-stream-v2"],
      ["metric-stream-live-r2-archive", "metric-stream-live-v2"],
      ["metric-stream-history-r2-archive", "metric-stream-history-v2"],
    ] as const) {
      const environment = parseEnv(
        readFileSync(join(directory, "services", `${service}.env`), "utf8"),
      );
      expect(environment).toEqual({
        KAFKA_BROKERS: "kafka:9092",
        METRIC_STREAM_TRANSPORT_EPOCH: "transport-epoch-fixture",
        METRIC_STREAM_TOPIC: topic,
        METRIC_STREAM_CONSUMER_GROUP: service,
        ...(service.endsWith("r2-archive")
          ? {
              METRIC_STREAM_R2_BUCKET: "dofek-metric-stream-archive",
              R2_ENDPOINT: "r2_endpoint-value",
              R2_ACCESS_KEY_ID: "r2_access_key_id-value",
              R2_SECRET_ACCESS_KEY: "r2_secret_access_key-value",
            }
          : {}),
      });
      expect(environment).not.toHaveProperty("REDPANDA_BROKERS");
      expect(environment).not.toHaveProperty("PULSAR_SERVICE_URL");
      expect(environment).not.toHaveProperty("METRIC_STREAM_SUBSCRIPTION");
    }
  });

  it("renders kafka.env Infisical renames only (static RSM stays in stack/compose)", () => {
    const directory = makeTemporaryDirectory();
    const sourcePath = join(directory, "all.env");
    writeFileSync(sourcePath, dotenv(completeDeployEnvironment()));
    const paths = renderDeployServiceEnvironmentFiles(sourcePath, join(directory, "services"));
    const kafkaEnvText = readFileSync(paths.kafka, "utf8");
    const environment = parseEnv(kafkaEnvText);

    expect(environment.CLUSTER_ID).toBe("MkU3OEVBNTcwNTJENDM2Qk");
    expect(environment.AWS_ACCESS_KEY_ID).toBe("kafka-ts-access-key-id");
    expect(environment.AWS_SECRET_ACCESS_KEY).toBe("kafka-ts-secret-access-key");
    expect(environment.KAFKA_RSM_CONFIG_STORAGE_S3_BUCKET_NAME).toBe("dofek-kafka-ts-offload");
    expect(environment.KAFKA_RSM_CONFIG_STORAGE_S3_ENDPOINT_URL).toBe(
      "https://example.r2.cloudflarestorage.com",
    );
    expect(environment.KAFKA_RSM_CONFIG_STORAGE_S3_REGION).toBe("auto");
    // Static Aiven/RSM knobs are declarative in stack.yml / compose, not kafka.env.
    expect(environment).not.toHaveProperty("KAFKA_REMOTE_LOG_STORAGE_SYSTEM_ENABLE");
    expect(environment).not.toHaveProperty("AWS_REQUEST_CHECKSUM_CALCULATION");
    expect(environment).not.toHaveProperty("KAFKA_RSM_CONFIG_CHUNK_SIZE");
    expect(environment).not.toHaveProperty("KAFKA_TOPIC_REMOTE_STORAGE_ENABLE_REQUIRED");
    expect(environment).not.toHaveProperty("KAFKA_RSM_CONFIG_STORAGE_AWS_ACCESS_KEY_ID");
    expect(environment).not.toHaveProperty("R2_ACCESS_KEY_ID");
    expect(environment).not.toHaveProperty("KAFKA_TIERED_STORAGE_SECRET_ACCESS_KEY");
  });

  it("preserves Infisical dotenv quoting when renaming Kafka TS secrets into kafka.env", () => {
    const directory = makeTemporaryDirectory();
    const sourcePath = join(directory, "all.env");
    const environment = completeDeployEnvironment();
    // Quoted secret with shell-significant characters — Infisical may emit this form.
    environment.KAFKA_TIERED_STORAGE_ACCESS_KEY_ID = `"id-with=equals"`;
    environment.KAFKA_TIERED_STORAGE_SECRET_ACCESS_KEY = `'sec$ret"mixed'`;
    writeFileSync(sourcePath, dotenv(environment));
    const paths = renderDeployServiceEnvironmentFiles(sourcePath, join(directory, "services"));
    const kafkaEnvText = readFileSync(paths.kafka, "utf8");

    expect(kafkaEnvText).toContain(`AWS_ACCESS_KEY_ID="id-with=equals"`);
    expect(kafkaEnvText).toContain(`AWS_SECRET_ACCESS_KEY='sec$ret"mixed'`);
    const parsed = parseEnv(kafkaEnvText);
    expect(parsed.AWS_ACCESS_KEY_ID).toBe("id-with=equals");
    expect(parsed.AWS_SECRET_ACCESS_KEY).toBe(`sec$ret"mixed`);
  });

  it.each([
    "KAFKA_CLUSTER_ID",
    "KAFKA_TIERED_STORAGE_BUCKET",
    "KAFKA_TIERED_STORAGE_ENDPOINT",
    "KAFKA_TIERED_STORAGE_REGION",
    "KAFKA_TIERED_STORAGE_ACCESS_KEY_ID",
    "KAFKA_TIERED_STORAGE_SECRET_ACCESS_KEY",
  ])("rejects a missing %s for the kafka broker env file", (key) => {
    const directory = makeTemporaryDirectory();
    const sourcePath = join(directory, "all.env");
    const environment: Record<string, string> = { ...completeDeployEnvironment() };
    delete environment[key];
    writeFileSync(sourcePath, dotenv(environment));
    expect(() =>
      renderDeployServiceEnvironmentFiles(sourcePath, join(directory, "services")),
    ).toThrow(new RegExp(key));
  });

  it.each([
    "METRIC_STREAM_LEGACY_TOPIC",
    "METRIC_STREAM_LIVE_TOPIC",
    "METRIC_STREAM_HISTORY_TOPIC",
    "METRIC_STREAM_R2_BUCKET",
    "KAFKA_BROKERS",
    "METRIC_STREAM_TRANSPORT_EPOCH",
  ])("rejects a missing %s even when a generic topic is supplied", (key) => {
    const directory = makeTemporaryDirectory();
    const sourcePath = join(directory, "all.env");
    const environment: Record<string, string> = {
      ...completeDeployEnvironment(),
      METRIC_STREAM_TOPIC: "wrong-route",
    };
    delete environment[key];
    writeFileSync(sourcePath, dotenv(environment));
    expect(() =>
      renderDeployServiceEnvironmentFiles(sourcePath, join(directory, "services")),
    ).toThrow(`missing required keys: ${key}`);
  });

  it("rejects a Pulsar persistent URI as a Kafka topic name", () => {
    const directory = makeTemporaryDirectory();
    const sourcePath = join(directory, "all.env");
    writeFileSync(
      sourcePath,
      dotenv({
        ...completeDeployEnvironment(),
        METRIC_STREAM_LEGACY_TOPIC: "persistent://public/default/metric-stream-v2",
      }),
    );
    expect(() =>
      renderDeployServiceEnvironmentFiles(sourcePath, join(directory, "services")),
    ).toThrow("METRIC_STREAM_TOPIC must be a Kafka topic name, not a Pulsar persistent URI");
  });

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
        ...APP_STORE_ENVIRONMENT_KEYS,
        ...WEB_ONLY_ENVIRONMENT_KEYS,
        ...METRIC_STREAM_ENVIRONMENT_KEYS,
      ].sort(),
    );
    expect(web).not.toHaveProperty("CLOUDFLARE_API_TOKEN");
    expect(web).not.toHaveProperty("POSTGRES_PASSWORD");
    expect(web).not.toHaveProperty("POSTHOG_PERSONAL_API_KEY");
    expect(web).not.toHaveProperty("SENTRY_AUTH_TOKEN");

    const worker = parseEnv(readFileSync(paths.worker, "utf8"));
    expect(Object.keys(worker).sort()).toEqual(
      [...APPLICATION_ENVIRONMENT_KEYS, ...WORKER_ONLY_ENVIRONMENT_KEYS].sort(),
    );
    expect(worker).not.toHaveProperty("CLOUDFLARE_API_TOKEN");
    expect(worker).not.toHaveProperty("APP_STORE_PRIVATE_KEY");
    expect(worker).not.toHaveProperty("OTA_PRIVATE_KEY_B64");
    for (const producer of [web, worker]) {
      expect(producer).toMatchObject({
        METRIC_STREAM_LIVE_TOPIC: "metric-stream-live-v2",
        METRIC_STREAM_HISTORY_TOPIC: "metric-stream-history-v2",
      });
    }

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

  it("routes Ziva app credentials only to application services", () => {
    const directory = makeTemporaryDirectory();
    const sourcePath = join(directory, "all.env");
    writeFileSync(sourcePath, dotenv(completeDeployEnvironment()));

    const paths = renderDeployServiceEnvironmentFiles(sourcePath, join(directory, "services"));
    const applicationArtifacts = [paths.web, paths.webPreMigration, paths.worker];
    for (const artifact of applicationArtifacts) {
      expect(parseEnv(readFileSync(artifact, "utf8"))).toMatchObject({
        ZIVA_CLIENT_ID: "ziva_client_id-value",
        ZIVA_CLIENT_SECRET: "ziva_client_secret-value",
      });
    }

    for (const [service, artifact] of Object.entries(paths)) {
      if (["web", "webPreMigration", "worker"].includes(service)) continue;
      const environment = parseEnv(readFileSync(artifact, "utf8"));
      expect(environment, `${service} environment`).not.toHaveProperty("ZIVA_CLIENT_ID");
      expect(environment, `${service} environment`).not.toHaveProperty("ZIVA_CLIENT_SECRET");
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

  it("provides the worker with the ClickHouse password required by dbt jobs", () => {
    const directory = makeTemporaryDirectory();
    const sourcePath = join(directory, "all.env");
    writeFileSync(sourcePath, dotenv(completeDeployEnvironment()));

    const paths = renderDeployServiceEnvironmentFiles(sourcePath, join(directory, "services"));

    expect(parseEnv(readFileSync(paths.worker, "utf8"))).toHaveProperty(
      "CLICKHOUSE_PASSWORD",
      "clickhouse_password-value",
    );
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
    delete environment.METRIC_STREAM_LIVE_TOPIC;
    delete environment.METRIC_STREAM_HISTORY_TOPIC;
    delete environment.KAFKA_BROKERS;
    writeFileSync(sourcePath, dotenv(environment));

    expect(() =>
      renderDeployServiceEnvironmentFiles(sourcePath, join(directory, "services")),
    ).toThrow(
      "web deploy environment is missing required keys: METRIC_STREAM_LIVE_TOPIC, METRIC_STREAM_HISTORY_TOPIC, KAFKA_BROKERS",
    );
  });

  it("fails before web startup when the OpenAI Apps challenge token is missing", () => {
    const directory = makeTemporaryDirectory();
    const sourcePath = join(directory, "all.env");
    const environment = completeDeployEnvironment();
    delete environment.OPENAI_APPS_CHALLENGE_TOKEN;
    writeFileSync(sourcePath, dotenv(environment));

    expect(() =>
      renderDeployServiceEnvironmentFiles(sourcePath, join(directory, "services")),
    ).toThrow("web deploy environment is missing required keys: OPENAI_APPS_CHALLENGE_TOKEN");
  });

  it.each([undefined, ""])(
    "fails before web startup when the MCP OIDC cookie key is missing or blank (%s)",
    (value) => {
      const directory = makeTemporaryDirectory();
      const sourcePath = join(directory, "all.env");
      const environment = completeDeployEnvironment();
      if (value === undefined) delete environment.MCP_OIDC_COOKIE_KEY;
      else environment.MCP_OIDC_COOKIE_KEY = value;
      writeFileSync(sourcePath, dotenv(environment));

      expect(() =>
        renderDeployServiceEnvironmentFiles(sourcePath, join(directory, "services")),
      ).toThrow("web deploy environment is missing required keys: MCP_OIDC_COOKIE_KEY");
    },
  );

  it("fails before web startup when App Store verification configuration is incomplete", () => {
    const directory = makeTemporaryDirectory();
    const sourcePath = join(directory, "all.env");
    const environment = completeDeployEnvironment();
    delete environment.APP_STORE_PRIVATE_KEY;
    delete environment.APP_STORE_ROOT_CERTIFICATES_PEM;
    writeFileSync(sourcePath, dotenv(environment));

    expect(() =>
      renderDeployServiceEnvironmentFiles(sourcePath, join(directory, "services")),
    ).toThrow(
      "web deploy environment is missing required keys: APP_STORE_PRIVATE_KEY, APP_STORE_ROOT_CERTIFICATES_PEM",
    );
  });

  it("fails before web startup when transactional email configuration is incomplete", () => {
    const directory = makeTemporaryDirectory();
    const sourcePath = join(directory, "all.env");
    const environment = completeDeployEnvironment();
    delete environment.BREVO_API_KEY;
    delete environment.EXPORT_EMAIL_FROM;
    writeFileSync(sourcePath, dotenv(environment));

    expect(() =>
      renderDeployServiceEnvironmentFiles(sourcePath, join(directory, "services")),
    ).toThrow("web deploy environment is missing required keys: BREVO_API_KEY, EXPORT_EMAIL_FROM");
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
      webPreMigration: "web-pre-migration.env",
      worker: "worker.env",
      kafka: "kafka.env",
      metricStreamClickhouseSink: "metric-stream-clickhouse-sink.env",
      metricStreamLiveClickhouseSink: "metric-stream-live-clickhouse-sink.env",
      metricStreamHistoryClickhouseSink: "metric-stream-history-clickhouse-sink.env",
      metricStreamR2Archive: "metric-stream-r2-archive.env",
      metricStreamLiveR2Archive: "metric-stream-live-r2-archive.env",
      metricStreamHistoryR2Archive: "metric-stream-history-r2-archive.env",
    });
  });
});
