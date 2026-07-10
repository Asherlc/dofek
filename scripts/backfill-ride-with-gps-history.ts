import { pathToFileURL } from "node:url";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { createDatabaseFromEnv, type Database } from "../src/db/index.ts";
import { runWithTokenUser } from "../src/db/token-user-context.ts";
import { RideWithGpsProvider } from "../src/providers/ride-with-gps.ts";
import { SyncRun } from "../src/providers/sync-run.ts";
import { SyncWindow } from "../src/providers/sync-window.ts";

export interface RideWithGpsHistoryBackfillOptions {
  execute: boolean;
  userId?: string;
  since: Date;
  until: Date;
}

const userRowSchema = z.object({
  userId: z.string(),
  tokenCount: z.number(),
});

function parseDateArgument(value: string, name: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`${name} must be an ISO date or timestamp`);
  }
  const dateOnlyMatch = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/.exec(value);
  if (dateOnlyMatch?.groups) {
    const parsedYear = date.getUTCFullYear();
    const parsedMonth = date.getUTCMonth() + 1;
    const parsedDay = date.getUTCDate();
    if (
      parsedYear !== Number(dateOnlyMatch.groups.year) ||
      parsedMonth !== Number(dateOnlyMatch.groups.month) ||
      parsedDay !== Number(dateOnlyMatch.groups.day)
    ) {
      throw new Error(`${name} must be a valid calendar date`);
    }
  }
  return date;
}

function parseInclusiveEndDateArgument(value: string, name: string): Date {
  const date = parseDateArgument(value, name);
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return new Date(date.getTime() + 86_400_000 - 1);
  }
  return date;
}

function readOptionValue(args: string[], index: number, name: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}

export function parseRideWithGpsHistoryBackfillArgs(
  args: string[],
): RideWithGpsHistoryBackfillOptions {
  const options: RideWithGpsHistoryBackfillOptions = {
    execute: false,
    since: new Date(0),
    until: new Date(),
  };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--execute") {
      options.execute = true;
      continue;
    }
    if (arg === "--user-id") {
      options.userId = readOptionValue(args, index, arg);
      index++;
      continue;
    }
    if (arg === "--start") {
      options.since = parseDateArgument(readOptionValue(args, index, arg), arg);
      index++;
      continue;
    }
    if (arg === "--end") {
      options.until = parseInclusiveEndDateArgument(readOptionValue(args, index, arg), arg);
      index++;
      continue;
    }
    if (arg === "--help") {
      throw new Error(usage());
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (options.since > options.until) {
    throw new Error("--start date must be before or equal to --end date");
  }

  return options;
}

async function resolveUserId(db: Database, userId: string | undefined): Promise<string> {
  if (userId) return userId;

  const rows = z.array(userRowSchema).parse(
    await db.execute(sql`
      SELECT user_id::text AS "userId", count(*)::int AS "tokenCount"
      FROM fitness.oauth_token
      WHERE provider_id = 'ride-with-gps'
      GROUP BY user_id
      ORDER BY "tokenCount" DESC
    `),
  );

  if (rows.length === 1 && rows[0]) return rows[0].userId;

  throw new Error(
    `Expected exactly one RideWithGPS token user, found ${rows.length}. Pass --user-id explicitly.`,
  );
}

async function runBackfill(options: RideWithGpsHistoryBackfillOptions): Promise<void> {
  const db = createDatabaseFromEnv();
  const userId = await resolveUserId(db, options.userId);
  const window = new SyncWindow({ since: options.since, until: options.until });

  console.log(
    JSON.stringify(
      {
        mode: options.execute ? "execute" : "dry-run",
        userId,
        since: window.sinceIso,
        until: window.untilIso,
      },
      null,
      2,
    ),
  );

  if (!options.execute) return;

  const provider = new RideWithGpsProvider();
  const result = await runWithTokenUser(userId, () =>
    provider.sync(
      new SyncRun({
        db,
        window,
        userId,
      }),
    ),
  );

  console.log(JSON.stringify(result, null, 2));

  if (result.errors.length > 0) {
    const errorMessages = result.errors.map((error) => error.message).join("; ");
    throw new Error(
      `RideWithGPS backfill completed with ${result.errors.length} errors: ${errorMessages}`,
    );
  }
}

function usage(): string {
  return [
    "Usage: pnpm tsx scripts/backfill-ride-with-gps-history.ts [options]",
    "",
    "Options:",
    "  --execute        Run the provider sync. Without this, only prints resolved inputs.",
    "  --user-id ID     User id to backfill. Required when multiple RWGPS users exist.",
    "  --start DATE     Inclusive activity start timestamp. Defaults to Unix epoch.",
    "  --end DATE       Inclusive activity end timestamp. Defaults to now.",
  ].join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runBackfill(parseRideWithGpsHistoryBackfillArgs(process.argv.slice(2)))
    .then(() => process.exit(0))
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    });
}
