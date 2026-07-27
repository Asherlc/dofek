import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { sweepExpiredDatabaseBackups } from "../src/account-erasure/backup-retention.ts";
import { R2DatabaseBackupStorage } from "../src/account-erasure/database-backup-storage.ts";
import { createR2Client } from "../src/r2-storage.ts";

function readRequiredEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  key: string,
): string {
  const value = environment[key];
  if (!value) throw new Error(`${key} is required to sweep database backups`);
  return value;
}

function parsePositiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${option} must be a positive integer`);
  }
  return parsed;
}

async function runCommand(arguments_: readonly string[]): Promise<void> {
  const options = new Map<string, string>();
  for (let index = 0; index < arguments_.length; index += 2) {
    const key = arguments_[index];
    const value = arguments_[index + 1];
    if (!key || !value || !key.startsWith("--")) {
      throw new Error(
        "Usage: sweep-expired-r2-backups.ts --env-file <path> --bucket <name> --retention-days <days>",
      );
    }
    options.set(key, value);
  }
  const environmentPath = options.get("--env-file");
  const bucket = options.get("--bucket");
  const retentionDays = options.get("--retention-days");
  if (!environmentPath || !bucket || !retentionDays || options.size !== 3) {
    throw new Error(
      "Usage: sweep-expired-r2-backups.ts --env-file <path> --bucket <name> --retention-days <days>",
    );
  }
  const environment = parseEnv(readFileSync(environmentPath, "utf8"));
  const client = createR2Client({
    accessKeyId: readRequiredEnvironment(environment, "R2_ACCESS_KEY_ID"),
    endpoint: readRequiredEnvironment(environment, "R2_ENDPOINT"),
    secretAccessKey: readRequiredEnvironment(environment, "R2_SECRET_ACCESS_KEY"),
  });
  try {
    const result = await sweepExpiredDatabaseBackups(new R2DatabaseBackupStorage(client, bucket), {
      maxSweepPasses: 3,
      now: new Date(),
      retentionDays: parsePositiveInteger(retentionDays, "--retention-days"),
    });
    console.log(
      `Deleted and verified absence of ${result.deletedObjects} database backup object(s) beyond retention.`,
    );
  } finally {
    client.destroy();
  }
}

const commandPath = process.argv[1];
if (commandPath && import.meta.url === pathToFileURL(commandPath).href) {
  await runCommand(process.argv.slice(2));
}
