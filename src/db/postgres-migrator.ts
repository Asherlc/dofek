import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DrizzleQueryError } from "drizzle-orm/errors";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Client } from "pg";
import { z } from "zod";

interface BaselineMigration {
  folderMillis: number;
  hash: string;
}

interface ImmutableMigration {
  file: string;
  hash: string;
}

interface MigrationHistoryEntry extends BaselineMigration, ImmutableMigration {
  statements: string[];
  tag: string;
}

interface AppliedMigration {
  contentHash: string | null;
  createdAt: number | null;
  hash: string;
}

const migrationJournalSchema = z.object({
  entries: z.array(
    z.object({
      tag: z.string(),
      when: z.number().int(),
    }),
  ),
});

const appliedMigrationRowsSchema = z.array(
  z.object({
    content_hash: z.string().nullable(),
    created_at: z.coerce.number().int().nullable(),
    hash: z.string(),
  }),
);

const transactionCompatibilityLegacyHashes = new Map<string, string>([
  [
    "0009_metric_stream_id_not_null_primary_key.sql",
    "83bed6b39519a9336b51a07f2d87d4ad9f5ba0b23e3733c38ac5fa0f77fdb137",
  ],
  [
    "0018_migrate_body_measurements_to_metric_stream.sql",
    "038e31f6303354edeaebe25d92981ee90e39743bc844f4692f1a75cbfadadb96",
  ],
  [
    "0021_convert_v_activity_to_view.sql",
    "02b69fee3ba566ecd2c18cb28d40ef7251c8afdb9ae4bcb0d7926cdf148354c2",
  ],
  [
    "0047_sync_log_user_provider_synced_at_index.sql",
    "8198fc0703dfb5d1c399fcc6ded55a4686af5a5bbfd832522829ffe1206bac0f",
  ],
  ["0048_mcp_oauth.sql", "40680a71ef18d7f5463b87ce5c89ccfe28f080a3501c0ebe5f192ff84996c1da"],
  [
    "0050_provider_data_deletion_outbox.sql",
    "b0d472bef25f06a80427d2e5b3aea18917ef4c85924580139d7c1a43c15bb3bc",
  ],
  [
    "0052_mcp_oauth_refresh_token_family.sql",
    "2b0da48caac478224d29ce5e3f76c467e3edc903834d4f148074c40e96f7f8e5",
  ],
  [
    "0053_file_upload_state_machine.sql",
    "65d3e9aa5f10924fabc77d1a47bc6dd225a58f7afbe3a9ae9179f3602c8a257f",
  ],
]);

function readMigrationHistory(migrationsFolder: string): MigrationHistoryEntry[] {
  const journal = migrationJournalSchema.parse(
    JSON.parse(readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8")),
  );

  let previousEntry: { tag: string; when: number } | undefined;
  for (const entry of journal.entries) {
    if (previousEntry && entry.when <= previousEntry.when) {
      throw new Error(
        `Migration journal timestamps must be strictly increasing: ${entry.tag} follows ${previousEntry.tag}`,
      );
    }
    previousEntry = entry;
  }

  const migrations = readMigrationFiles({ migrationsFolder });
  return journal.entries.map((entry, index) => {
    const migration = migrations[index];
    if (!migration) {
      throw new Error(`Drizzle journal entry has no SQL migration: ${entry.tag}`);
    }
    return {
      file: `${entry.tag}.sql`,
      folderMillis: migration.folderMillis,
      hash: migration.hash,
      statements: migration.sql,
      tag: entry.tag,
    };
  });
}

function addMigrationContext(error: unknown, migrationsFolder: string): never {
  if (!(error instanceof DrizzleQueryError)) {
    throw error;
  }

  const failedStatement = error.query.trim();
  const failedMigration = readMigrationHistory(migrationsFolder).find((migration) =>
    migration.statements.some((statement) => statement.trim() === failedStatement),
  );
  if (!failedMigration) {
    throw error;
  }

  const databaseError = error.cause ?? error;
  throw new Error(
    `Migration ${failedMigration.file} failed\n` +
      `Database error: ${databaseError.message}\n` +
      `Failed statement:\n${failedStatement}`,
    { cause: databaseError },
  );
}

function readArchivedMigrationHistory(migrationsFolder: string): ImmutableMigration[] {
  const historyFolder = join(migrationsFolder, "_history");
  if (!existsSync(historyFolder)) {
    return [];
  }

  return readdirSync(historyFolder)
    .filter((file) => file.endsWith(".sql"))
    .sort()
    .map((file) => ({
      file,
      hash: createHash("sha256")
        .update(readFileSync(join(historyFolder, file)))
        .digest("hex"),
    }));
}

export function readBaselineMigration(migrationsFolder: string): BaselineMigration | undefined {
  return readMigrationHistory(migrationsFolder).find((migration) =>
    /^\d+_baseline(?:_.*)?$/.test(migration.tag),
  );
}

function assertAppliedMigrationIntegrity(
  appliedMigrations: AppliedMigration[],
  migrationHistory: MigrationHistoryEntry[],
  archivedMigrationHistory: ImmutableMigration[],
): void {
  const immutableMigrations = [...migrationHistory, ...archivedMigrationHistory];
  const migrationsByFile = new Map(
    immutableMigrations.map((migration) => [migration.file, migration]),
  );
  const migrationsByHash = new Map(
    immutableMigrations.map((migration) => [migration.hash, migration]),
  );
  const migrationsByCreatedAt = new Map(
    migrationHistory.map((migration) => [migration.folderMillis, migration]),
  );

  for (const appliedMigration of appliedMigrations) {
    const legacyMigration = migrationsByFile.get(appliedMigration.hash);
    if (legacyMigration) {
      const acceptedLegacyHash = transactionCompatibilityLegacyHashes.get(legacyMigration.file);
      if (
        appliedMigration.contentHash &&
        appliedMigration.contentHash !== legacyMigration.hash &&
        appliedMigration.contentHash !== acceptedLegacyHash
      ) {
        throw new Error(
          `[migrate] Integrity check failed: ${legacyMigration.file} has changed: ` +
            `expected SHA-256 ${appliedMigration.contentHash}, actual SHA-256 ${legacyMigration.hash}. ` +
            "Applied migrations are immutable; restore the original file or add a new forward migration.",
        );
      }
      continue;
    }

    if (migrationsByHash.has(appliedMigration.hash)) {
      continue;
    }

    const migrationAtRecordedTime =
      appliedMigration.createdAt === null
        ? undefined
        : migrationsByCreatedAt.get(appliedMigration.createdAt);
    if (migrationAtRecordedTime) {
      throw new Error(
        `[migrate] Integrity check failed: ${migrationAtRecordedTime.file} has changed: ` +
          `expected SHA-256 ${appliedMigration.hash}, actual SHA-256 ${migrationAtRecordedTime.hash}. ` +
          "Applied migrations are immutable; restore the original file or add a new forward migration.",
      );
    }

    const migrationName = appliedMigration.hash.endsWith(".sql")
      ? appliedMigration.hash
      : `migration tracked at ${appliedMigration.createdAt ?? "an unknown time"}`;
    throw new Error(
      `[migrate] Integrity check failed: ${migrationName} is recorded as applied but is missing. ` +
        "Applied migrations are immutable; restore the original migration and journal entry before starting the service.",
    );
  }
}

async function reconcileLegacyMigrationHistory(
  client: Client,
  migrationsFolder: string,
): Promise<void> {
  const migrationHistory = readMigrationHistory(migrationsFolder);
  const archivedMigrationHistory = readArchivedMigrationHistory(migrationsFolder);
  await client.query(`ALTER TABLE drizzle.__drizzle_migrations
    ADD COLUMN IF NOT EXISTS content_hash TEXT`);
  const appliedResult = await client.query(
    `SELECT hash, created_at, content_hash
     FROM drizzle.__drizzle_migrations`,
  );
  const appliedMigrations = appliedMigrationRowsSchema.parse(appliedResult.rows).map((row) => ({
    contentHash: row.content_hash,
    createdAt: row.created_at,
    hash: row.hash,
  }));
  assertAppliedMigrationIntegrity(appliedMigrations, migrationHistory, archivedMigrationHistory);

  await client.query(
    `UPDATE drizzle.__drizzle_migrations AS applied
     SET hash = history.content_hash,
         created_at = history.created_at,
         content_hash = history.content_hash
     FROM unnest($1::text[], $2::text[], $3::bigint[])
       AS history(file_name, content_hash, created_at)
     WHERE applied.hash = history.file_name
        OR applied.hash = history.content_hash`,
    [
      migrationHistory.map((migration) => migration.file),
      migrationHistory.map((migration) => migration.hash),
      migrationHistory.map((migration) => migration.folderMillis),
    ],
  );

  await client.query(
    `UPDATE drizzle.__drizzle_migrations AS applied
     SET hash = history.content_hash,
         content_hash = history.content_hash
     FROM unnest($1::text[], $2::text[])
       AS history(file_name, content_hash)
     WHERE applied.hash = history.file_name
        OR applied.hash = history.content_hash`,
    [
      archivedMigrationHistory.map((migration) => migration.file),
      archivedMigrationHistory.map((migration) => migration.hash),
    ],
  );
}

export async function runDrizzleMigrations(
  client: Client,
  migrationsFolder: string,
): Promise<void> {
  await reconcileLegacyMigrationHistory(client, migrationsFolder);
  try {
    await migrate(drizzle(client), { migrationsFolder });
  } catch (error) {
    addMigrationContext(error, migrationsFolder);
  }
}
