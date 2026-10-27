import { parseArgs } from "node:util";
import * as Sentry from "@sentry/node";
import { createDatabaseFromEnv } from "../src/db/index.ts";
import {
  backfillSleepQuality,
  type SleepQualityBackfillOptions,
} from "../src/db/sleep-quality-backfill.ts";
import { captureException } from "../src/lib/error-reporting.ts";

const MAXIMUM_WINDOW_MILLISECONDS = 31 * 24 * 60 * 60 * 1_000;

function parseUtcTimestamp(value: string, optionName: string): Date {
  if (!/(?:Z|[+-]\d{2}:?\d{2})$/.test(value)) {
    throw new Error(`${optionName} must include an explicit UTC time zone`);
  }
  if (!/(?:Z|\+00:?00)$/.test(value)) {
    throw new Error(`${optionName} must use UTC`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${optionName} must be a valid UTC timestamp`);
  }
  return parsed;
}

export function parseSleepQualityBackfillOptions(
  args: readonly string[],
): SleepQualityBackfillOptions {
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
  const options = parseSleepQualityBackfillOptions(args);

  initializeSentry();
  try {
    const db = createDatabaseFromEnv();
    try {
      const result = await backfillSleepQuality(db, options);
      console.log(
        `[sleep-quality-backfill] ${options.execute ? "updated" : "found"} ${result.rowsChanged} rows`,
      );
      console.log(
        `[sleep-quality-backfill] staging available=${result.stagingMarkedAvailable}, stage values cleared=${result.stageValuesCleared}, Apple efficiency cleared=${result.appleEfficiencyCleared}`,
      );
      if (!options.execute) {
        console.log("[sleep-quality-backfill] dry run only; add --execute to update Postgres");
      }
    } finally {
      await db.$client.end();
    }
  } catch (error: unknown) {
    captureException(error);
    throw error;
  } finally {
    await Sentry.close(2_000);
  }
}

const isDirectExecution =
  typeof process.argv[1] === "string" &&
  import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""));

if (isDirectExecution) {
  main().catch((error: unknown) => {
    console.error(`[sleep-quality-backfill] ${error}`);
    process.exit(1);
  });
}
