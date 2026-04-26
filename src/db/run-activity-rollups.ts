import { Client } from "pg";

const drainSql =
  "SELECT analytics.refresh_dirty_activity_training_summaries($1) AS refreshed_count";

const enqueueBackfillSql = `
WITH queued AS (
  INSERT INTO analytics.activity_rollup_dirty (activity_id, user_id, reason, marked_at)
  SELECT id, user_id, 'backfill', now()
  FROM fitness.v_activity
  ON CONFLICT (activity_id) DO UPDATE SET
    reason = EXCLUDED.reason,
    marked_at = EXCLUDED.marked_at
  RETURNING 1
)
SELECT COUNT(*)::int AS queued_count
FROM queued
`;

function usage(): string {
  return [
    "Usage: pnpm tsx src/db/run-activity-rollups.ts <command>",
    "",
    "Commands:",
    "  enqueue-backfill     Mark every canonical activity dirty for projection backfill",
    "  drain [batchSize]    Refresh dirty activity summaries in batches",
  ].join("\n");
}

function databaseUrlFromEnv(): string {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is required");
  }
  return databaseUrl;
}

function batchSizeFromArguments(): number {
  const batchSizeArgument = process.argv[3];
  if (!batchSizeArgument) {
    return 100;
  }

  const batchSize = Number.parseInt(batchSizeArgument, 10);
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
    throw new Error("Batch size must be an integer between 1 and 1000");
  }
  return batchSize;
}

export async function main(): Promise<void> {
  const command = process.argv[2];
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  if (command !== "drain" && command !== "enqueue-backfill") {
    throw new Error(`unknown command: ${command}\n${usage()}`);
  }

  const client = new Client({ connectionString: databaseUrlFromEnv() });
  try {
    await client.connect();
    if (command === "enqueue-backfill") {
      const result = await client.query<{ queued_count: number }>(enqueueBackfillSql);
      process.stdout.write(`queued=${result.rows[0]?.queued_count ?? 0}\n`);
      return;
    }

    const result = await client.query<{ refreshed_count: number }>(drainSql, [
      batchSizeFromArguments(),
    ]);
    process.stdout.write(`refreshed=${result.rows[0]?.refreshed_count ?? 0}\n`);
  } finally {
    await client.end();
  }
}

const isDirectRun =
  typeof process.argv[1] === "string" &&
  import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""));
if (isDirectRun) {
  main().catch((error) => {
    process.stderr.write(`${String(error)}\n`);
    process.exit(1);
  });
}
