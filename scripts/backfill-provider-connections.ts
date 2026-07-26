import { pathToFileURL } from "node:url";
import { Client } from "pg";
import { z } from "zod";

const BATCH_SIZE = 500;
const ADVISORY_LOCK_NAME = "dofek.provider_connection_backfill";

const sourceTableRowSchema = z.object({ table_name: z.string() });
const connectionPairRowSchema = z.object({
  user_id: z.string().uuid(),
  provider_id: z.string().min(1),
});
const progressRowSchema = z.object({
  last_user_id: z.string().uuid().nullable(),
  last_provider_id: z.string().nullable(),
  rows_inserted: z.coerce.number().int().nonnegative(),
  completed_at: z.coerce.date().nullable(),
});
const missingCountRowSchema = z.object({ missing_count: z.coerce.number().int().nonnegative() });

interface QueryResult {
  rows: unknown[];
  rowCount: number | null;
}

interface BackfillClient {
  query(queryText: string, values?: unknown[]): Promise<QueryResult>;
}

interface ProviderConnectionSource {
  progressKey: string;
  tableName: string;
  providerIdColumn: string;
}

export interface ProviderConnectionBackfillResult {
  sourcesCompleted: number;
  connectionsInserted: number;
}

function quoteIdentifier(identifier: string): string {
  if (!/^[a-z][a-z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe SQL identifier: ${identifier}`);
  }
  return `"${identifier}"`;
}

async function discoverChildSources(client: BackfillClient): Promise<ProviderConnectionSource[]> {
  const result = await client.query(`
    SELECT columns.table_name
    FROM information_schema.columns
    INNER JOIN information_schema.tables
      ON tables.table_schema = columns.table_schema
      AND tables.table_name = columns.table_name
      AND tables.table_type = 'BASE TABLE'
    WHERE columns.table_schema = 'fitness'
      AND columns.column_name IN ('user_id', 'provider_id')
      AND columns.table_name NOT IN (
        'provider',
        'oauth_token',
        'provider_connection',
        'provider_connection_backfill_progress'
      )
    GROUP BY columns.table_name
    HAVING COUNT(DISTINCT columns.column_name) = 2
    ORDER BY columns.table_name
  `);

  return z
    .array(sourceTableRowSchema)
    .parse(result.rows)
    .map((row) => ({
      progressKey: row.table_name,
      tableName: row.table_name,
      providerIdColumn: "provider_id",
    }));
}

async function readProgress(
  client: BackfillClient,
  progressKey: string,
): Promise<z.infer<typeof progressRowSchema> | null> {
  const result = await client.query(
    `SELECT last_user_id, last_provider_id, rows_inserted, completed_at
     FROM fitness.provider_connection_backfill_progress
     WHERE source_table = $1`,
    [progressKey],
  );
  return result.rows[0] ? progressRowSchema.parse(result.rows[0]) : null;
}

function sourcePairQuery(source: ProviderConnectionSource): string {
  const tableName = quoteIdentifier(source.tableName);
  const providerIdColumn = quoteIdentifier(source.providerIdColumn);
  return `
    SELECT DISTINCT
      source.user_id::text AS user_id,
      source.${providerIdColumn}::text AS provider_id
    FROM fitness.${tableName} source
    WHERE source.user_id IS NOT NULL
      AND source.${providerIdColumn} IS NOT NULL
      AND (
        $1::text IS NULL
        OR (source.user_id::text, source.${providerIdColumn}::text) > ($1::text, $2::text)
      )
    ORDER BY user_id, provider_id
    LIMIT $3
  `;
}

function missingPairQuery(source: ProviderConnectionSource): string {
  const tableName = quoteIdentifier(source.tableName);
  const providerIdColumn = quoteIdentifier(source.providerIdColumn);
  return `
    SELECT COUNT(*)::text AS missing_count
    FROM (
      SELECT DISTINCT source.user_id, source.${providerIdColumn} AS provider_id
      FROM fitness.${tableName} source
      WHERE source.user_id IS NOT NULL
        AND source.${providerIdColumn} IS NOT NULL
    ) source_pairs
    LEFT JOIN fitness.provider_connection connection
      ON connection.user_id = source_pairs.user_id
      AND connection.provider_id = source_pairs.provider_id
    WHERE connection.user_id IS NULL
  `;
}

async function missingPairCount(
  client: BackfillClient,
  source: ProviderConnectionSource,
): Promise<number> {
  const result = await client.query(missingPairQuery(source));
  return missingCountRowSchema.parse(result.rows[0]).missing_count;
}

async function resetIncompleteProgress(
  client: BackfillClient,
  source: ProviderConnectionSource,
): Promise<z.infer<typeof progressRowSchema> | null> {
  const progress = await readProgress(client, source.progressKey);
  if (!progress?.completed_at) {
    return progress;
  }
  if ((await missingPairCount(client, source)) === 0) {
    return progress;
  }
  await client.query(
    `DELETE FROM fitness.provider_connection_backfill_progress WHERE source_table = $1`,
    [source.progressKey],
  );
  return null;
}

async function backfillSource(
  client: BackfillClient,
  source: ProviderConnectionSource,
): Promise<number> {
  const progress = await resetIncompleteProgress(client, source);
  if (progress?.completed_at) {
    return 0;
  }

  let lastUserId = progress?.last_user_id ?? null;
  let lastProviderId = progress?.last_provider_id ?? null;
  let totalInserted = progress?.rows_inserted ?? 0;
  let insertedThisRun = 0;

  while (true) {
    const pairResult = await client.query(sourcePairQuery(source), [
      lastUserId,
      lastProviderId,
      BATCH_SIZE,
    ]);
    const pairs = z.array(connectionPairRowSchema).parse(pairResult.rows);
    if (pairs.length === 0) {
      await client.query(
        `INSERT INTO fitness.provider_connection_backfill_progress (
           source_table, last_user_id, last_provider_id, rows_inserted, completed_at, updated_at
         ) VALUES ($1, $2, $3, $4, now(), now())
         ON CONFLICT (source_table) DO UPDATE SET
           last_user_id = EXCLUDED.last_user_id,
           last_provider_id = EXCLUDED.last_provider_id,
           rows_inserted = EXCLUDED.rows_inserted,
           completed_at = EXCLUDED.completed_at,
           updated_at = now()`,
        [source.progressKey, lastUserId, lastProviderId, totalInserted],
      );
      break;
    }

    const lastPair = pairs.at(-1);
    if (!lastPair) {
      throw new Error(
        `Provider connection backfill returned an empty batch for ${source.progressKey}`,
      );
    }

    await client.query("BEGIN");
    try {
      const insertResult = await client.query(
        `INSERT INTO fitness.provider_connection (user_id, provider_id)
         SELECT pair.user_id, pair.provider_id
         FROM unnest($1::uuid[], $2::text[]) AS pair(user_id, provider_id)
         INNER JOIN fitness.user_profile user_profile ON user_profile.id = pair.user_id
         INNER JOIN fitness.provider provider ON provider.id = pair.provider_id
         ON CONFLICT (user_id, provider_id) DO NOTHING`,
        [pairs.map((pair) => pair.user_id), pairs.map((pair) => pair.provider_id)],
      );
      const insertedCount = insertResult.rowCount ?? 0;
      totalInserted += insertedCount;
      insertedThisRun += insertedCount;
      lastUserId = lastPair.user_id;
      lastProviderId = lastPair.provider_id;

      await client.query(
        `INSERT INTO fitness.provider_connection_backfill_progress (
           source_table, last_user_id, last_provider_id, rows_inserted, completed_at, updated_at
         ) VALUES ($1, $2, $3, $4, NULL, now())
         ON CONFLICT (source_table) DO UPDATE SET
           last_user_id = EXCLUDED.last_user_id,
           last_provider_id = EXCLUDED.last_provider_id,
           rows_inserted = EXCLUDED.rows_inserted,
           completed_at = NULL,
           updated_at = now()`,
        [source.progressKey, lastUserId, lastProviderId, totalInserted],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }

  const missingCount = await missingPairCount(client, source);
  if (missingCount !== 0) {
    throw new Error(
      `Provider connection backfill validation failed for fitness.${source.tableName}: ${missingCount} pairs are missing`,
    );
  }
  return insertedThisRun;
}

async function enforceConnectionIntegrity(client: BackfillClient): Promise<void> {
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'oauth_token_provider_connection_fkey'
          AND conrelid = 'fitness.oauth_token'::regclass
      ) THEN
        ALTER TABLE fitness.oauth_token
        ADD CONSTRAINT oauth_token_provider_connection_fkey
        FOREIGN KEY (user_id, provider_id)
        REFERENCES fitness.provider_connection (user_id, provider_id)
        ON DELETE CASCADE
        NOT VALID;
      END IF;

      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'webhook_subscription_provider_connection_fkey'
          AND conrelid = 'fitness.webhook_subscription'::regclass
      ) THEN
        ALTER TABLE fitness.webhook_subscription
        ADD CONSTRAINT webhook_subscription_provider_connection_fkey
        FOREIGN KEY (user_id, provider_id)
        REFERENCES fitness.provider_connection (user_id, provider_id)
        ON DELETE CASCADE
        NOT VALID;
      END IF;
    END
    $$;
  `);
  await client.query(
    "ALTER TABLE fitness.oauth_token VALIDATE CONSTRAINT oauth_token_provider_connection_fkey",
  );
  await client.query(
    "ALTER TABLE fitness.webhook_subscription VALIDATE CONSTRAINT webhook_subscription_provider_connection_fkey",
  );
  await client.query("DROP INDEX IF EXISTS fitness.webhook_subscription_provider_id_idx");
}

export async function backfillProviderConnections(
  client: BackfillClient,
): Promise<ProviderConnectionBackfillResult> {
  await client.query("SELECT pg_advisory_lock(hashtext($1))", [ADVISORY_LOCK_NAME]);
  try {
    const sources: ProviderConnectionSource[] = [
      { progressKey: "provider.user_id", tableName: "provider", providerIdColumn: "id" },
      { progressKey: "oauth_token", tableName: "oauth_token", providerIdColumn: "provider_id" },
      ...(await discoverChildSources(client)),
    ];
    let connectionsInserted = 0;
    for (const source of sources) {
      connectionsInserted += await backfillSource(client, source);
    }
    await client.query("UPDATE fitness.provider SET user_id = NULL WHERE user_id IS NOT NULL");
    await enforceConnectionIntegrity(client);
    return { sourcesCompleted: sources.length, connectionsInserted };
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", [ADVISORY_LOCK_NAME]);
  }
}

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL environment variable is required");
  }

  const client = new Client({ connectionString });
  await client.connect();
  try {
    const result = await backfillProviderConnections(client);
    console.log(
      `Provider connection backfill complete: ${result.connectionsInserted} connections inserted across ${result.sourcesCompleted} sources.`,
    );
  } finally {
    await client.end();
  }
}

const scriptPath = process.argv[1];
if (scriptPath && import.meta.url === pathToFileURL(scriptPath).href) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
