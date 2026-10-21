import { pathToFileURL } from "node:url";
import { z } from "zod";
import { createDatabaseFromEnv } from "../src/db/index.ts";
import {
  getActivityImageBackfillProgress,
  startActivityImageBackfill,
} from "../src/jobs/process-activity-image-backfill-job.ts";
import { captureException } from "../src/lib/error-reporting.ts";
export function parseActivityImageBackfillArgs(args: string[]): {
  userId: string;
  providerId?: string;
  status?: string;
} {
  const values: Record<string, string> = {};
  for (let position = 0; position < args.length; position += 2) {
    const flag = args[position],
      value = args[position + 1];
    if (
      !flag ||
      !["--user-id", "--provider-id", "--status"].includes(flag) ||
      !value ||
      values[flag]
    )
      throw Error("Expected --user-id <uuid> [--provider-id <id>] [--status <run-id>]");
    values[flag] = value;
  }
  return {
    userId: z.uuid().parse(values["--user-id"]),
    providerId: values["--provider-id"],
    status: values["--status"] ? z.uuid().parse(values["--status"]) : undefined,
  };
}
async function main() {
  const args = parseActivityImageBackfillArgs(process.argv.slice(2));
  const db = createDatabaseFromEnv();
  try {
    const result = args.status
      ? await getActivityImageBackfillProgress(db, args.userId, args.status)
      : await startActivityImageBackfill(db, args.userId, args.providerId);
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await db.$client.end();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error: unknown) => {
    captureException(error, { tags: { source: "activity-image-backfill" } });
    console.error(
      "Activity image backfill failed; verify owner, configuration and database access",
    );
    process.exitCode = 1;
  });
