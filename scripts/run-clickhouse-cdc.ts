import * as Sentry from "@sentry/node";
import { setupClickHouseCdcFromEnv } from "../src/db/clickhouse-cdc.ts";

function applyLocalDefaults(): void {
  const localPostgresHost = process.env.POSTGRES_HOST ?? "127.0.0.1";
  const localPostgresPort = process.env.POSTGRES_PORT ?? "5435";
  const localPostgresUser = process.env.POSTGRES_USER ?? "health";
  const localPostgresPassword = process.env.POSTGRES_PASSWORD ?? "health";
  const localPostgresDatabase = process.env.POSTGRES_DB ?? "health";
  const localClickHousePassword = process.env.CLICKHOUSE_PASSWORD ?? "health";
  const localClickHouseHost = process.env.CLICKHOUSE_HOST ?? "127.0.0.1";
  const localClickHousePort =
    process.env.CLICKHOUSE_HTTP_PORT ?? process.env.CLICKHOUSE_PORT ?? "8123";

  process.env.POSTGRES_PASSWORD = localPostgresPassword;
  process.env.PEERDB_CDC_HOST = process.env.PEERDB_CDC_HOST ?? "127.0.0.1";
  process.env.PEERDB_CDC_PORT = process.env.PEERDB_CDC_PORT ?? "9900";

  process.env.DATABASE_URL ??= `postgres://${localPostgresUser}:${encodeURIComponent(localPostgresPassword)}@${localPostgresHost}:${localPostgresPort}/${localPostgresDatabase}`;
  process.env.CLICKHOUSE_URL ??= `http://default:${encodeURIComponent(localClickHousePassword)}@${localClickHouseHost}:${localClickHousePort}`;
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
    Sentry.captureException(error);
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
