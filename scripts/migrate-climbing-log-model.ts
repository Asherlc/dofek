import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import * as Sentry from "@sentry/node";
import {
  type ClimbingLogConversionReport,
  climbingLogModelState,
  convertClimbingLogBatch,
  inspectClimbingLogConversion,
  validateClimbingLogConversion,
} from "../src/db/climbing-log-model-conversion.ts";
import { createDatabaseFromEnv } from "../src/db/index.ts";
import { runMigrations } from "../src/db/migrate.ts";
import { withMigrationPrefix } from "../src/db/migration-prefix.ts";
import { captureException } from "../src/lib/error-reporting.ts";

function printReport(report: ClimbingLogConversionReport) {
  console.log(JSON.stringify(report, null, 2));
  if (report.conflicts.length)
    throw new Error(
      "Climbing conversion has unresolved conflicts. Resolve the reported source evidence before proceeding.",
    );
}
export async function main(args = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: { "batch-size": { type: "string" } },
  });
  const command = positionals[0];
  if (
    positionals.length !== 1 ||
    !command ||
    !["inspect", "prepare", "convert", "validate", "finalize"].includes(command)
  )
    throw new Error("Use inspect, prepare, convert, validate, or finalize.");
  const batchSize = values["batch-size"] === undefined ? 100 : Number(values["batch-size"]);
  if (!Number.isSafeInteger(batchSize) || batchSize < 1)
    throw new Error("--batch-size must be a positive integer.");
  if (values["batch-size"] !== undefined && command !== "convert")
    throw new Error("--batch-size applies only to convert.");
  const db = createDatabaseFromEnv();
  try {
    const state = await climbingLogModelState(db);
    if (command === "inspect") {
      printReport(await inspectClimbingLogConversion(db));
      return;
    }
    if (command === "validate") {
      printReport(await validateClimbingLogConversion(db));
      return;
    }
    if (state.finalized) {
      console.log("Climbing log schema is already finalized.");
      return;
    }
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error("DATABASE_URL environment variable is required");
    const directory = resolve(import.meta.dirname, "../drizzle");
    if (command === "prepare") {
      printReport(await inspectClimbingLogConversion(db));
      await withMigrationPrefix(directory, 146, (prefix) => runMigrations(databaseUrl, prefix));
      console.log("Climbing conversion preparation complete.");
      return;
    }
    if (command === "convert") {
      let remaining: number;
      do {
        const batch = await convertClimbingLogBatch(db, batchSize);
        console.log(JSON.stringify(batch));
        remaining = batch.remaining;
      } while (remaining > 0);
      return;
    }
    printReport(await validateClimbingLogConversion(db));
    await runMigrations(databaseUrl, directory);
    console.log("Climbing log schema finalized. Resume only the matching application release.");
  } finally {
    await db.$client.end();
  }
}
const script = process.argv[1];
if (script && import.meta.url === pathToFileURL(resolve(script)).href) {
  const dsn = process.env.SENTRY_DSN || process.env.SENTRY_DSN_unencrypted;
  if (dsn) Sentry.init({ dsn, skipOpenTelemetrySetup: true });
  main()
    .catch(async (error: unknown) => {
      captureException(error);
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    })
    .finally(() => Sentry.close(2000));
}
