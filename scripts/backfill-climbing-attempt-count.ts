import * as Sentry from "@sentry/node";
import { backfillClimbingAttemptCount } from "../src/db/climbing-attempt-count-backfill.ts";
import { createDatabaseFromEnv } from "../src/db/index.ts";
import { captureException } from "../src/lib/error-reporting.ts";

function initializeSentry(): void {
  const sentryDsn = process.env.SENTRY_DSN || process.env.SENTRY_DSN_unencrypted;
  if (sentryDsn) {
    Sentry.init({ dsn: sentryDsn, skipOpenTelemetrySetup: true });
  }
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const unknownArguments = args.filter((argument) => argument !== "--execute");
  if (unknownArguments.length > 0) {
    throw new Error(`Unknown option: ${unknownArguments[0]}`);
  }

  const execute = args.includes("--execute");
  initializeSentry();
  try {
    const db = createDatabaseFromEnv();
    try {
      const count = await backfillClimbingAttemptCount(db, execute);
      console.log(
        `[climbing-attempt-count-backfill] ${execute ? "updated" : "found"} ${count} climbing entries`,
      );
      if (!execute) {
        console.log(
          "[climbing-attempt-count-backfill] dry run only; add --execute to update Postgres",
        );
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
    console.error(`[climbing-attempt-count-backfill] ${error}`);
    process.exit(1);
  });
}
