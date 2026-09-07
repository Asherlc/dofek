import * as Sentry from "@sentry/node";
import { createClickHouseClientFromEnv } from "../src/db/clickhouse.ts";
import { captureException } from "../src/lib/error-reporting.ts";
import {
  createProcessingReconciliationDatabaseFromEnv,
  reconcilePendingProcessingOperations,
} from "../src/processing/processing-reconciler.ts";

export async function main(): Promise<void> {
  const sentryDsn = process.env.SENTRY_DSN || process.env.SENTRY_DSN_unencrypted;
  if (sentryDsn) {
    Sentry.init({ dsn: sentryDsn, skipOpenTelemetrySetup: true });
  }

  let clickHouseClient: ReturnType<typeof createClickHouseClientFromEnv> | null = null;
  let exitCode = 0;
  try {
    clickHouseClient = createClickHouseClientFromEnv();
    const reconciliation = await reconcilePendingProcessingOperations({
      database: createProcessingReconciliationDatabaseFromEnv(),
      clickHouseClient,
    });
    console.log(
      `[processing-reconciliation] checked ${reconciliation.checked}, completed ${reconciliation.completed}, waiting ${reconciliation.waiting}`,
    );
  } catch (error: unknown) {
    exitCode = 1;
    captureException(error);
    console.error(`[processing-reconciliation] ${error}`);
  } finally {
    await Sentry.close(2_000);
    await clickHouseClient?.close?.();
  }

  process.exit(exitCode);
}

const isDirectExecution =
  typeof process.argv[1] === "string" &&
  import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""));

if (isDirectExecution) {
  void main();
}
