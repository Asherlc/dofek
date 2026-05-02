import * as Sentry from "@sentry/node";
import { logger } from "../logger.ts";
import { setupClickHouseCdcFromEnv } from "./clickhouse-cdc.ts";

export async function main(): Promise<void> {
  await setupClickHouseCdcFromEnv();
  logger.info("[clickhouse-cdc] PeerDB metric_stream CDC mirror is configured");
}

const isDirectRun =
  typeof process.argv[1] === "string" &&
  import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""));

function initializeSentryForDirectRun(): boolean {
  const sentryDsn = process.env.SENTRY_DSN || process.env.SENTRY_DSN_unencrypted;
  if (!sentryDsn) {
    return false;
  }
  Sentry.init({ dsn: sentryDsn, skipOpenTelemetrySetup: true });
  return true;
}

if (isDirectRun) {
  const sentryInitialized = initializeSentryForDirectRun();
  main().catch(async (error) => {
    logger.error(`[clickhouse-cdc] ${error}`);
    Sentry.captureException(error);
    if (sentryInitialized) {
      await Sentry.close(2000);
    }
    process.exitCode = 1;
  });
}
