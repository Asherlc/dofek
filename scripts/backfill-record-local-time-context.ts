import * as Sentry from "@sentry/node";
import { createDatabaseFromEnv } from "../src/db/index.ts";
import { backfillRecordLocalTimeContext } from "../src/db/record-local-time-context-backfill.ts";

function positiveIntegerOption(args: string[], name: string, defaultValue: number): number {
  const prefix = `--${name}=`;
  const argument = args.find((value) => value.startsWith(prefix));
  if (!argument) return defaultValue;
  const value = Number(argument.slice(prefix.length));
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`--${name} must be a positive integer`);
  }
  return value;
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const unknownArgument = args.find(
    (argument) =>
      argument !== "--execute" &&
      !argument.startsWith("--batch-size=") &&
      !argument.startsWith("--max-batches="),
  );
  if (unknownArgument) {
    throw new Error(`Unknown option: ${unknownArgument}`);
  }

  const options = {
    execute: args.includes("--execute"),
    batchSize: positiveIntegerOption(args, "batch-size", 250),
    maxBatches: positiveIntegerOption(args, "max-batches", 20),
  };
  const sentryDsn = process.env.SENTRY_DSN || process.env.SENTRY_DSN_unencrypted;
  if (sentryDsn) {
    Sentry.init({ dsn: sentryDsn, skipOpenTelemetrySetup: true });
  }

  try {
    const db = createDatabaseFromEnv();
    try {
      const result = await backfillRecordLocalTimeContext(db, options);
      console.log(
        `[record-local-time-backfill] eligible=${result.eligible} updated=${result.updated} skipped=${result.skipped}`,
      );
      if (!options.execute) {
        console.log("[record-local-time-backfill] dry run only; add --execute to update Postgres");
      }
    } finally {
      await db.$client.end();
    }
  } catch (error: unknown) {
    Sentry.captureException(error);
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
    console.error(`[record-local-time-backfill] ${error}`);
    process.exit(1);
  });
}
