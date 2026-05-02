import { captureException } from "@sentry/node";
import { logger } from "../logger.ts";
import { setupClickHouseCdcFromEnv } from "./clickhouse-cdc.ts";

export async function main(): Promise<void> {
  await setupClickHouseCdcFromEnv();
  logger.info("[clickhouse-cdc] PeerDB metric_stream CDC mirror is configured");
}

const isDirectRun =
  typeof process.argv[1] === "string" &&
  import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""));

if (isDirectRun) {
  main()
    .then(() => process.exit(0))
    .catch((error) => {
      logger.error(`[clickhouse-cdc] ${error}`);
      captureException(error);
      process.exit(1);
    });
}
