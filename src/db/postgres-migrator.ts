import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import type { Client } from "pg";
import { z } from "zod";

interface BaselineMigration {
  folderMillis: number;
  hash: string;
}

interface MigrationHistoryEntry extends BaselineMigration {
  file: string;
  tag: string;
}

const migrationJournalSchema = z.object({
  entries: z.array(
    z.object({
      tag: z.string(),
      when: z.number().int(),
    }),
  ),
});

function readMigrationHistory(migrationsFolder: string): MigrationHistoryEntry[] {
  const journal = migrationJournalSchema.parse(
    JSON.parse(readFileSync(join(migrationsFolder, "meta/_journal.json"), "utf8")),
  );
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
      tag: entry.tag,
    };
  });
}

export function readBaselineMigration(migrationsFolder: string): BaselineMigration | undefined {
  return readMigrationHistory(migrationsFolder).find((migration) =>
    /^\d+_baseline(?:_.*)?$/.test(migration.tag),
  );
}

async function reconcileLegacyMigrationHistory(
  client: Client,
  migrationsFolder: string,
): Promise<void> {
  const migrationHistory = readMigrationHistory(migrationsFolder);
  await client.query(
    `UPDATE drizzle.__drizzle_migrations AS applied
     SET hash = history.content_hash,
         created_at = history.created_at
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
}

export async function runDrizzleMigrations(
  client: Client,
  migrationsFolder: string,
): Promise<void> {
  await reconcileLegacyMigrationHistory(client, migrationsFolder);
  await migrate(drizzle(client), { migrationsFolder });
}
