import { spawnSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { downloadLatestDatabaseBackup } from "./download-latest-database-backup.ts";

// Restores the newest production backup into a throwaway database in this workspace's Compose
// Postgres, writes one owner's forecast climb-days as JSON to stdout, then drops the database.
// Run with production secrets: infisical run --env=prod -- pnpm climbing:export-from-backup ...
const [ownerId, timezone, startDate, endDate] = z
  .tuple([z.uuid(), z.string().min(1), z.iso.date(), z.iso.date()])
  .parse(process.argv.slice(2));
const scratchDatabase = "climbing_backup_scratch";
const databaseUser = "health";

function psql(database: string, statement: string): void {
  const result = spawnSync(
    "pnpm",
    [
      "compose",
      "--",
      "exec",
      "-T",
      "db",
      "psql",
      "-U",
      databaseUser,
      "-d",
      database,
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      statement,
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  if (result.status !== 0) throw new Error(`psql failed: ${statement}`);
}

const baseUrl = new URL(z.string().min(1).parse(process.env.DATABASE_URL));
if (!["localhost", "127.0.0.1"].includes(baseUrl.hostname)) {
  throw new Error("DATABASE_URL must point at the local workspace database, not a remote host");
}
baseUrl.pathname = `/${scratchDatabase}`;

const directory = mkdtempSync(join(tmpdir(), "dofek-backup-"));
try {
  const dumpPath = await downloadLatestDatabaseBackup(directory);
  psql("postgres", `DROP DATABASE IF EXISTS ${scratchDatabase}`);
  psql("postgres", `CREATE DATABASE ${scratchDatabase}`);
  psql(scratchDatabase, "SELECT timescaledb_pre_restore()");
  const dumpDescriptor = openSync(dumpPath, "r");
  const restore = spawnSync(
    "pnpm",
    [
      "compose",
      "--",
      "exec",
      "-T",
      "db",
      "pg_restore",
      "-U",
      databaseUser,
      "-d",
      scratchDatabase,
      "--no-owner",
      "--no-privileges",
      "--exit-on-error",
    ],
    { stdio: [dumpDescriptor, "ignore", "inherit"] },
  );
  closeSync(dumpDescriptor);
  if (restore.status !== 0) throw new Error("pg_restore failed");
  psql(scratchDatabase, "SELECT timescaledb_post_restore()");
  const exportRun = spawnSync(
    "pnpm",
    [
      "tsx",
      "scripts/export-climbing-forecast-observations.ts",
      ownerId,
      timezone,
      startDate,
      endDate,
    ],
    {
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, DATABASE_URL: baseUrl.toString() },
    },
  );
  if (exportRun.status !== 0) throw new Error("climbing forecast export failed");
} finally {
  psql("postgres", `DROP DATABASE IF EXISTS ${scratchDatabase}`);
  rmSync(directory, { recursive: true, force: true });
}
