import { persistClimbingLogEntries } from "../../db/climbing-log-sync.ts";
import type { SyncDatabase } from "../../db/index.ts";
import { ensureProvider } from "../../db/tokens.ts";
import type { ImportProvider, SyncResult } from "../types.ts";
import { parseMoonBoardExport } from "./parser.ts";

export class MoonBoardProvider implements ImportProvider {
  readonly id = "moonboard";
  readonly name = "MoonBoard (BoardLib export)";
  readonly importOnly = true as const;
  validate(): string | null {
    return null;
  }
}

export async function importMoonBoardExportFile(
  db: SyncDatabase,
  csvText: string,
  userId: string,
): Promise<SyncResult> {
  const startedAt = Date.now();
  const entries = parseMoonBoardExport(csvText);
  const result = await db.transaction(async (tx) => {
    await ensureProvider(tx, "moonboard", "MoonBoard (BoardLib export)", undefined, userId);
    return persistClimbingLogEntries(tx, { userId, providerId: "moonboard", entries });
  });
  return {
    provider: "moonboard",
    recordsSynced: result.recordsSynced,
    errors: [],
    duration: Date.now() - startedAt,
  };
}
