import { parseSinceDays } from "../cli.ts";
import { createDatabaseFromEnv } from "../db/index.ts";
import { runWithTokenUser } from "../db/token-user-context.ts";
import { logger } from "../logger.ts";
import { resolveCliUserId } from "./utils.ts";

export async function handleImportCommand(args: string[]): Promise<number> {
  const subcommand = args[3];

  if (subcommand === "apple-health") {
    const filePath = args[4];
    if (!filePath) {
      logger.error(
        "Usage: health-data import apple-health <path-to-export.zip|xml> [--full-sync] [--since-days=N]",
      );
      return 1;
    }

    const fullSync = args.includes("--full-sync");
    const days = parseSinceDays(args);
    const since = fullSync ? new Date(0) : new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const { importAppleHealthFile } = await import("../providers/apple-health/index.ts");
    const db = createDatabaseFromEnv();
    const userId = await resolveCliUserId(db);
    const result = await runWithTokenUser(userId, () => importAppleHealthFile(db, filePath, since));
    logger.info(
      `[import] Done: ${result.recordsSynced} records, ${result.errors.length} errors in ${result.duration}ms`,
    );
    if (result.errors.length > 0) {
      for (const err of result.errors) logger.error(`  - ${err.message}`);
    }
    return result.errors.length > 0 ? 1 : 0;
  }

  logger.error("Usage: health-data import <apple-health> <file>");
  return 1;
}
