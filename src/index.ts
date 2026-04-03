import { handleAuthCommand } from "./commands/auth.ts";
import { handleImportCommand } from "./commands/import.ts";
import { handleSyncCommand } from "./commands/sync.ts";
import { logger } from "./logger.ts";

export async function main() {
  const command = process.argv[2] ?? "sync";

  if (command === "sync") {
    process.exit(await handleSyncCommand(process.argv));
  }

  if (command === "auth") {
    process.exit(await handleAuthCommand(process.argv));
  }

  if (command === "import") {
    process.exit(await handleImportCommand(process.argv));
  }

  logger.error(`Unknown command: ${command}\nUsage: health-data <sync|auth|import>`);
  process.exit(1);
}

if (process.env.NODE_ENV !== "test") {
  main();
}
