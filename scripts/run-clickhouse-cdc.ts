import * as Sentry from "@sentry/node";
import { setupClickHouseCdcFromEnv } from "../src/db/clickhouse-cdc.ts";
import { captureException } from "../src/lib/error-reporting.ts";

function requireEnvironmentVariable(environmentVariableName: string): string {
  const value = process.env[environmentVariableName];
  if (!value) {
    throw new Error(`${environmentVariableName} is required`);
  }

  return value;
}

function applyLocalDefaults(): void {
  const localPostgresPassword = requireEnvironmentVariable("POSTGRES_PASSWORD");
  const localClickHousePassword = requireEnvironmentVariable("CLICKHOUSE_PASSWORD");
  const localDatabaseUrl = requireEnvironmentVariable("DATABASE_URL");
  const localClickHouseUrl = requireEnvironmentVariable("CLICKHOUSE_URL");

  process.env.POSTGRES_PASSWORD = localPostgresPassword;
  process.env.CLICKHOUSE_PASSWORD = localClickHousePassword;
  process.env.DATABASE_URL = localDatabaseUrl;
  process.env.CLICKHOUSE_URL = localClickHouseUrl;
  process.env.PEERDB_CDC_HOST = process.env.PEERDB_CDC_HOST ?? "127.0.0.1";
  process.env.PEERDB_CDC_PORT = process.env.PEERDB_CDC_PORT ?? "9900";
}

export async function main(): Promise<void> {
  applyLocalDefaults();

  const sentryDsn = process.env.SENTRY_DSN || process.env.SENTRY_DSN_unencrypted;
  if (sentryDsn) {
    Sentry.init({ dsn: sentryDsn, skipOpenTelemetrySetup: true });
  }

  try {
    await setupClickHouseCdcFromEnv();
    console.log("[clickhouse-cdc] PeerDB metric_stream CDC mirror configured");
    await Sentry.close(2_000);
    process.exit(0);
  } catch (error: unknown) {
    captureException(error);
    console.error(`[clickhouse-cdc] ${error}`);
    await Sentry.close(2_000);
    process.exit(1);
  }
}

const isDirectExecution =
  typeof process.argv[1] === "string" &&
  import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""));

if (isDirectExecution) {
  main();
}
