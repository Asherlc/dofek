import * as Sentry from "@sentry/node";
import {
  backfillMissingBodyMeasurementSamples,
  countMissingBodyMeasurementSamples,
} from "../src/db/body-measurement-sample.ts";
import { createClickHouseClientFromEnv } from "../src/db/clickhouse.ts";
import { parsePostgresTimestamp } from "../src/db/clickhouse-migrations/sql.ts";
import { captureException } from "../src/lib/error-reporting.ts";

interface BodyMeasurementSampleBackfillOptions {
  start: Date;
  end: Date;
  execute: boolean;
}

function readOptionValue(
  args: readonly string[],
  argumentIndex: number,
  optionName: string,
): string {
  const value = args[argumentIndex + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${optionName} requires a value`);
  }
  return value;
}

export function parseBodyMeasurementSampleBackfillOptions(
  args: readonly string[],
): BodyMeasurementSampleBackfillOptions {
  let startValue: string | undefined;
  let endValue: string | undefined;
  let execute = false;

  for (let argumentIndex = 0; argumentIndex < args.length; argumentIndex += 1) {
    const argument = args[argumentIndex];
    switch (argument) {
      case "--start":
        startValue = readOptionValue(args, argumentIndex, "--start");
        argumentIndex += 1;
        break;
      case "--end":
        endValue = readOptionValue(args, argumentIndex, "--end");
        argumentIndex += 1;
        break;
      case "--execute":
        execute = true;
        break;
      case "--":
        break;
      default:
        throw new Error(`Unknown option: ${argument}`);
    }
  }

  if (!startValue) throw new Error("--start is required");
  if (!endValue) throw new Error("--end is required");

  const start = parsePostgresTimestamp(startValue, "--start");
  const end = parsePostgresTimestamp(endValue, "--end");
  if (start.getTime() >= end.getTime()) {
    throw new Error("--start must be before --end");
  }
  return { start, end, execute };
}

function initializeSentry(): void {
  const sentryDsn = process.env.SENTRY_DSN || process.env.SENTRY_DSN_unencrypted;
  if (sentryDsn) {
    Sentry.init({ dsn: sentryDsn, skipOpenTelemetrySetup: true });
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  initializeSentry();
  const options = parseBodyMeasurementSampleBackfillOptions(args);
  const client = createClickHouseClientFromEnv();

  try {
    const missingCount = options.execute
      ? await backfillMissingBodyMeasurementSamples(client, options)
      : await countMissingBodyMeasurementSamples(client, options);
    console.log(`[body-measurement-backfill] found ${missingCount} missing rows`);
    if (!options.execute) {
      console.log("[body-measurement-backfill] dry run only; add --execute to write to ClickHouse");
      return;
    }
    console.log("[body-measurement-backfill] complete");
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
    console.error(`[body-measurement-backfill] ${error}`);
    process.exit(1);
  });
}
