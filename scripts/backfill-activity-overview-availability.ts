import { parseArgs } from "node:util";
import * as Sentry from "@sentry/node";
import {
  type ActivityOverviewAvailabilityBackfillOptions,
  backfillActivityOverviewAvailability,
} from "../src/db/activity-overview-availability-backfill.ts";
import { createClickHouseClientFromEnv } from "../src/db/clickhouse.ts";
import { parsePostgresTimestamp } from "../src/db/clickhouse-migrations/sql.ts";
import { captureException } from "../src/lib/error-reporting.ts";

const MAXIMUM_WINDOW_MILLISECONDS = 31 * 24 * 60 * 60 * 1_000;

function parseUtcTimestamp(value: string, optionName: string): Date {
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) {
    throw new Error(`${optionName} must include an explicit UTC time zone`);
  }
  if (!/(?:Z|\+00:?00)$/.test(value)) {
    throw new Error(`${optionName} must use UTC`);
  }
  return parsePostgresTimestamp(value, optionName);
}

export function parseActivityOverviewAvailabilityBackfillOptions(
  args: readonly string[],
): ActivityOverviewAvailabilityBackfillOptions {
  const { values } = parseArgs({
    args,
    options: {
      start: { type: "string" },
      end: { type: "string" },
      execute: { type: "boolean", default: false },
    },
    strict: true,
  });

  if (!values.start) throw new Error("--start is required");
  if (!values.end) throw new Error("--end is required");

  const start = parseUtcTimestamp(values.start, "--start");
  const end = parseUtcTimestamp(values.end, "--end");
  if (start.getTime() >= end.getTime()) {
    throw new Error("--start must be before --end");
  }
  if (end.getTime() - start.getTime() > MAXIMUM_WINDOW_MILLISECONDS) {
    throw new Error("Backfill window must not exceed 31 days");
  }
  return { start, end, execute: values.execute };
}

function initializeSentry(): void {
  const sentryDsn = process.env.SENTRY_DSN || process.env.SENTRY_DSN_unencrypted;
  if (sentryDsn) {
    Sentry.init({ dsn: sentryDsn, skipOpenTelemetrySetup: true });
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  initializeSentry();
  const options = parseActivityOverviewAvailabilityBackfillOptions(args);
  const client = createClickHouseClientFromEnv();

  try {
    const result = await backfillActivityOverviewAvailability(client, options);
    console.log(
      `[activity-overview-availability-backfill] found ${result.distanceRows} distance rows and ${result.elevationRows} elevation rows`,
    );
    if (!options.execute) {
      console.log(
        "[activity-overview-availability-backfill] dry run only; add --execute to write to ClickHouse",
      );
      return;
    }
    console.log("[activity-overview-availability-backfill] complete");
  } catch (error: unknown) {
    captureException(error);
    throw error;
  } finally {
    await client.close?.();
    await Sentry.close(2_000);
  }
}

const isDirectExecution =
  typeof process.argv[1] === "string" &&
  import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""));

if (isDirectExecution) {
  main().catch((error: unknown) => {
    console.error(`[activity-overview-availability-backfill] ${error}`);
    process.exit(1);
  });
}
