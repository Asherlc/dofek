import { captureException } from "../lib/error-reporting.ts";
import { logger } from "../logger.ts";
import { setupClickHouseCdcFromEnv } from "./clickhouse-cdc.ts";

export async function main(): Promise<void> {
  await setupClickHouseCdcFromEnv();
  logger.info("[clickhouse-cdc] PeerDB raw analytics CDC mirrors are configured");
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
